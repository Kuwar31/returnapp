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

export const handleWebhook = async ({
  topic,
  shop,
  webhookId,
  payload,
}: WebhookContext): Promise<void> => {
  const log = logger.child({ topic, shop, webhookId });

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
