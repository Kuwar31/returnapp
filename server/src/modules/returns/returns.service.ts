import type { Prisma, ResolutionType, ReturnStatus } from "@prisma/client";
import { conflict, notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { displayConverter, forDisplay, toDecimal } from "../../lib/money.js";
import { logger } from "../../lib/logger.js";
import { notifyInBackground } from "../email/notifications.js";
import {
  issueShopifyGiftCard,
  issueShopifyStoreCredit,
  type CreditResult,
  type GiftCardResult,
} from "../shopify/credit.service.js";
import {
  closeShopifyReturn,
  ensureShopifyReturn,
  getSuggestedOutcome,
  processShopifyReturn,
  receiveShopifyReturn,
} from "../shopify/returns.service.js";
import {
  completeExchangeDraftOrder,
  ensureExchangeDraftOrder,
  sendExchangeInvoice,
} from "../shopify/exchange.service.js";
import { resolveDisplayMode, resolveExchangeMethod } from "../settings/merchant-settings.js";
import { generateCreditCode } from "./reference.js";
import { quoteReturn } from "../policy/quote.service.js";
import { assertTransition, STATUS_LABELS } from "./status.js";

const detailInclude = {
  // Carries the presentment rate every money field is converted with.
  order: true,
  lineItems: { include: { reason: true, orderLineItem: true } },
  exchangeItems: true,
  shipment: true,
  events: { orderBy: { createdAt: "asc" as const } },
  exchangeDraft: true,
  policy: true,
} satisfies Prisma.ReturnRequestInclude;

export const listReturns = async (
  merchantId: string,
  filters: {
    status?: ReturnStatus;
    search?: string;
    page: number;
    pageSize: number;
  },
) => {
  const where: Prisma.ReturnRequestWhereInput = {
    merchantId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search
      ? {
          OR: [
            { reference: { contains: filters.search, mode: "insensitive" } },
            { customerEmail: { contains: filters.search, mode: "insensitive" } },
            { customerName: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      // The order carries the presentment rate the list converts with.
      include: { lineItems: true, order: true },
      orderBy: { submittedAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  return { total, items, page: filters.page, pageSize: filters.pageSize };
};

/**
 * The customer's history with this store, for the sidebar.
 *
 * Real counts rather than a score: how much they buy and how much they send
 * back is the signal a merchant actually reasons about when deciding whether a
 * return smells wrong, and it needs no model behind it.
 */
export const getShopperStats = async (merchantId: string, email: string) => {
  const [orderCount, returnCount] = await Promise.all([
    prisma.order.count({
      where: { merchantId, email: { equals: email, mode: "insensitive" } },
    }),
    prisma.returnRequest.count({
      where: {
        merchantId,
        customerEmail: { equals: email, mode: "insensitive" },
      },
    }),
  ]);
  return { orderCount, returnCount };
};

export const getReturn = async (merchantId: string, id: string) => {
  const request = await prisma.returnRequest.findFirst({
    where: { id, merchantId },
    include: detailInclude,
  });
  if (!request) throw notFound("Return request not found.");
  return request;
};

/**
 * Single entry point for status changes: validates the transition, writes the
 * new status, and appends a timeline event in one transaction.
 */
export const changeStatus = async ({
  merchantId,
  id,
  to,
  actorId,
  message,
  extraData = {},
}: {
  merchantId: string;
  id: string;
  to: ReturnStatus;
  actorId?: string;
  message?: string;
  extraData?: Prisma.ReturnRequestUpdateInput;
}) => {
  const current = await getReturn(merchantId, id);
  assertTransition(current.status, to);

  return prisma.$transaction(async (tx) => {
    // Write the event before the final read, so the returned payload already
    // contains it — the admin UI renders this response directly.
    await tx.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId: actorId ?? null,
        type: "STATUS_CHANGED",
        message: message ?? `Status changed to ${STATUS_LABELS[to]}`,
        metadata: { from: current.status, to },
      },
    });

    return tx.returnRequest.update({
      where: { id },
      data: { status: to, ...extraData },
      include: detailInclude,
    });
  });
};

export const approveReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  await changeStatus({
    merchantId,
    id,
    to: "APPROVED",
    actorId,
    message: "Return approved",
    extraData: { reviewedAt: new Date(), reviewedBy: { connect: { id: actorId } } },
  });

  /**
   * Mirror the approval into Shopify so the return appears on the order.
   *
   * Deliberately non-fatal: the approval is already committed and the customer
   * has been emailed, so throwing here would leave our state and the merchant's
   * expectations at odds. The failure lands on the timeline to be retried.
   */
  await ensureShopifyReturn(merchantId, id);

  /**
   * Approval is when the exchange's draft order opens, and the reason it opens
   * this early is inventory: the reservation holds the replacement while the
   * returned parcel is in transit. Waiting until resolution would leave the
   * shopper's chosen size sellable for the whole journey back.
   *
   * A no-op under SHOPIFY_NATIVE, where ensureShopifyReturn above has already
   * put the replacement on the original order. The call stays unconditional so
   * there is one place that decides which mechanism runs.
   *
   * Also non-fatal — see ensureShopifyReturn above.
   */
  await ensureExchangeDraftOrder(merchantId, id);

  notifyInBackground(id, "APPROVED");
  return getReturn(merchantId, id);
};

export const rejectReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
  reason: string,
) => {
  const updated = await changeStatus({
    merchantId,
    id,
    to: "REJECTED",
    actorId,
    message: `Return declined: ${reason}`,
    extraData: {
      reviewedAt: new Date(),
      reviewedBy: { connect: { id: actorId } },
      rejectionReason: reason,
    },
  });
  notifyInBackground(id, "DECLINED");
  return updated;
};

/**
 * Records the merchant's inspection of one line, unit by unit.
 *
 * The whole point of tracking an accepted quantity separately from the
 * requested one is that a shopper who sends back six items doesn't force an
 * all-or-nothing decision: four can be accepted and two turned down, and every
 * downstream figure follows the four.
 *
 * Only editable up to the point money moves. Once resolved the customer has
 * already been paid against these numbers, and quietly changing them would put
 * our books and their bank statement at odds.
 */
export const inspectLineItem = async (
  merchantId: string,
  id: string,
  lineItemId: string,
  actorId: string,
  input: {
    acceptedQuantity?: number | null;
    restock?: boolean;
    rejectionNote?: string | null;
    keepItem?: boolean;
  },
) => {
  const request = await getReturn(merchantId, id);
  if (["RESOLVED", "CANCELLED", "REJECTED", "EXPIRED"].includes(request.status)) {
    throw conflict(
      "This return is closed, so its items can no longer be inspected.",
    );
  }

  const line = request.lineItems.find((li) => li.id === lineItemId);
  if (!line) throw notFound("That item isn't part of this return.");

  if (
    input.acceptedQuantity !== undefined &&
    input.acceptedQuantity !== null &&
    (input.acceptedQuantity < 0 || input.acceptedQuantity > line.quantity)
  ) {
    throw unprocessable(
      `You can accept between 0 and ${line.quantity} of "${line.orderLineItem?.title ?? "this item"}".`,
    );
  }

  await prisma.returnLineItem.update({
    where: { id: lineItemId },
    data: {
      ...(input.acceptedQuantity !== undefined
        ? { acceptedQuantity: input.acceptedQuantity }
        : {}),
      ...(input.restock !== undefined ? { restock: input.restock } : {}),
      ...(input.rejectionNote !== undefined
        ? { rejectionNote: input.rejectionNote }
        : {}),
      ...(input.keepItem !== undefined ? { keepItem: input.keepItem } : {}),
    },
  });

  // Totals are stored, not derived on read, so they have to be rewritten
  // whenever an accepted quantity changes — otherwise the refund button would
  // still offer the pre-inspection figure.
  await recalculateTotals(merchantId, id);

  if (input.acceptedQuantity !== undefined) {
    const accepted = input.acceptedQuantity;
    await prisma.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId,
        type: "ITEM_INSPECTED",
        message:
          accepted === null
            ? `Inspection cleared for "${line.orderLineItem?.title ?? "item"}"`
            : `Accepted ${accepted} of ${line.quantity} × "${line.orderLineItem?.title ?? "item"}"${
                accepted < line.quantity && input.rejectionNote
                  ? ` — ${input.rejectionNote}`
                  : ""
              }`,
      },
    });
  }

  return getReturn(merchantId, id);
};

/**
 * Rewrites the stored money figures from the current accepted quantities.
 *
 * Lines nobody has inspected yet count at their requested quantity, so the
 * totals before inspection match what the shopper was quoted.
 */
const recalculateTotals = async (merchantId: string, id: string) => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id, merchantId },
    include: { lineItems: { include: { exchangeItems: true } }, policy: true },
  });
  if (!request.policy) return;

  const quote = quoteReturn({
    policy: request.policy,
    lines: request.lineItems.map((li) => ({
      unitPrice: toDecimal(li.unitPrice),
      quantity: li.acceptedQuantity ?? li.quantity,
      resolution: li.resolution,
      exchangeValue: li.exchangeItems.reduce(
        (sum, ex) => sum.add(toDecimal(ex.unitPrice).mul(ex.quantity)),
        toDecimal(0),
      ),
    })),
  });

  await prisma.returnRequest.update({
    where: { id },
    data: {
      itemsSubtotal: quote.itemsSubtotal,
      bonusCredit: quote.bonusCredit,
      restockingFee: quote.restockingFee,
      estimatedTotal: quote.estimatedTotal,
    },
  });
};

export const markReceived = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  await changeStatus({
    merchantId,
    id,
    to: "RECEIVED",
    actorId,
    message: "Items received at the warehouse",
    extraData: { receivedAt: new Date() },
  });

  // Tell Shopify the goods are physically back and restock them. This has to
  // happen before any refund: Shopify tracks its own returned quantity and
  // won't refund against items it hasn't seen come back.
  try {
    await receiveShopifyReturn(merchantId, id);
  } catch (error) {
    logger.error({ merchantId, id, error }, "Could not dispose items in Shopify");
    await prisma.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId,
        type: "STATUS_CHANGED",
        message: `Shopify restock did not complete: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      },
    });
  }

  notifyInBackground(id, "RECEIVED");
  return getReturn(merchantId, id);
};

/**
 * Closes out a return: moves the money, then records it.
 *
 * For cash refunds the Shopify call happens *first* and a failure aborts the
 * whole resolution. Doing it the other way round meant a rejected refund still
 * marked the return RESOLVED and emailed the customer that their money was on
 * its way — the worst possible failure mode for a returns app.
 */
/**
 * How much of a return goes to each destination.
 *
 * Recomputed from the persisted lines rather than stored, so it stays in step
 * with the same quoting rules the shopper was shown. Without this, a mixed
 * return would credit or gift-card the *entire* value at each destination —
 * paying the customer several times over.
 */
const payoutSplit = async (merchantId: string, id: string) => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id, merchantId },
    include: { lineItems: { include: { exchangeItems: true } }, policy: true },
  });
  if (!request.policy) return new Map<ResolutionType, Prisma.Decimal>();

  const quote = quoteReturn({
    policy: request.policy,
    lines: request.lineItems.map((li) => ({
      unitPrice: toDecimal(li.unitPrice),
      // Pay for what was accepted. An uninspected line falls back to what the
      // shopper asked for, which is what they were quoted.
      quantity: li.acceptedQuantity ?? li.quantity,
      resolution: li.resolution,
      exchangeValue: li.exchangeItems.reduce(
        (sum, ex) => sum.add(toDecimal(ex.unitPrice).mul(ex.quantity)),
        toDecimal(0),
      ),
    })),
  });
  return quote.byResolution;
};

/**
 * Where the payout is destined, as a list the admin can render.
 *
 * A return can pay several ways at once now that resolution is per line —
 * refund one item, credit another, gift-card a third — so this is a breakdown
 * rather than a single destination.
 */
export const getPayoutBreakdown = async (merchantId: string, id: string) => {
  const [split, request, mode] = await Promise.all([
    payoutSplit(merchantId, id),
    getReturn(merchantId, id),
    resolveDisplayMode(merchantId),
  ]);
  /**
   * Converted like every other money field on this response.
   *
   * These are appended to the payload after serializeReturn rather than by it,
   * which is exactly how they got missed: the admin rendered them with the
   * detail's currency while the numbers themselves were still shop currency.
   */
  const fx = displayConverter(request.order, mode, request.currency);
  return [...split.entries()]
    .filter(([, amount]) => amount.greaterThan(0))
    .map(([resolution, amount]) => ({
      resolution,
      amount: fx.money(amount) ?? amount.toNumber(),
    }));
};

/**
 * Merchant-side cancellation.
 *
 * Distinct from rejecting: a rejection is a judgement the customer is told
 * about, a cancellation just withdraws the request — used when it was raised
 * in error or superseded.
 */
export const cancelReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
  reason?: string,
) => {
  const updated = await changeStatus({
    merchantId,
    id,
    to: "CANCELLED",
    actorId,
    message: reason ? `Return cancelled: ${reason}` : "Return cancelled",
  });
  return updated;
};

/**
 * Toggles the "needs a second look" flag.
 *
 * Deliberately not a status: flagging is a note between colleagues, and a
 * flagged return should keep moving through review like any other.
 */
export const flagReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
  reason?: string,
) => {
  const current = await getReturn(merchantId, id);
  const clearing = current.flaggedAt !== null;

  await prisma.returnRequest.update({
    where: { id },
    data: {
      flaggedAt: clearing ? null : new Date(),
      flagReason: clearing ? null : (reason ?? null),
    },
  });

  await prisma.returnEvent.create({
    data: {
      returnRequestId: id,
      actorId,
      type: "NOTE_ADDED",
      message: clearing
        ? "Flag cleared"
        : `Flagged for review${reason ? `: ${reason}` : ""}`,
    },
  });

  return getReturn(merchantId, id);
};

export const resolveReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  const current = await getReturn(merchantId, id);
  assertTransition(current.status, "RESOLVED");

  const split = await payoutSplit(merchantId, id);

  /**
   * A return can now pay out to several destinations at once — refund one item,
   * credit another, exchange a third — so each destination is driven by whether
   * *any* line chose it, not by a single resolution on the request.
   *
   * Under the draft-order method exchanges pay out through their own draft
   * rather than through a refund or a credit — see completeExchangeDraftOrder
   * below.
   */
  const resolutions = new Set(current.lineItems.map((li) => li.resolution));

  /**
   * A native exchange is only real once returnProcess commits it.
   *
   * Until then Shopify holds the replacement as an unreleased exchange item:
   * processedQuantity 0, no order line, nothing to fulfil. Closing the return
   * instead — which is what happens to every non-refund resolution — leaves it
   * in that state permanently, with the return marked closed and the shopper
   * waiting for goods no warehouse has been told to send.
   */
  const hasNativeExchange = current.exchangeItems.some(
    (item) => item.externalExchangeLineItemId,
  );

  const processed = resolutions.has("REFUND") || hasNativeExchange;
  if (processed) {
    // Throws on failure, leaving the return at RECEIVED so the merchant can
    // fix the cause and retry rather than silently under-paying a customer or
    // closing a return whose exchange never committed.
    await processShopifyReturn(merchantId, id);
  }

  /**
   * Store credit goes onto the customer's real Shopify store credit account, so
   * it is spendable at checkout. Like a refund this runs before the resolution
   * commits — a customer must never be told they have credit that isn't there.
   */
  let credit: CreditResult | null = null;
  if (resolutions.has("STORE_CREDIT")) {
    credit = await issueShopifyStoreCredit(
      merchantId,
      id,
      split.get("STORE_CREDIT"),
    );
  }

  /**
   * Gift cards are bearer value rather than an account balance, and the code is
   * returned exactly once by Shopify — so it is captured here and persisted
   * immediately, before anything else can fail and lose it.
   */
  let giftCard: GiftCardResult | null = null;
  if (resolutions.has("GIFT_CARD")) {
    giftCard = await issueShopifyGiftCard(merchantId, id, split.get("GIFT_CARD"));
  }

  /**
   * An exchange the return credit covers in full becomes a real order now that
   * the items are back. One with a balance stays a draft until the shopper pays
   * their invoice — completing it here would ship an upgrade for free.
   */
  if (resolutions.has("EXCHANGE") || resolutions.has("INSTANT_EXCHANGE")) {
    await completeExchangeDraftOrder(merchantId, id);
  }

  const refreshed = await getReturn(merchantId, id);
  // Prefer what Shopify actually paid; fall back to our estimate for store
  // credit and exchanges, where no cash moves.
  const amount = toDecimal(refreshed.settledTotal ?? current.estimatedTotal);

  // Issuing the credit and closing the return must succeed or fail together,
  // otherwise a resolved return could exist with no credit behind it.
  await prisma.$transaction(async (tx) => {
    await tx.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId,
        type: "STATUS_CHANGED",
        message: `Resolved as ${current.resolution.toLowerCase().replace(/_/g, " ")}`,
        metadata: { from: current.status, to: "RESOLVED" },
      },
    });

    if (giftCard) {
      await tx.storeCredit.create({
        data: {
          merchantId,
          returnRequestId: id,
          kind: "GIFT_CARD",
          // The real redeemable code — this is the only copy we will ever have.
          code: giftCard.code,
          externalAccountId: giftCard.giftCardId,
          customerEmail: current.customerEmail,
          amount: toDecimal(giftCard.amount),
          balance: toDecimal(giftCard.amount),
          currency: giftCard.currency,
          ...(giftCard.expiresOn
            ? { expiresAt: new Date(giftCard.expiresOn) }
            : {}),
        },
      });
      await tx.returnEvent.create({
        data: {
          returnRequestId: id,
          actorId,
          type: "CREDIT_ISSUED",
          message: `Gift card for ${giftCard.currency} ${giftCard.amount.toFixed(2)} issued${
            giftCard.maskedCode ? ` (${giftCard.maskedCode})` : ""
          }`,
          metadata: { giftCardId: giftCard.giftCardId },
        },
      });
    }

    if (current.resolution === "STORE_CREDIT") {
      // Mirrors the Shopify credit issued above. `code` stays populated for
      // continuity with credits created before Shopify accounts were used, but
      // the spendable balance now lives on the customer's Shopify account.
      await tx.storeCredit.create({
        data: {
          merchantId,
          returnRequestId: id,
          code: generateCreditCode(),
          externalAccountId: credit?.accountId ?? null,
          externalTransactionId: credit?.transactionId ?? null,
          customerEmail: current.customerEmail,
          amount,
          balance: amount,
          currency: credit?.currency ?? current.currency,
        },
      });
      await tx.returnEvent.create({
        data: {
          returnRequestId: id,
          actorId,
          type: "CREDIT_ISSUED",
          message: credit
            ? `Store credit of ${credit.currency} ${credit.amount.toFixed(2)} added to the customer's Shopify account` +
              (credit.balanceAfter !== null
                ? ` (balance now ${credit.currency} ${credit.balanceAfter.toFixed(2)})`
                : "")
            : `Store credit issued for ${current.currency} ${amount.toFixed(2)}`,
          metadata: credit ? { accountId: credit.accountId } : undefined,
        },
      });
    }

    return tx.returnRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), settledTotal: amount },
      include: detailInclude,
    });
  });

  /**
   * Store credit and draft-order exchanges are compensated outside the return,
   * so the Shopify return just needs closing — no refund to process. Leaving it
   * open would keep Shopify's own "Process and refund" button on the order,
   * from which a merchant could accidentally pay the customer twice.
   *
   * Skipped whenever returnProcess already ran: it closes the return itself,
   * and closing a second time would either error or, worse, close a return
   * whose exchange we had just committed.
   */
  if (!processed) {
    try {
      await closeShopifyReturn(merchantId, id);
    } catch (error) {
      logger.error({ merchantId, id, error }, "Could not close return in Shopify");
      await prisma.returnEvent.create({
        data: {
          returnRequestId: id,
          actorId,
          type: "STATUS_CHANGED",
          message: `Shopify close-out did not complete: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
      });
    }
  }

  // After the commit, so a store-credit email can read the code that was just
  // minted inside the transaction.
  notifyInBackground(id, "RESOLVED");

  return getReturn(merchantId, id);
};

/**
 * What resolving this return will actually pay out, according to Shopify.
 *
 * Falls back to our own estimate when Shopify can't be asked — before the
 * return has been mirrored, or for store credit and exchanges where no cash
 * moves and Shopify has no opinion.
 */
export const previewRefund = async (merchantId: string, id: string) => {
  const request = await getReturn(merchantId, id);

  const ourEstimate = toDecimal(request.estimatedTotal).toNumber();
  const base = {
    reference: request.reference,
    resolution: request.resolution,
    currency: request.currency,
    ourEstimate,
    alreadyRefunded: Boolean(request.externalRefundId),
    inShopify: Boolean(request.externalReturnId),
  };

  if (request.resolution !== "REFUND" || !request.externalReturnId) {
    return { ...base, shopifyRefund: null };
  }

  try {
    const outcome = await getSuggestedOutcome(merchantId, id);
    return {
      ...base,
      shopifyRefund: outcome
        ? { amount: outcome.totalRefund, currency: outcome.currency }
        : null,
    };
  } catch (error) {
    logger.warn({ merchantId, id, error }, "Could not preview refund");
    return { ...base, shopifyRefund: null };
  }
};

/**
 * One action for "the parcel arrived, pay the customer" — receives then
 * resolves, so a merchant never has to finish a return in Shopify's admin.
 *
 * Tolerates being called from either APPROVED or RECEIVED: the receive step is
 * skipped when it has already happened, which makes the button safe to retry.
 */
export const processAndRefund = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  const current = await getReturn(merchantId, id);

  if (current.status === "APPROVED" || current.status === "IN_TRANSIT") {
    await markReceived(merchantId, id, actorId);
  }

  const afterReceive = await getReturn(merchantId, id);
  if (afterReceive.status === "RECEIVED") {
    return resolveReturn(merchantId, id, actorId);
  }

  // Already resolved, or in a state where resolving makes no sense — let the
  // status machine produce the explanatory error rather than guessing.
  return resolveReturn(merchantId, id, actorId);
};

/**
 * Opens the exchange's draft order after the automatic attempt failed.
 *
 * The automatic one runs at approval, so a return approved while the app was
 * missing a scope — or while Shopify was down — has no draft and no way to get
 * one, since it can't be approved twice. This is that way.
 */
export const retryExchangeDraftOrder = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  const request = await getReturn(merchantId, id);
  if (request.exchangeItems.length === 0) {
    throw unprocessable("Nothing on this return is an exchange.");
  }
  if (request.exchangeDraft) {
    throw conflict("This exchange already has a draft order.");
  }
  // Say so plainly. ensureExchangeDraftOrder now no-ops under the native
  // method, and without this the merchant would be told Shopify refused —
  // sending them to look for an error that was never raised.
  if ((await resolveExchangeMethod(merchantId)) !== "DRAFT_ORDER") {
    throw unprocessable(
      "This store settles exchanges on the original order, so there's no draft order to create. Change the exchange method in settings if you want checkout links instead.",
    );
  }

  await ensureExchangeDraftOrder(merchantId, id);

  const refreshed = await getReturn(merchantId, id);
  if (!refreshed.exchangeDraft) {
    // ensureExchangeDraftOrder swallows failures onto the timeline by design,
    // so the absence of a draft is how we know it failed again.
    throw unprocessable(
      "Shopify wouldn't create the exchange order. Check the activity log for why.",
    );
  }

  await prisma.returnEvent.create({
    data: {
      returnRequestId: id,
      actorId,
      type: "NOTE_ADDED",
      message: "Exchange draft order created manually by the merchant",
    },
  });
  return refreshed;
};

/**
 * Re-sends the exchange invoice from the admin.
 *
 * Exists because the automatic send at approval can land in spam, or the
 * shopper can simply lose it, and the alternative is the merchant rebuilding
 * the exchange by hand in Shopify.
 */
export const resendExchangeInvoice = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  await sendExchangeInvoice(merchantId, id);
  await prisma.returnEvent.create({
    data: {
      returnRequestId: id,
      actorId,
      type: "NOTE_ADDED",
      message: "Exchange invoice re-sent by the merchant",
    },
  });
  return getReturn(merchantId, id);
};

export const addNote = async (
  merchantId: string,
  id: string,
  actorId: string,
  message: string,
) => {
  await getReturn(merchantId, id);
  return prisma.returnEvent.create({
    data: { returnRequestId: id, actorId, type: "NOTE_ADDED", message },
  });
};

const OPEN_STATUSES: ReturnStatus[] = [
  "SUBMITTED",
  "APPROVED",
  "IN_TRANSIT",
  "RECEIVED",
];

export const getDashboardStats = async (merchantId: string) => {
  const [byStatus, open, merchant] = await Promise.all([
    prisma.returnRequest.groupBy({
      by: ["status"],
      where: { merchantId },
      _count: { _all: true },
    }),
    /**
     * Fetched rather than SUMmed in SQL.
     *
     * Each order converts at its own rate, so a single aggregate can't be
     * converted afterwards — the sum would need one rate for figures that
     * came from several. Open returns are a small set by definition.
     */
    prisma.returnRequest.findMany({
      where: { merchantId, status: { in: OPEN_STATUSES } },
      select: { estimatedTotal: true, currency: true, order: true },
    }),
    prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { currency: true, displayCurrency: true },
    }),
  ]);

  const counts = Object.fromEntries(
    byStatus.map((row) => [row.status, row._count._all]),
  ) as Partial<Record<ReturnStatus, number>>;

  const mode = merchant?.displayCurrency ?? "SHOP";
  const shopCurrency = merchant?.currency ?? "USD";

  /**
   * Convert every row first, then decide whether the sum is meaningful.
   *
   * Orders that predate presentment capture degrade to shop currency while
   * their neighbours convert, and adding those together would produce a total
   * in no currency at all — labelled by whichever row happened to be last.
   * A mixed set falls back to shop currency for the whole figure, which is at
   * least a number the merchant can reconcile against their own books.
   */
  const converted = open.map((row) => ({
    display: forDisplay(toDecimal(row.estimatedTotal), row.order, mode, row.currency),
    shop: toDecimal(row.estimatedTotal).toNumber(),
  }));

  const targets = new Set(converted.map((c) => c.display.currency));
  const consistent = targets.size <= 1;
  const currency = consistent ? (targets.values().next().value ?? shopCurrency) : shopCurrency;
  const openValue = converted.reduce(
    (sum, c) => sum + (consistent ? (c.display.amount ?? 0) : c.shop),
    0,
  );

  return {
    counts: {
      submitted: counts.SUBMITTED ?? 0,
      approved: counts.APPROVED ?? 0,
      inTransit: counts.IN_TRANSIT ?? 0,
      received: counts.RECEIVED ?? 0,
      resolved: counts.RESOLVED ?? 0,
      rejected: counts.REJECTED ?? 0,
    },
    openValue: Math.round(openValue * 100) / 100,
    /** So the dashboard labels the figure rather than assuming a currency. */
    currency,
  };
};
