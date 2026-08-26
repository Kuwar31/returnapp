import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { queryShop } from "./shopify.client.js";
import { RETURN_EXCHANGE_STATE } from "./returns.graphql.js";
import { getSuggestedOutcome, processShopifyReturn } from "./returns.service.js";

/**
 * Diagnosing and settling exchanges that were closed without being netted.
 *
 * Returns resolved before the netting fix went in left Shopify in one of two
 * states, and they need different things:
 *
 *   UNCOMMITTED  the exchange line item exists with processedQuantity 0. The
 *                return was closed on top of it, so no replacement line was
 *                created and nothing was refunded. returnProcess can still
 *                commit it, which also settles the money.
 *
 *   UNSETTLED    the exchange was committed but no financial transfer went
 *                with it, so the replacement was added as a fresh charge and
 *                the returned item was never credited. The return is finished
 *                as far as Shopify is concerned, so the only way back is a
 *                direct refund — which needs the `orders` write scope this app
 *                deliberately doesn't hold, since every refund it makes by
 *                design goes through returnProcess under `write_returns`.
 *
 * The second case is therefore reported rather than fixed: the merchant is told
 * the exact amount and where to issue it. Escalating the app's permissions on
 * every store to repair a handful of historical orders is a worse trade than
 * one manual refund.
 */
export type ExchangeRepairState =
  | "NOT_APPLICABLE"
  | "HEALTHY"
  | "UNCOMMITTED"
  | "UNSETTLED";

export interface ExchangeRepairDiagnosis {
  state: ExchangeRepairState;
  /** Plain-language summary for the merchant. */
  summary: string;
  /** What the shopper is owed, when we can work it out. */
  refundOwed: { amount: number; currency: string } | null;
  /** True when runExchangeRepair can act without merchant involvement. */
  repairable: boolean;
  shopifyReturnName: string | null;
  orderOutstanding: { amount: number; currency: string } | null;
}

const money = (node: { amount: string; currencyCode: string } | undefined | null) =>
  node ? { amount: parseFloat(node.amount), currency: node.currencyCode } : null;

/**
 * Read-only. Safe to call whenever the admin renders a return, and the only
 * thing that decides whether the repair action is offered at all.
 */
export const diagnoseExchange = async (
  merchantId: string,
  returnRequestId: string,
): Promise<ExchangeRepairDiagnosis> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { exchangeItems: true },
  });

  const native = request.exchangeItems.filter(
    (item) => item.externalExchangeLineItemId,
  );
  if (!request.externalReturnId || native.length === 0) {
    return {
      state: "NOT_APPLICABLE",
      summary: "This return has no Shopify-native exchange.",
      refundOwed: null,
      repairable: false,
      shopifyReturnName: null,
      orderOutstanding: null,
    };
  }

  const data = await queryShop<{
    return: {
      name: string;
      status: string;
      exchangeLineItems: {
        nodes: Array<{
          id: string;
          quantity: number;
          processedQuantity: number;
          unprocessedQuantity: number;
          processableQuantity: number;
        }>;
      };
      order: {
        name: string;
        totalOutstandingSet: {
          presentmentMoney: { amount: string; currencyCode: string };
        } | null;
      } | null;
    } | null;
  }>(merchantId, RETURN_EXCHANGE_STATE, { id: request.externalReturnId });

  const remote = data.return;
  if (!remote) {
    return {
      state: "NOT_APPLICABLE",
      summary: "Shopify no longer has this return.",
      refundOwed: null,
      repairable: false,
      shopifyReturnName: null,
      orderOutstanding: null,
    };
  }

  const outstanding = money(remote.order?.totalOutstandingSet?.presentmentMoney);
  const uncommitted = remote.exchangeLineItems.nodes.filter(
    (n) => n.processedQuantity === 0 && n.processableQuantity > 0,
  );

  // What Shopify says is owed once it prices the return and the exchange
  // together. Null when the shopper owes money instead, which is not a fault.
  const outcome = await getSuggestedOutcome(merchantId, returnRequestId).catch(
    () => null,
  );
  const refundOwed = outcome
    ? { amount: outcome.totalRefund, currency: outcome.currency }
    : null;

  if (uncommitted.length > 0) {
    return {
      state: "UNCOMMITTED",
      summary:
        `${remote.name} was closed while its replacement was still uncommitted, so ` +
        `Shopify never created the exchange line or settled the money. Processing ` +
        `it now does both.`,
      refundOwed,
      repairable: true,
      shopifyReturnName: remote.name,
      orderOutstanding: outstanding,
    };
  }

  // Committed. If our own record shows no refund and the order still carries a
  // balance, the exchange went through without ever being netted.
  const settled = Boolean(request.externalRefundId);
  if (!settled && outstanding && outstanding.amount > 0) {
    return {
      state: "UNSETTLED",
      summary:
        `${remote.name} committed its exchange without netting it against the return, ` +
        `so the replacement was charged in full and the returned item was never ` +
        `credited. Shopify has finished with this return, so the balance has to be ` +
        `refunded from the order itself.`,
      refundOwed,
      repairable: false,
      shopifyReturnName: remote.name,
      orderOutstanding: outstanding,
    };
  }

  return {
    state: "HEALTHY",
    summary: `${remote.name} settled correctly.`,
    refundOwed: null,
    repairable: false,
    shopifyReturnName: remote.name,
    orderOutstanding: outstanding,
  };
};

/**
 * Commits a stranded exchange, netting it against the return.
 *
 * Deliberately delegates to processShopifyReturn rather than reimplementing the
 * call: that path already sends the exchange line items and the financial
 * transfer, and is guarded against refunding twice by our own refund id. A
 * repair that built its own mutation would be a second place for this logic to
 * drift.
 */
export const runExchangeRepair = async (
  merchantId: string,
  returnRequestId: string,
  actorId: string,
): Promise<ExchangeRepairDiagnosis> => {
  const before = await diagnoseExchange(merchantId, returnRequestId);
  if (!before.repairable) return before;

  logger.info(
    { merchantId, returnRequestId, state: before.state },
    "Repairing stranded exchange",
  );
  await processShopifyReturn(merchantId, returnRequestId);

  const after = await diagnoseExchange(merchantId, returnRequestId);
  await prisma.returnEvent.create({
    data: {
      returnRequestId,
      actorId,
      type: "STATUS_CHANGED",
      message:
        after.state === "HEALTHY"
          ? `Exchange settled in Shopify${
              before.refundOwed
                ? ` — ${before.refundOwed.currency} ${before.refundOwed.amount.toFixed(2)} refunded`
                : ""
            }`
          : `Exchange repair ran but Shopify still reports: ${after.summary}`,
    },
  });
  return after;
};
