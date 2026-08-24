import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { toDecimal } from "../../lib/money.js";
import { fetchVariantImages } from "./catalogue.service.js";
import { getShopCredentials, shopifyGraphQL } from "./shopify.client.js";
import {
  mapGraphQLOrder,
  type GraphQLOrderNode,
  type NormalizedOrder,
} from "./order.mapper.js";

/**
 * Writes a normalized order into Postgres.
 *
 * Line items are upserted on (orderId, externalId) and `returnedQuantity` is
 * deliberately never written here — it is our own bookkeeping, and an order
 * re-sync must not reset how much a customer has already sent back.
 */
export const upsertOrder = async (
  merchantId: string,
  order: NormalizedOrder,
): Promise<void> => {
  const defaultPolicy = await prisma.returnPolicy.findFirst({
    where: { merchantId, isDefault: true, active: true },
    select: { id: true },
  });

  const scalars = {
    orderNumber: order.orderNumber,
    // Guest checkouts have no customer, so never overwrite a known id with null.
    ...(order.customerExternalId
      ? { customerExternalId: order.customerExternalId }
      : {}),
    email: order.email,
    customerName: order.customerName,
    currency: order.currency,
    subtotal: toDecimal(order.subtotal),
    total: toDecimal(order.total),
    // Never regress to null: a payload without presentment data shouldn't erase
    // what an earlier sync already established.
    ...(order.presentmentCurrency
      ? { presentmentCurrency: order.presentmentCurrency }
      : {}),
    ...(order.presentmentTotal !== null
      ? { presentmentTotal: toDecimal(order.presentmentTotal) }
      : {}),
    placedAt: order.placedAt,
    shippingAddress: (order.shippingAddress ?? undefined) as never,
  };

  /**
   * Fulfillment dates are learned from whichever source saw them first — an
   * order payload or a fulfillments/* webhook. They must never regress to
   * null: `orders/updated` fires for unrelated edits (tags, notes, payment)
   * and its payload may carry no fulfillment data, which would otherwise
   * erase the dates the return window is measured from.
   */
  const dates = {
    ...(order.fulfilledAt ? { fulfilledAt: order.fulfilledAt } : {}),
    ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
  };

  await prisma.$transaction(async (tx) => {
    const record = await tx.order.upsert({
      where: {
        merchantId_externalId: { merchantId, externalId: order.externalId },
      },
      update: { ...scalars, ...dates },
      create: {
        merchantId,
        externalId: order.externalId,
        policyId: defaultPolicy?.id ?? null,
        ...scalars,
        ...dates,
      },
      select: { id: true },
    });

    for (const line of order.lineItems) {
      const lineScalars = {
        productId: line.productId,
        variantId: line.variantId,
        sku: line.sku,
        productType: line.productType,
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
        unitPrice: toDecimal(line.unitPrice),
        currency: line.currency,
      };

      await tx.orderLineItem.upsert({
        where: {
          orderId_externalId: {
            orderId: record.id,
            externalId: line.externalId,
          },
        },
        // Webhooks carry no image, so only overwrite it when we actually have
        // one — otherwise an order update would wipe images we fetched earlier.
        update: {
          ...lineScalars,
          ...(line.imageUrl ? { imageUrl: line.imageUrl } : {}),
        },
        create: {
          orderId: record.id,
          externalId: line.externalId,
          imageUrl: line.imageUrl,
          ...lineScalars,
        },
      });
    }
  });

  await backfillLineItemImages(merchantId, order.externalId);
};

/**
 * Fills in product images for an order's line items.
 *
 * Shopify's *webhook* payloads carry no image data at all, so an order that
 * arrives the normal way has none — and since the 90-day backfill only runs on
 * install or a manual re-sync, those orders would show grey placeholders in the
 * portal forever. One extra query per import fixes that at the source.
 *
 * Best-effort and idempotent: only lines that are still missing an image are
 * fetched, so a re-synced order costs nothing.
 */
export const backfillLineItemImages = async (
  merchantId: string,
  orderExternalId: string,
): Promise<number> => {
  const missing = await prisma.orderLineItem.findMany({
    where: {
      order: { merchantId, externalId: orderExternalId },
      imageUrl: null,
      variantId: { not: null },
    },
    select: { id: true, variantId: true },
  });
  if (missing.length === 0) return 0;

  const images = await fetchVariantImages(
    merchantId,
    missing.map((l) => l.variantId!),
  );
  if (images.size === 0) return 0;

  let updated = 0;
  for (const line of missing) {
    const url = images.get(line.variantId!);
    if (!url) continue;
    await prisma.orderLineItem.update({
      where: { id: line.id },
      data: { imageUrl: url },
    });
    updated++;
  }

  logger.debug({ merchantId, orderExternalId, updated }, "Line item images filled in");
  return updated;
};

const SYNC_ORDERS_QUERY = `#graphql
  query SyncOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        email
        processedAt
        currencyCode
        customer { id displayName }
        subtotalPriceSet { shopMoney { amount } }
        totalPriceSet {
          shopMoney { amount }
          presentmentMoney { amount currencyCode }
        }
        fulfillments(first: 10) { createdAt deliveredAt displayStatus }
        shippingAddress {
          name
          address1
          address2
          city
          provinceCode
          zip
          country
          phone
        }
        lineItems(first: 250) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            image { url }
            discountedUnitPriceSet { shopMoney { amount } }
            product { id productType }
            variant { id }
          }
        }
      }
    }
  }
`;

interface SyncOrdersResult {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GraphQLOrderNode[];
  };
}

/**
 * Pulls recent orders from Shopify into Postgres so the portal works for
 * customers who ordered before the app was installed.
 *
 * Only fulfilled orders inside the return window are worth importing — an
 * unfulfilled order has nothing returnable, and one older than the window
 * can't be actioned anyway.
 */
export const backfillOrders = async (
  merchantId: string,
  { days = 90, pageSize = 50, maxPages = 40 } = {},
): Promise<{ imported: number; skipped: number }> => {
  const { shop, accessToken } = await getShopCredentials(merchantId);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const searchQuery = `processed_at:>=${since} AND fulfillment_status:shipped`;

  let cursor: string | null = null;
  let imported = 0;
  let skipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const result: SyncOrdersResult = await shopifyGraphQL<SyncOrdersResult>(
      shop,
      accessToken,
      SYNC_ORDERS_QUERY,
      { first: pageSize, after: cursor, query: searchQuery },
    );

    for (const node of result.orders.nodes) {
      const normalized = mapGraphQLOrder(node);
      if (!normalized) {
        skipped++;
        continue;
      }
      try {
        await upsertOrder(merchantId, normalized);
        imported++;
      } catch (error) {
        skipped++;
        logger.error(
          { merchantId, orderId: node.id, error },
          "Failed to import order during backfill",
        );
      }
    }

    if (!result.orders.pageInfo.hasNextPage) break;
    cursor = result.orders.pageInfo.endCursor;
  }

  await prisma.integration.updateMany({
    where: { merchantId, provider: "SHOPIFY" },
    data: { lastSyncedAt: new Date() },
  });

  logger.info({ merchantId, imported, skipped }, "Backfill complete");
  return { imported, skipped };
};
