import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { toDecimal } from "../../lib/money.js";
import { queryShop } from "./shopify.client.js";
import {
  RETURN_CLOSE,
  RETURN_CREATE,
  RETURN_PROCESS,
  PRIMARY_LOCATION,
  RETURNABLE_FULFILLMENTS,
  REVERSE_FULFILLMENT_ORDER_DISPOSE,
  REVERSE_FULFILLMENT_ORDERS,
  SUGGESTED_FINANCIAL_OUTCOME,
  toShopifyReturnReason,
} from "./returns.graphql.js";

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

const throwOnUserErrors = (errors: UserError[], action: string): void => {
  if (errors.length === 0) return;
  throw new AppError(
    422,
    "SHOPIFY_RETURN_ERROR",
    `Shopify rejected the ${action}: ${errors.map((e) => e.message).join("; ")}`,
  );
};

/**
 * Maps each of an order's LineItem ids to the FulfillmentLineItem id and the
 * quantity Shopify still considers returnable.
 */
const resolveReturnableLineItems = async (
  merchantId: string,
  orderExternalId: string,
): Promise<Map<string, { fulfillmentLineItemId: string; quantity: number }>> => {
  const data = await queryShop<{
    returnableFulfillments: {
      nodes: Array<{
        returnableFulfillmentLineItems: {
          nodes: Array<{
            quantity: number;
            fulfillmentLineItem: { id: string; lineItem: { id: string } };
          }>;
        };
      }>;
    };
  }>(merchantId, RETURNABLE_FULFILLMENTS, { orderId: orderExternalId });

  const map = new Map<
    string,
    { fulfillmentLineItemId: string; quantity: number }
  >();

  for (const fulfillment of data.returnableFulfillments.nodes) {
    for (const node of fulfillment.returnableFulfillmentLineItems.nodes) {
      const lineItemId = node.fulfillmentLineItem.lineItem.id;
      const existing = map.get(lineItemId);
      // One line item can span several fulfillments (a split shipment); keep
      // the one with the most returnable units rather than the last seen.
      if (!existing || node.quantity > existing.quantity) {
        map.set(lineItemId, {
          fulfillmentLineItemId: node.fulfillmentLineItem.id,
          quantity: node.quantity,
        });
      }
    }
  }
  return map;
};

/**
 * Creates the Return on the Shopify order so it appears in the merchant's
 * admin, and records the ids we need to process it later.
 *
 * Called when a return is approved. Throws on failure so the caller can decide
 * whether to block approval — a return that exists only in our database is a
 * silent divergence from Shopify, which is worse than a visible error.
 */
/**
 * How many units of each order line Shopify still considers returnable, keyed
 * by LineItem id.
 *
 * Exposed for the portal so eligibility is decided against Shopify's own view
 * at lookup time, rather than only being checked at approval.
 */
export const getShopifyReturnableQuantities = async (
  merchantId: string,
  orderExternalId: string,
): Promise<Map<string, number>> => {
  const resolved = await resolveReturnableLineItems(merchantId, orderExternalId);
  return new Map(
    [...resolved.entries()].map(([lineItemId, v]) => [lineItemId, v.quantity]),
  );
};

/**
 * Creates the Shopify return if this request doesn't have one yet, swallowing
 * failures.
 *
 * Every path that can approve a return funnels through here — admin approval,
 * policy auto-approval, and processing a return approved before this code
 * existed — so there is exactly one place responsible for the mirror, and no
 * approval route can silently skip it.
 */
export const ensureShopifyReturn = async (
  merchantId: string,
  returnRequestId: string,
): Promise<string | null> => {
  try {
    return await createShopifyReturn(merchantId, returnRequestId);
  } catch (error) {
    logger.error(
      { merchantId, returnRequestId, error },
      "Could not create return in Shopify",
    );
    await prisma.returnEvent
      .create({
        data: {
          returnRequestId,
          type: "STATUS_CHANGED",
          message: `Not yet created in Shopify: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
      })
      .catch(() => undefined);
    return null;
  }
};

export const createShopifyReturn = async (
  merchantId: string,
  returnRequestId: string,
): Promise<string> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: {
      order: true,
      lineItems: { include: { reason: true, orderLineItem: true } },
      exchangeItems: true,
    },
  });

  if (request.externalReturnId) return request.externalReturnId;

  if (!request.order.externalId) {
    throw new AppError(
      409,
      "ORDER_NOT_SYNCED",
      "This order didn't come from Shopify, so no return can be created there.",
    );
  }

  const returnable = await resolveReturnableLineItems(
    merchantId,
    request.order.externalId,
  );

  const returnLineItems = [];
  // Our line-item id -> the FulfillmentLineItem id we resolved for it. Kept in
  // memory because the loop below writes to the database but doesn't refresh
  // the objects we're iterating.
  const fulfillmentLineItemByItemId = new Map<string, string>();

  for (const item of request.lineItems) {
    const externalLineItemId = item.orderLineItem?.externalId;
    const match = externalLineItemId ? returnable.get(externalLineItemId) : null;
    if (!match) {
      throw new AppError(
        409,
        "NOT_RETURNABLE_IN_SHOPIFY",
        `Shopify no longer lists "${item.orderLineItem?.title ?? "an item"}" as returnable. It may already have a return open.`,
      );
    }
    if (item.quantity > match.quantity) {
      throw new AppError(
        409,
        "QUANTITY_UNAVAILABLE",
        `Shopify only allows ${match.quantity} of "${item.orderLineItem?.title}" to be returned.`,
      );
    }

    returnLineItems.push({
      fulfillmentLineItemId: match.fulfillmentLineItemId,
      quantity: item.quantity,
      returnReason: toShopifyReturnReason(item.reason?.code ?? null),
      returnReasonNote: item.reasonNote ?? "",
    });

    fulfillmentLineItemByItemId.set(item.id, match.fulfillmentLineItemId);
    await prisma.returnLineItem.update({
      where: { id: item.id },
      data: { fulfillmentLineItemId: match.fulfillmentLineItemId },
    });
  }

  /**
   * Exchanges are deliberately NOT sent as `exchangeLineItems` here.
   *
   * They run through their own draft order (see exchange.service.ts) so the
   * replacement stock can be reserved at approval, which Shopify's native
   * exchange can't do — it only commits at returnProcess, days later. Passing
   * them here as well would give the shopper two replacements: one on this
   * return and one on the draft order.
   */
  const input: Record<string, unknown> = {
    orderId: request.order.externalId,
    returnLineItems,
    // Shopify emails the customer itself; we send our own branded messages, so
    // suppressing this avoids the shopper getting two notifications per event.
    notifyCustomer: false,
    requestedAt: request.submittedAt.toISOString(),
  };

  const data = await queryShop<{
    returnCreate: {
      return: {
        id: string;
        name: string;
        status: string;
        returnLineItems: {
          nodes: Array<{
            id: string;
            fulfillmentLineItem?: { id: string } | null;
          }>;
        };
      } | null;
      userErrors: UserError[];
    };
  }>(merchantId, RETURN_CREATE, { input });

  throwOnUserErrors(data.returnCreate.userErrors, "return");

  const created = data.returnCreate.return;
  if (!created) {
    throw new AppError(502, "SHOPIFY_RETURN_ERROR", "Shopify returned no return.");
  }

  await prisma.returnRequest.update({
    where: { id: request.id },
    data: { externalReturnId: created.id, externalStatus: created.status },
  });

  // Store the ReturnLineItem ids now — returnProcess addresses items by these,
  // and re-deriving them later would mean another round trip.
  const byFulfillmentLineItem = new Map(
    created.returnLineItems.nodes
      .filter((n) => n.fulfillmentLineItem)
      .map((n) => [n.fulfillmentLineItem!.id, n.id]),
  );
  for (const item of request.lineItems) {
    const flid = fulfillmentLineItemByItemId.get(item.id);
    const externalId = flid ? byFulfillmentLineItem.get(flid) : undefined;
    if (externalId) {
      await prisma.returnLineItem.update({
        where: { id: item.id },
        data: { externalReturnLineItemId: externalId },
      });
    }
  }

  await prisma.returnEvent.create({
    data: {
      returnRequestId: request.id,
      type: "STATUS_CHANGED",
      message: `Created in Shopify as ${created.name}`,
      metadata: { shopifyReturnId: created.id, status: created.status },
    },
  });

  logger.info(
    { merchantId, returnRequestId, shopifyReturnId: created.id },
    "Return created in Shopify",
  );
  return created.id;
};

/** Resolves the location returned stock should go back to. */
const resolveRestockLocation = async (
  merchantId: string,
  preferred?: string,
): Promise<string | undefined> => {
  if (preferred) return preferred;
  try {
    const data = await queryShop<{
      locations: {
        nodes: Array<{ id: string; isActive: boolean; fulfillsOnlineOrders: boolean }>;
      };
    }>(merchantId, PRIMARY_LOCATION);
    const active = data.locations.nodes.filter((l) => l.isActive);
    return active.find((l) => l.fulfillsOnlineOrders)?.id ?? active[0]?.id;
  } catch (error) {
    logger.warn({ merchantId, error }, "Could not resolve a restock location");
    return undefined;
  }
};

/** Reads back the ReverseFulfillmentOrderLineItems for a Shopify return. */
const reverseLineItems = async (
  merchantId: string,
  externalReturnId: string,
): Promise<Map<string, { id: string; quantity: number }>> => {
  const data = await queryShop<{
    return: {
      reverseFulfillmentOrders: {
        nodes: Array<{
          lineItems: {
            nodes: Array<{
              id: string;
              totalQuantity: number;
              fulfillmentLineItem: { id: string } | null;
            }>;
          };
        }>;
      };
    } | null;
  }>(merchantId, REVERSE_FULFILLMENT_ORDERS, { returnId: externalReturnId });

  const map = new Map<string, { id: string; quantity: number }>();
  for (const rfo of data.return?.reverseFulfillmentOrders.nodes ?? []) {
    for (const line of rfo.lineItems.nodes) {
      if (line.fulfillmentLineItem) {
        map.set(line.fulfillmentLineItem.id, {
          id: line.id,
          quantity: line.totalQuantity,
        });
      }
    }
  }
  return map;
};

/**
 * Records the returned items as received and restocks them.
 *
 * Must run before any refund: Shopify tracks a "returned quantity" that only
 * moves when items are disposed, and returnProcess refuses to refund more than
 * that. Called when a merchant marks a return received.
 */
export const receiveShopifyReturn = async (
  merchantId: string,
  returnRequestId: string,
  { locationId }: { locationId?: string } = {},
): Promise<void> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { lineItems: true },
  });
  if (!request.externalReturnId) return;

  const restockLocationId = await resolveRestockLocation(merchantId, locationId);
  if (!restockLocationId) {
    throw new AppError(
      409,
      "NO_LOCATION",
      "No active Shopify location to restock into.",
    );
  }

  const reverse = await reverseLineItems(merchantId, request.externalReturnId);

  /**
   * Disposition follows the merchant's inspection, unit by unit.
   *
   * `acceptedQuantity` is null until someone inspects the line, in which case
   * the whole requested quantity is taken — that keeps the untouched flow
   * behaving as it always did. Rejected units are deliberately left undisposed:
   * Shopify allows exactly one disposition per unit and it can't be revised, so
   * guessing wrong here is permanent. They stay for the merchant to handle.
   */
  const dispositionInputs = request.lineItems
    .map((item) => {
      const line = item.fulfillmentLineItemId
        ? reverse.get(item.fulfillmentLineItemId)
        : undefined;
      if (!line) return null;

      // A "keep" line never physically arrives, so there is nothing to
       // dispose — restocking it would invent inventory that doesn't exist.
      if (item.keepItem) return null;

      const accepted = item.acceptedQuantity ?? item.quantity;
      if (accepted <= 0) return null;

      return {
        reverseFulfillmentOrderLineItemId: line.id,
        quantity: Math.min(accepted, line.quantity),
        // An accepted item the merchant can't resell is still accepted — the
        // shopper is paid for it, it just doesn't go back on the shelf.
        dispositionType: item.restock ? "RESTOCKED" : "NOT_RESTOCKED",
        locationId: restockLocationId,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  if (dispositionInputs.length === 0) return;

  const data = await queryShop<{
    reverseFulfillmentOrderDispose: { userErrors: UserError[] };
  }>(merchantId, REVERSE_FULFILLMENT_ORDER_DISPOSE, { dispositionInputs });

  throwOnUserErrors(
    data.reverseFulfillmentOrderDispose.userErrors,
    "item disposition",
  );

  await prisma.returnEvent.create({
    data: {
      returnRequestId: request.id,
      type: "ITEM_INSPECTED",
      message: `Restocked ${dispositionInputs.reduce((n, d) => n + d.quantity, 0)} item(s) in Shopify`,
    },
  });

  logger.info({ merchantId, returnRequestId }, "Return items disposed in Shopify");
};

/**
 * Closes a Shopify return without any payout.
 *
 * Used for store credit and exchanges, where the customer is compensated
 * outside the return itself. returnProcess can't be used for this — with no
 * refund and no line items it rejects with "Process input cannot be empty" —
 * and leaving the return OPEN keeps Shopify offering its own
 * "Process and refund" button, which would pay the customer a second time.
 */
export const closeShopifyReturn = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
  });
  if (!request.externalReturnId) return;
  if (request.externalStatus === "CLOSED") return;

  const data = await queryShop<{
    returnClose: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(merchantId, RETURN_CLOSE, { id: request.externalReturnId });

  throwOnUserErrors(data.returnClose.userErrors, "return close");

  await prisma.returnRequest.update({
    where: { id: request.id },
    data: { externalStatus: data.returnClose.return?.status ?? "CLOSED" },
  });

  logger.info({ merchantId, returnRequestId }, "Return closed in Shopify");
};

export interface SuggestedOutcome {
  totalRefund: number;
  currency: string;
  transactions: Array<{
    parentTransactionId: string;
    amount: number;
    maximumRefundable: number;
    /**
     * The currency of *this transaction*, which is not necessarily the order's.
     * A shop selling in multiple markets charges in the shop currency while the
     * order records presentment currency, and Shopify rejects a refund whose
     * currency doesn't match the parent transaction.
     */
    currency: string;
    gateway: string | null;
  }>;
}

/**
 * Step 8 — asks Shopify what the refund should be. Read-only, so it is safe to
 * call before showing a merchant what will happen.
 */
export const getSuggestedOutcome = async (
  merchantId: string,
  returnRequestId: string,
): Promise<SuggestedOutcome | null> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { lineItems: true, exchangeItems: true },
  });
  if (!request.externalReturnId) return null;

  // Both argument lists are required by the schema, even when empty. Ask
  // Shopify to price the accepted units only, so a partially rejected return
  // is quoted at what we're actually going to pay.
  const returnLineItems = request.lineItems
    .filter((item) => item.externalReturnLineItemId)
    .map((item) => ({
      id: item.externalReturnLineItemId!,
      quantity: item.acceptedQuantity ?? item.quantity,
    }))
    .filter((item) => item.quantity > 0);
  if (returnLineItems.length === 0) return null;

  type Amount = { amount: string; currencyCode: string };
  type Money = { shopMoney: Amount; presentmentMoney?: Amount };
  const data = await queryShop<{
    return: {
      suggestedFinancialOutcome: {
        maximumRefundable: Money | null;
        financialTransfer: {
          __typename: string;
          amount?: Money;
          suggestedTransactions?: Array<{
            amountSet: Money;
            maximumRefundableSet: Money | null;
            parentTransaction: { id: string } | null;
            gateway: string | null;
          }>;
        } | null;
      } | null;
    } | null;
  }>(merchantId, SUGGESTED_FINANCIAL_OUTCOME, {
    returnId: request.externalReturnId,
    returnLineItems,
    exchangeLineItems: [],
    refundMethodAllocation: "ORIGINAL_PAYMENT_METHODS",
  });

  const outcome = data.return?.suggestedFinancialOutcome;
  const transfer = outcome?.financialTransfer;

  // An exchange that costs more than the return produces an InvoiceReturnOutcome
  // — the shopper owes money, so there is nothing to refund.
  if (!transfer || transfer.__typename !== "RefundReturnOutcome") return null;

  return {
    totalRefund: parseFloat(transfer.amount?.shopMoney.amount ?? "0"),
    currency:
      transfer.amount?.shopMoney.currencyCode ?? request.currency,
    transactions: (transfer.suggestedTransactions ?? [])
      .filter((t) => t.parentTransaction)
      .map((t) => {
        // Refund in the currency the customer was charged in. On a single
        // currency store these are identical; on a multi-currency store only
        // presentmentMoney matches the parent transaction.
        const pay = t.amountSet.presentmentMoney ?? t.amountSet.shopMoney;
        const max =
          t.maximumRefundableSet?.presentmentMoney ??
          t.maximumRefundableSet?.shopMoney;
        return {
          parentTransactionId: t.parentTransaction!.id,
          amount: parseFloat(pay.amount),
          maximumRefundable: max ? parseFloat(max.amount) : 0,
          currency: pay.currencyCode,
          gateway: t.gateway,
        };
      }),
  };
};

/**
 * Step 9 — issues the refund and closes out the return.
 *
 * Restocking already happened at receive time (see receiveShopifyReturn), so
 * this call only moves money. Store-credit and exchange resolutions skip the
 * cash refund entirely: the shopper is compensated by a credit code or a
 * replacement order, so refunding as well would pay them twice.
 */
export const processShopifyReturn = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  let request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { lineItems: true },
  });
  // A return approved before this integration existed — or one whose creation
  // failed earlier — still has no Shopify return. Create it now rather than
  // silently skipping the refund.
  if (!request.externalReturnId) {
    const created = await ensureShopifyReturn(merchantId, returnRequestId);
    if (!created) return;
    request = await prisma.returnRequest.findFirstOrThrow({
      where: { id: returnRequestId, merchantId },
      include: { lineItems: true },
    });
  }

  /**
   * Refunds are not idempotent on Shopify's side — every returnProcess call
   * with a financialTransfer issues another one, and Shopify will happily
   * refund the same return repeatedly. Our own record is the guard, so a retry,
   * a double click, or a re-run of resolution can never pay a customer twice.
   */
  if (request.externalRefundId) {
    logger.info(
      { merchantId, returnRequestId, refundId: request.externalRefundId },
      "Return already refunded in Shopify; skipping",
    );
    return;
  }

  const refundsCash = request.resolution === "REFUND";
  const outcome = refundsCash
    ? await getSuggestedOutcome(merchantId, returnRequestId)
    : null;

  /**
   * Deliberately sends no `returnLineItems`.
   *
   * Disposition already happened at receive time via receiveShopifyReturn.
   * Passing the line items here makes Shopify re-run its quantity check
   * against them and reject the call ("Quantity requested must be less than
   * or equal to the returned quantity"), even though the items are restocked.
   * Omitting them refunds the whole return, which is what resolving means.
   */
  const input: Record<string, unknown> = {
    returnId: request.externalReturnId,
    notifyCustomer: false,
  };

  if (outcome && outcome.transactions.length > 0) {
    // Cap each transaction at what Shopify says is still refundable, so a
    // partially refunded order can't push the total over the original charge.
    input.financialTransfer = {
      issueRefund: {
        orderTransactions: outcome.transactions.map((t) => ({
          parentId: t.parentTransactionId,
          transactionAmount: {
            amount: Math.min(t.amount, t.maximumRefundable).toFixed(2),
            // Per transaction, not per order — see SuggestedOutcome.currency.
            currencyCode: t.currency,
          },
        })),
      },
    };
  }

  const data = await queryShop<{
    returnProcess: {
      return: {
        id: string;
        status: string;
        refunds: { nodes: Array<{ id: string }> };
      } | null;
      userErrors: UserError[];
    };
  }>(merchantId, RETURN_PROCESS, { input });

  throwOnUserErrors(data.returnProcess.userErrors, "return processing");

  // Record the refund id immediately — it is what stops a second call from
  // issuing another refund.
  const refundId = data.returnProcess.return?.refunds.nodes.at(-1)?.id ?? null;
  if (refundId) {
    await prisma.returnRequest.update({
      where: { id: request.id },
      data: { externalRefundId: refundId },
    });
  }

  await prisma.returnRequest.update({
    where: { id: request.id },
    data: {
      externalStatus: data.returnProcess.return?.status ?? null,
      ...(outcome ? { settledTotal: toDecimal(outcome.totalRefund) } : {}),
    },
  });

  await prisma.returnEvent.create({
    data: {
      returnRequestId: request.id,
      type: refundsCash ? "REFUND_ISSUED" : "ITEM_INSPECTED",
      message: refundsCash
        ? `Refunded ${outcome?.currency ?? request.currency} ${(outcome?.totalRefund ?? 0).toFixed(2)} via Shopify`
        : "Items restocked in Shopify",
    },
  });

  /**
   * Close the return so Shopify stops treating it as outstanding.
   *
   * Without this the return sits at OPEN forever and Shopify keeps offering
   * its own "Process and refund" button on the order, inviting a merchant to
   * refund a second time from the other side.
   */
  try {
    const closed = await queryShop<{
      returnClose: {
        return: { id: string; status: string } | null;
        userErrors: UserError[];
      };
    }>(merchantId, RETURN_CLOSE, { id: request.externalReturnId });

    if (closed.returnClose.userErrors.length === 0) {
      await prisma.returnRequest.update({
        where: { id: request.id },
        data: { externalStatus: closed.returnClose.return?.status ?? "CLOSED" },
      });
    } else {
      logger.warn(
        { merchantId, returnRequestId, errors: closed.returnClose.userErrors },
        "Could not close the Shopify return",
      );
    }
  } catch (error) {
    // Non-fatal: the money has already moved, which is the part that matters.
    logger.warn({ merchantId, returnRequestId, error }, "returnClose failed");
  }

  logger.info(
    { merchantId, returnRequestId, refunded: outcome?.totalRefund ?? 0 },
    "Return processed in Shopify",
  );
};
