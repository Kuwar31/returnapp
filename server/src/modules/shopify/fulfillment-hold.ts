import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { queryShop } from "./shopify.client.js";

/**
 * Holds the replacement order for an exchange until the return is approved.
 *
 * A paid exchange arrives in Shopify as an ordinary unfulfilled order, so
 * without this it sits in the merchant's fulfilment queue looking ready to
 * ship — for a return nobody has reviewed yet, and whose items may never come
 * back. Shopify has a hold reason for exactly this case,
 * AWAITING_RETURN_ITEMS, which shows in the admin as "On hold" with the reason
 * attached rather than as a mystery.
 *
 * Every function here is best-effort. A hold is a courtesy on top of the
 * exchange, not part of settling it, so failing to place one must never fail
 * the payment or the approval it is attached to — the worst case is the order
 * the merchant can already see, in the state it was in before.
 */

const FULFILLMENT_ORDERS = `#graphql
  query ExchangeFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes { id status }
      }
    }
  }
`;

const HOLD = `#graphql
  mutation HoldExchange($id: ID!, $hold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

const RELEASE = `#graphql
  mutation ReleaseExchange($id: ID!) {
    fulfillmentOrderReleaseHold(id: $id) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

interface FulfillmentOrdersResult {
  order: {
    fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };
  } | null;
}

/** Statuses a hold can still be placed on. */
const HOLDABLE = ["OPEN", "SCHEDULED"];

const fulfillmentOrdersFor = async (
  merchantId: string,
  orderId: string,
): Promise<Array<{ id: string; status: string }>> => {
  const data = await queryShop<FulfillmentOrdersResult>(
    merchantId,
    FULFILLMENT_ORDERS,
    { id: orderId },
  );
  return data.order?.fulfillmentOrders.nodes ?? [];
};

/**
 * The Shopify order a return's exchange was fulfilled through, if it has one
 * yet. Only the draft-order route produces one; a native exchange puts the
 * replacement on the original order, which the merchant is already holding
 * against the return.
 */
const exchangeOrderIdFor = async (
  merchantId: string,
  returnRequestId: string,
): Promise<string | null> => {
  const draft = await prisma.exchangeDraftOrder.findFirst({
    where: { returnRequestId, returnRequest: { merchantId } },
    select: { externalOrderId: true },
  });
  return draft?.externalOrderId ?? null;
};

/**
 * Distinguishes "this store hasn't granted the fulfilment scopes" from a real
 * failure. The former is expected on every store connected before holds
 * existed, and shouldn't read as an error in the log every time someone pays.
 */
const isScopeError = (error: unknown): boolean =>
  error instanceof Error && /access denied|not approved|scope/i.test(error.message);

export const holdExchangeFulfillment = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  try {
    const orderId = await exchangeOrderIdFor(merchantId, returnRequestId);
    if (!orderId) return;

    const targets = (await fulfillmentOrdersFor(merchantId, orderId)).filter(
      (fo) => HOLDABLE.includes(fo.status),
    );
    if (targets.length === 0) return;

    for (const target of targets) {
      const result = await queryShop<{
        fulfillmentOrderHold: {
          fulfillmentOrder: { id: string; status: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(merchantId, HOLD, {
        id: target.id,
        hold: {
          reason: "AWAITING_RETURN_ITEMS",
          reasonNotes:
            "Waiting on the return to be approved and the items received.",
          // The merchant is the one who placed it, via approving or not
          // approving the return — telling them about it is noise.
          notifyMerchant: false,
        },
      });

      const errors = result.fulfillmentOrderHold.userErrors;
      if (errors.length > 0) {
        logger.warn(
          { merchantId, returnRequestId, errors },
          "Shopify refused to hold the exchange fulfilment",
        );
      }
    }

    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "STATUS_CHANGED",
        message: "Exchange order held in Shopify until the return is approved",
        metadata: { orderId },
      },
    });
  } catch (error) {
    logger[isScopeError(error) ? "info" : "warn"](
      { merchantId, returnRequestId, error: (error as Error).message },
      isScopeError(error)
        ? "Skipped the exchange hold — the store hasn't granted fulfilment scopes"
        : "Could not hold the exchange fulfilment",
    );
  }
};

export const releaseExchangeFulfillment = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  try {
    const orderId = await exchangeOrderIdFor(merchantId, returnRequestId);
    if (!orderId) return;

    const held = (await fulfillmentOrdersFor(merchantId, orderId)).filter(
      (fo) => fo.status === "ON_HOLD",
    );
    if (held.length === 0) return;

    for (const target of held) {
      const result = await queryShop<{
        fulfillmentOrderReleaseHold: {
          fulfillmentOrder: { id: string; status: string } | null;
          userErrors: Array<{ message: string }>;
        };
      }>(merchantId, RELEASE, { id: target.id });

      const errors = result.fulfillmentOrderReleaseHold.userErrors;
      if (errors.length > 0) {
        logger.warn(
          { merchantId, returnRequestId, errors },
          "Shopify refused to release the exchange hold",
        );
      }
    }

    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "STATUS_CHANGED",
        message: "Exchange order released for fulfilment in Shopify",
        metadata: { orderId },
      },
    });
  } catch (error) {
    logger[isScopeError(error) ? "info" : "warn"](
      { merchantId, returnRequestId, error: (error as Error).message },
      isScopeError(error)
        ? "Skipped releasing the exchange hold — no fulfilment scopes"
        : "Could not release the exchange fulfilment hold",
    );
  }
};
