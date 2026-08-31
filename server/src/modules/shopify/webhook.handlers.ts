import { Prisma } from "@prisma/client";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { mapWebhookOrder, type WebhookOrder } from "./order.mapper.js";
import { upsertOrder } from "./order.sync.js";

interface WebhookContext {
  topic: string;
  shop: string;
  webhookId?: string;
  payload: unknown;
}

/** Resolves the connected merchant for an incoming webhook's shop domain. */
const merchantFor = async (shop: string): Promise<string | null> => {
  const integration = await prisma.integration.findFirst({
    where: { provider: "SHOPIFY", externalShopId: shop, active: true },
    select: { merchantId: true },
  });
  return integration?.merchantId ?? null;
};

interface FulfillmentPayload {
  order_id: number;
  created_at?: string;
  updated_at?: string;
  status?: string | null;
  shipment_status?: string | null;
}

/**
 * Fulfillment webhooks carry no order body, so they patch the dates that drive
 * the return window rather than re-writing the whole order.
 */
const applyFulfillment = async (
  merchantId: string,
  payload: FulfillmentPayload,
): Promise<void> => {
  const externalId = `gid://shopify/Order/${payload.order_id}`;
  const order = await prisma.order.findFirst({
    where: { merchantId, externalId },
    select: { id: true, fulfilledAt: true },
  });
  if (!order) {
    logger.warn(
      { merchantId, externalId },
      "Fulfillment webhook for an order we haven't imported",
    );
    return;
  }

  const at = payload.created_at ? new Date(payload.created_at) : new Date();
  const deliveredAt =
    payload.shipment_status === "delivered"
      ? payload.updated_at
        ? new Date(payload.updated_at)
        : new Date()
      : undefined;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      // Keep the first fulfillment date — that's when the window starts.
      ...(order.fulfilledAt ? {} : { fulfilledAt: at }),
      ...(deliveredAt ? { deliveredAt } : {}),
    },
  });
};

/**
 * What a redacted record's email becomes.
 *
 * Not null: the column is required, and rows are looked up by email in several
 * places. A recognisable placeholder also makes it obvious in the admin that
 * the person asked to be forgotten, rather than looking like corrupt data.
 */
const REDACTED_EMAIL = "redacted@removed.invalid";

export const handleWebhook = async ({
  topic,
  shop,
  webhookId,
  payload,
}: WebhookContext): Promise<void> => {
  const log = logger.child({ topic, shop, webhookId });

  /**
   * Shopify's three mandatory compliance topics.
   *
   * Handled before the merchant lookup, because two of them are about erasing
   * a merchant that may already be gone — requiring a live integration to
   * answer them would fail exactly when they matter. Every App Store listing is
   * reviewed against these, and a non-2xx counts as a failure to comply.
   */
  if (topic === "shop/redact") {
    /**
     * Sent 48 hours after uninstall. Everything this app holds for a store
     * hangs off Merchant by cascade, so deleting the row removes the orders,
     * returns, credits and settings with it.
     */
    const shopDomain =
      (payload as { shop_domain?: string })?.shop_domain ?? shop;
    const deleted = await prisma.merchant.deleteMany({
      where: { domain: shopDomain },
    });
    log.info({ deleted: deleted.count }, "Shop data erased on request");
    return;
  }

  if (topic === "customers/redact") {
    /**
     * One customer's data, erased.
     *
     * Their returns are not deleted: a return is the merchant's own commercial
     * record of goods and money moving, and Shopify's guidance is to keep what
     * you must for legal and accounting reasons. What goes is everything that
     * identifies the person — name, email, address, free-text notes they wrote.
     */
    const body = payload as {
      shop_domain?: string;
      customer?: { email?: string };
    };
    const email = body.customer?.email;
    const target = await merchantFor(body.shop_domain ?? shop);
    if (!email || !target) {
      log.warn("Customer redaction with no email or no matching shop");
      return;
    }

    const [returns, orders] = await Promise.all([
      prisma.returnRequest.updateMany({
        where: { merchantId: target, customerEmail: { equals: email, mode: "insensitive" } },
        data: {
          customerEmail: REDACTED_EMAIL,
          customerName: null,
          customerNote: null,
        },
      }),
      prisma.order.updateMany({
        where: { merchantId: target, email: { equals: email, mode: "insensitive" } },
        data: { email: REDACTED_EMAIL, customerName: null, shippingAddress: Prisma.DbNull },
      }),
    ]);
    log.info(
      { returns: returns.count, orders: orders.count },
      "Customer personal data erased on request",
    );
    return;
  }

  if (topic === "customers/data_request") {
    /**
     * A request to hand a customer their data. Deliberately not fulfilled
     * automatically: Shopify requires the *merchant* to deliver it, and mailing
     * personal data from here on an unauthenticated webhook would be a leak
     * dressed up as compliance. Logged so the merchant can act on it.
     */
    const body = payload as { customer?: { email?: string } };
    log.info(
      { customerEmail: body.customer?.email },
      "Customer data request received — the merchant must fulfil this",
    );
    return;
  }

  if (topic === "app/uninstalled") {
    // The token is dead the moment the app is removed; don't keep using it.
    await prisma.integration.updateMany({
      where: { provider: "SHOPIFY", externalShopId: shop },
      data: { active: false, accessToken: null },
    });
    log.info("Store disconnected after uninstall");
    return;
  }

  const merchantId = await merchantFor(shop);
  if (!merchantId) {
    // Not an error: a webhook can arrive from a store that has been
    // disconnected. Acknowledge it so Shopify stops retrying.
    log.warn("Webhook for an unknown or disconnected shop");
    return;
  }

  switch (topic) {
    case "orders/create":
    case "orders/updated": {
      const normalized = mapWebhookOrder(payload as WebhookOrder);
      if (!normalized) {
        log.info("Skipped order webhook with no customer email");
        return;
      }
      await upsertOrder(merchantId, normalized);
      log.info({ orderNumber: normalized.orderNumber }, "Order synced");
      return;
    }

    case "fulfillments/create":
    case "fulfillments/update": {
      await applyFulfillment(merchantId, payload as FulfillmentPayload);
      log.info("Fulfillment applied");
      return;
    }

    default:
      log.debug("Ignoring unsubscribed topic");
  }
};
