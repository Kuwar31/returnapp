import { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  forDisplay,
  round2,
  toDecimal,
  ZERO,
  type OrderRateSource,
} from "../../lib/money.js";
import { quoteReturn } from "../policy/quote.service.js";
import { resolveExchangeMethod } from "../settings/merchant-settings.js";
import { queryShop } from "./shopify.client.js";
import { resolveCustomerId } from "./credit.service.js";
import { fetchVariantImages } from "./catalogue.service.js";
import { holdExchangeFulfillment } from "./fulfillment-hold.js";
import {
  DRAFT_ORDER_COMPLETE,
  DRAFT_ORDER_CREATE,
  DRAFT_ORDER_INVOICE_SEND,
  DRAFT_ORDER_STATE,
  DRAFT_ORDER_UPDATE,
  ORDER_PAYMENT_COLLECTION,
} from "./exchange.graphql.js";

interface UserError {
  field?: string[] | null;
  message: string;
}

const throwOnUserErrors = (errors: UserError[], action: string): void => {
  if (errors.length === 0) return;
  throw new AppError(
    422,
    "SHOPIFY_EXCHANGE_ERROR",
    `Shopify rejected the ${action}: ${errors.map((e) => e.message).join("; ")}`,
  );
};

/**
 * How long the replacement stock stays reserved.
 *
 * Long enough to cover the shopper posting the parcel back and the warehouse
 * booking it in, short enough that an abandoned exchange doesn't sit on stock
 * indefinitely. Shopify releases the reservation on its own at this point, so
 * an expired one degrades to "not reserved" rather than breaking the draft.
 */
const RESERVATION_DAYS = 21;

interface ExchangeTotals {
  /** Catalogue value of the replacement items. */
  itemsTotal: Prisma.Decimal;
  /** The returned items' value, applied to the draft as a discount. */
  creditApplied: Prisma.Decimal;
  /** What the shopper still owes. Zero for an even or trade-down exchange. */
  balanceDue: Prisma.Decimal;
  lineItems: Array<{ variantId: string; quantity: number }>;
}

/**
 * Prices the exchange using the same engine as the shopper's quote.
 *
 * Reusing `quoteReturn` rather than recomputing here is deliberate: bonus
 * credit, restocking and the per-line exchange maths already live there, and a
 * second implementation would drift from what the shopper was shown at
 * checkout — which is the number they'll hold us to.
 *
 * Exported because it touches no Shopify API, which makes it the safe way to
 * check what an exchange *would* cost before anything is created.
 */
export const priceExchange = async (
  merchantId: string,
  returnRequestId: string,
): Promise<ExchangeTotals | null> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { lineItems: { include: { exchangeItems: true } }, policy: true },
  });
  if (!request.policy) return null;

  const quote = quoteReturn({
    policy: request.policy,
    lines: request.lineItems.map((li) => ({
      unitPrice: toDecimal(li.unitPrice),
      quantity: li.quantity,
      resolution: li.resolution,
      exchangeValue: li.exchangeItems.reduce(
        (sum, ex) => sum.add(toDecimal(ex.unitPrice).mul(ex.quantity)),
        ZERO,
      ),
    })),
  });

  /**
   * `due` is what a line still owes after its own return credit is consumed,
   * so the credit the exchange absorbs is simply what it didn't leave owing.
   * Deriving it this way means the discount and the balance can never disagree.
   */
  const exchangeLines = quote.lines.filter((l) =>
    ["EXCHANGE", "INSTANT_EXCHANGE"].includes(l.resolution),
  );
  if (exchangeLines.length === 0) return null;

  const itemsTotal = round2(
    exchangeLines.reduce((sum, l) => sum.add(l.exchangeValue), ZERO),
  );
  const balanceDue = round2(
    exchangeLines.reduce((sum, l) => sum.add(l.due), ZERO),
  );
  const creditApplied = round2(itemsTotal.sub(balanceDue));

  const lineItems = request.lineItems
    .flatMap((li) => li.exchangeItems)
    .filter((ex) => ex.variantId)
    .map((ex) => ({ variantId: ex.variantId!, quantity: ex.quantity }));

  if (lineItems.length === 0) return null;

  return { itemsTotal, creditApplied, balanceDue, lineItems };
};

/**
 * The order's own shipping address, in the shape a draft order accepts.
 *
 * Reading both key styles on purpose: addresses stored from webhooks are
 * snake_case REST payloads, ones from the GraphQL sync are camelCase, and rows
 * of both shapes are already in the table.
 *
 * Returns null unless there is a real street address with a country code —
 * Shopify rejects a partial address outright, so half of one is worse than
 * none, and a draft without an address simply asks the shopper for theirs.
 */
const toShippingAddressInput = (
  stored: unknown,
): Record<string, string> | null => {
  if (!stored || typeof stored !== "object") return null;
  const a = stored as Record<string, unknown>;
  const str = (...keys: string[]): string | null => {
    for (const key of keys) {
      const found = a[key];
      if (typeof found === "string" && found.trim()) return found.trim();
    }
    return null;
  };

  const address1 = str("address1");
  const countryCode = str("countryCodeV2", "country_code", "countryCode");
  if (!address1 || !countryCode) return null;

  // A single `name` is all some payloads carry; Shopify wants it in two parts.
  const full = str("name");
  const [firstFromName, ...restOfName] = (full ?? "").split(" ");

  const input: Record<string, string> = { address1, countryCode };
  const optional: Record<string, string | null> = {
    address2: str("address2"),
    city: str("city"),
    company: str("company"),
    zip: str("zip", "postalCode", "postal_code"),
    provinceCode: str("provinceCode", "province_code"),
    firstName: str("firstName", "first_name") ?? (full ? firstFromName : null),
    lastName:
      str("lastName", "last_name") ??
      (restOfName.length > 0 ? restOfName.join(" ") : null),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) input[key] = value;
  }
  return input;
};

/** Builds the DraftOrderInput shared by create and update. */
const buildDraftInput = (
  totals: ExchangeTotals,
  opts: {
    customerId: string | null;
    email: string;
    reference: string;
    orderNumber: string;
    reserveUntil: Date | null;
    /** The order being returned against — supplies the presentment rate. */
    order: OrderRateSource;
    /** Where the original shipped, so the replacement follows it. */
    shippingAddress: Record<string, string> | null;
  },
): Record<string, unknown> => {
  const input: Record<string, unknown> = {
    lineItems: totals.lineItems.map((li) => ({
      variantId: li.variantId,
      quantity: li.quantity,
    })),
    email: opts.email,
    tags: ["exchange", `return:${opts.reference}`],
    note: `Exchange for return ${opts.reference} on order #${opts.orderNumber}`,
    // The shopper already paid shipping on the original order; charging again
    // for the replacement would make an even swap cost money.
    shippingLine: { title: "Exchange shipping", price: "0.00" },
  };

  // An unattached draft can't be paid from the customer's account, and the
  // merchant loses the link back to who is exchanging what.
  if (opts.customerId) {
    input.purchasingEntity = { customerId: opts.customerId };
  }

  if (opts.reserveUntil) {
    input.reserveInventoryUntil = opts.reserveUntil.toISOString();
  }

  /**
   * Bill the customer in the currency they originally paid in.
   *
   * This is what the shopper is actually charged, not a display preference —
   * invoicing someone in India in EUR because that's the shop's bookkeeping
   * currency is wrong however the dashboard is set.
   */
  const presentment = forDisplay(
    ZERO,
    opts.order,
    "PRESENTMENT",
    opts.order.currency,
  ).currency;
  if (presentment !== opts.order.currency) {
    input.presentmentCurrencyCode = presentment;
  }

  /**
   * The return credit is applied as a PERCENTAGE, not a fixed amount.
   *
   * This is the difference between a like-for-like exchange settling at zero
   * and it quietly asking for money. Shopify prices the replacement from
   * today's catalogue, converted at Shopify's own rate; our credit is the
   * historical price converted at the rate that order was charged at. Those
   * two numbers are close but never equal, so a fixed amount always leaves a
   * few rupees owing on a swap that should cost nothing.
   *
   * A percentage carries no units and no rate, so it can't drift: swapping an
   * item for one of equal value discounts 100% of it, whatever either side is
   * denominated in or when the catalogue last changed.
   *
   * Capped at 100 because a trade-down can't discount more than the goods are
   * worth — the surplus goes back through the return's own payout instead.
   */
  if (totals.creditApplied.greaterThan(0) && totals.itemsTotal.greaterThan(0)) {
    const pct = totals.creditApplied.div(totals.itemsTotal).mul(100);
    const capped = pct.greaterThan(100) ? toDecimal(100) : round2(pct);

    input.appliedDiscount = {
      valueType: "PERCENTAGE",
      value: Number(capped.toFixed(2)),
      title: "Return credit",
      description: `Credit from return ${opts.reference}`,
    };
  }

  /**
   * Ship the replacement where the original went.
   *
   * Setting it here does two things at once: the shopper doesn't retype an
   * address the store already holds, and Shopify locks the field at checkout —
   * "this order has pre-arranged shipping information". That lock is the point.
   * An exchange is a replacement for goods already sent, so it should not be a
   * way to have something delivered somewhere new.
   *
   * Omitted when the stored address is incomplete: Shopify rejects a partial
   * one, and a draft without an address just asks the shopper for theirs.
   */
  if (opts.shippingAddress) {
    input.shippingAddress = opts.shippingAddress;
  }

  /**
   * Traceability, so a draft order can be tied back to its return from inside
   * Shopify alone — a merchant looking at an unexplained draft shouldn't have
   * to come here to find out what it is.
   */
  input.customAttributes = [
    { key: "Return", value: opts.reference },
    { key: "Order", value: `#${opts.orderNumber}` },
  ];
  input.metafields = [
    {
      namespace: "custom",
      key: "original_return_reference",
      type: "single_line_text_field",
      value: opts.reference,
    },
  ];

  return input;
};

interface DraftOrderNode {
  id: string;
  name?: string | null;
  status?: string | null;
  invoiceUrl?: string | null;
  totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
}

/**
 * Creates the exchange's draft order, reserving the replacement stock.
 *
 * Called at approval. Non-fatal by design — the approval is already committed
 * and the shopper emailed, so a Shopify outage must not roll that back. The
 * failure lands on the return's timeline for the merchant to retry.
 */
export const ensureExchangeDraftOrder = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  /**
   * The two mechanisms are mutually exclusive.
   *
   * Under SHOPIFY_NATIVE the replacement is already on the original order,
   * placed there by returnCreate. Opening a draft as well would reserve the
   * stock twice and send the shopper a checkout link for goods they are also
   * being sent natively.
   */
  if ((await resolveExchangeMethod(merchantId)) !== "DRAFT_ORDER") return;

  const existing = await prisma.exchangeDraftOrder.findUnique({
    where: { returnRequestId },
  });
  // Drafts are not idempotent on Shopify's side: a second call opens a second
  // draft, reserving the stock twice and inviting the shopper to pay twice.
  if (existing) {
    logger.info(
      { merchantId, returnRequestId, draftOrderId: existing.externalId },
      "Exchange draft order already exists; skipping",
    );
    return;
  }

  try {
    const request = await prisma.returnRequest.findFirstOrThrow({
      where: { id: returnRequestId, merchantId },
      include: { order: true },
    });

    const totals = await priceExchange(merchantId, returnRequestId);
    if (!totals) return; // Nothing on this return is an exchange.

    const customerId = await resolveCustomerId(
      merchantId,
      request.orderId,
      request.customerEmail,
    );

    const reserveUntil = new Date(
      Date.now() + RESERVATION_DAYS * 24 * 60 * 60 * 1000,
    );

    /** The same figures as the draft carries, for our own record. */
    const billed = {
      currency: forDisplay(ZERO, request.order, "PRESENTMENT", request.currency)
        .currency,
      itemsTotal:
        forDisplay(totals.itemsTotal, request.order, "PRESENTMENT", request.currency)
          .amount ?? 0,
      creditApplied:
        forDisplay(totals.creditApplied, request.order, "PRESENTMENT", request.currency)
          .amount ?? 0,
      balanceDue:
        forDisplay(totals.balanceDue, request.order, "PRESENTMENT", request.currency)
          .amount ?? 0,
    };

    const input = buildDraftInput(totals, {
      customerId,
      email: request.customerEmail,
      reference: request.reference,
      orderNumber: request.order.orderNumber,
      reserveUntil,
      order: request.order,
      shippingAddress: toShippingAddressInput(request.order.shippingAddress),
    });

    const data = await queryShop<{
      draftOrderCreate: {
        draftOrder: DraftOrderNode | null;
        userErrors: UserError[];
      };
    }>(merchantId, DRAFT_ORDER_CREATE, { input });

    throwOnUserErrors(data.draftOrderCreate.userErrors, "exchange draft order");

    const draft = data.draftOrderCreate.draftOrder;
    if (!draft) {
      throw new AppError(
        502,
        "SHOPIFY_EXCHANGE_ERROR",
        "Shopify returned no draft order.",
      );
    }

    await prisma.exchangeDraftOrder.create({
      data: {
        returnRequestId,
        externalId: draft.id,
        name: draft.name ?? null,
        invoiceUrl: draft.invoiceUrl ?? null,
        status: "OPEN",
        /**
         * Stored in the currency the customer is billed in, so the admin panel
         * and Shopify's invoice can't disagree about the balance.
         */
        currency: billed.currency,
        itemsTotal: toDecimal(billed.itemsTotal),
        creditApplied: toDecimal(billed.creditApplied),
        balanceDue: toDecimal(billed.balanceDue),
        reservedUntil: reserveUntil,
      },
    });

    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "EXCHANGE_SHIPPED",
        message: totals.balanceDue.greaterThan(0)
          ? `Exchange draft order ${draft.name ?? draft.id} created — ${request.currency} ${totals.balanceDue.toFixed(2)} due from the customer`
          : `Exchange draft order ${draft.name ?? draft.id} created — nothing to pay`,
        metadata: { draftOrderId: draft.id, invoiceUrl: draft.invoiceUrl },
      },
    });

    // Ask for the money while the parcel is still in transit, so the
    // replacement can ship the moment the return is booked in.
    if (totals.balanceDue.greaterThan(0)) {
      await sendExchangeInvoice(merchantId, returnRequestId);
    }
  } catch (error) {
    logger.error(
      { err: error, merchantId, returnRequestId },
      "Failed to create exchange draft order",
    );
    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "NOTE_ADDED",
        message: `Couldn't create the exchange draft order in Shopify: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      },
    });
  }
};

/**
 * Re-syncs the draft after the exchange changes.
 *
 * Refuses once the draft is paid: the shopper owns that order, and silently
 * swapping what they bought is not ours to do.
 */
export const syncExchangeDraftOrder = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  const draft = await prisma.exchangeDraftOrder.findUnique({
    where: { returnRequestId },
  });
  if (!draft) return;
  if (draft.status === "COMPLETED" || draft.status === "CANCELLED") {
    throw new AppError(
      409,
      "EXCHANGE_ALREADY_COMPLETE",
      "This exchange has already been completed and can no longer be changed.",
    );
  }

  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { order: true },
  });

  const totals = await priceExchange(merchantId, returnRequestId);
  if (!totals) return;

  const customerId = await resolveCustomerId(
    merchantId,
    request.orderId,
    request.customerEmail,
  );

  const input = buildDraftInput(totals, {
    customerId,
    email: request.customerEmail,
    reference: request.reference,
    orderNumber: request.order.orderNumber,
    // Reservation is set at creation; re-sending it here would silently extend
    // the hold every time the merchant edits the exchange.
    reserveUntil: null,
    order: request.order,
    shippingAddress: toShippingAddressInput(request.order.shippingAddress),
  });

  const data = await queryShop<{
    draftOrderUpdate: {
      draftOrder: DraftOrderNode | null;
      userErrors: UserError[];
    };
  }>(merchantId, DRAFT_ORDER_UPDATE, { id: draft.externalId, input });

  throwOnUserErrors(data.draftOrderUpdate.userErrors, "exchange draft order");

  await prisma.exchangeDraftOrder.update({
    where: { id: draft.id },
    data: {
      invoiceUrl: data.draftOrderUpdate.draftOrder?.invoiceUrl ?? draft.invoiceUrl,
      itemsTotal: totals.itemsTotal,
      creditApplied: totals.creditApplied,
      balanceDue: totals.balanceDue,
    },
  });
};

/** Emails the shopper a checkout link for the exchange balance. */
export const sendExchangeInvoice = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  const draft = await prisma.exchangeDraftOrder.findUnique({
    where: { returnRequestId },
  });
  if (!draft) {
    throw new AppError(
      404,
      "NO_EXCHANGE_DRAFT",
      "This return has no exchange draft order to invoice.",
    );
  }
  if (draft.status === "COMPLETED") {
    throw new AppError(
      409,
      "EXCHANGE_ALREADY_COMPLETE",
      "This exchange has already been paid for.",
    );
  }

  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    select: { customerEmail: true, reference: true },
  });

  const data = await queryShop<{
    draftOrderInvoiceSend: {
      draftOrder: { id: string; status: string; invoiceSentAt: string | null } | null;
      userErrors: UserError[];
    };
  }>(merchantId, DRAFT_ORDER_INVOICE_SEND, {
    id: draft.externalId,
    email: {
      to: request.customerEmail,
      subject: `Complete your exchange for return ${request.reference}`,
      customMessage:
        "Your exchange is reserved. Use the link below to pay the difference and we'll ship your replacement as soon as your return arrives.",
    },
  });

  throwOnUserErrors(
    data.draftOrderInvoiceSend.userErrors,
    "exchange invoice",
  );

  const sent = data.draftOrderInvoiceSend.draftOrder;
  await prisma.exchangeDraftOrder.update({
    where: { id: draft.id },
    data: {
      status: "INVOICE_SENT",
      invoiceSentAt: sent?.invoiceSentAt ? new Date(sent.invoiceSentAt) : new Date(),
    },
  });

  await prisma.returnEvent.create({
    data: {
      returnRequestId,
      type: "NOTE_ADDED",
      message: `Exchange invoice sent to ${request.customerEmail} for ${draft.currency} ${Number(draft.balanceDue).toFixed(2)}`,
    },
  });
};

/**
 * Turns a fully-credited exchange into a real order.
 *
 * Called at resolution, and only when nothing is owed. A draft with a balance
 * is completed by the shopper paying the invoice — completing it here would
 * hand over the goods without collecting.
 */
export const completeExchangeDraftOrder = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  const draft = await prisma.exchangeDraftOrder.findUnique({
    where: { returnRequestId },
  });
  if (!draft) return;

  if (draft.status === "COMPLETED") {
    logger.info(
      { merchantId, returnRequestId, draftOrderId: draft.externalId },
      "Exchange draft order already completed; skipping",
    );
    return;
  }

  if (toDecimal(draft.balanceDue).greaterThan(0)) {
    logger.info(
      { merchantId, returnRequestId, balanceDue: draft.balanceDue },
      "Exchange still owes a balance; leaving the draft for the customer to pay",
    );
    return;
  }

  const data = await queryShop<{
    draftOrderComplete: {
      draftOrder: {
        id: string;
        status: string;
        order: { id: string; name: string } | null;
      } | null;
      userErrors: UserError[];
    };
  }>(merchantId, DRAFT_ORDER_COMPLETE, { id: draft.externalId });

  throwOnUserErrors(data.draftOrderComplete.userErrors, "exchange completion");

  const order = data.draftOrderComplete.draftOrder?.order ?? null;

  await prisma.exchangeDraftOrder.update({
    where: { id: draft.id },
    data: {
      status: "COMPLETED",
      externalOrderId: order?.id ?? null,
      completedAt: new Date(),
    },
  });

  await prisma.returnEvent.create({
    data: {
      returnRequestId,
      type: "EXCHANGE_SHIPPED",
      message: order
        ? `Exchange order ${order.name} created and ready to fulfil`
        : "Exchange draft order completed",
      metadata: { orderId: order?.id ?? null },
    },
  });
};

/**
 * Fills in exchange-item pictures that were stored before the product-image
 * fallback existed.
 *
 * Variants mostly carry no picture of their own, so those rows were written
 * with a null image and render as a grey box. New exchanges resolve correctly
 * now; this repairs the ones already on file.
 *
 * Called fire-and-forget from the read paths and self-limiting: it only ever
 * looks at rows still missing an image, so once a return has been opened it
 * costs nothing on subsequent loads. Never throws — a missing picture is
 * cosmetic, and it must not take down a return the shopper is trying to read.
 */
export const backfillExchangeItemImages = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  try {
    const missing = await prisma.exchangeItem.findMany({
      where: {
        returnRequestId,
        imageUrl: null,
        variantId: { not: null },
        returnRequest: { merchantId },
      },
      select: { id: true, variantId: true },
    });
    if (missing.length === 0) return;

    const images = await fetchVariantImages(
      merchantId,
      missing.map((item) => item.variantId!),
    );

    await Promise.all(
      missing.map((item) => {
        const url = images.get(item.variantId!);
        return url
          ? prisma.exchangeItem.update({
              where: { id: item.id },
              data: { imageUrl: url },
            })
          : Promise.resolve(null);
      }),
    );
  } catch (error) {
    logger.warn(
      { merchantId, returnRequestId, error },
      "Could not backfill exchange item images",
    );
  }
};

/**
 * A link the shopper can pay an outstanding exchange balance with.
 *
 * Two routes, one answer. Under DRAFT_ORDER the balance lives on the draft and
 * its invoice URL is already stored, so this is only consulted for the native
 * route, where the replacement sits on the original order and Shopify holds
 * fulfilment until the difference is paid.
 *
 * Returns null whenever nothing is owed, so a trade-down or an even swap never
 * shows a payment prompt — that was the whole complaint about exchanges asking
 * for money they shouldn't.
 *
 * Never throws: a missing link degrades to "no button", which is the state the
 * page was in before.
 */
export const getExchangePaymentUrl = async (
  merchantId: string,
  returnRequestId: string,
): Promise<{ url: string; amount: number; currency: string } | null> => {
  try {
    const request = await prisma.returnRequest.findFirst({
      where: { id: returnRequestId, merchantId },
      include: { order: true, exchangeItems: true },
    });
    if (!request?.order.externalId) return null;

    // Only the native route: a draft-order exchange carries its own invoice.
    const isNative = request.exchangeItems.some(
      (item) => item.externalExchangeLineItemId,
    );
    if (!isNative) return null;

    const data = await queryShop<{
      order: {
        totalOutstandingSet: {
          presentmentMoney: { amount: string; currencyCode: string };
        };
        paymentCollectionDetails: {
          additionalPaymentCollectionUrl: string | null;
        };
      } | null;
    }>(merchantId, ORDER_PAYMENT_COLLECTION, { id: request.order.externalId });

    const outstanding = data.order?.totalOutstandingSet.presentmentMoney;
    const url = data.order?.paymentCollectionDetails.additionalPaymentCollectionUrl;
    if (!url || !outstanding || parseFloat(outstanding.amount) <= 0) return null;

    return {
      url,
      amount: parseFloat(outstanding.amount),
      currency: outstanding.currencyCode,
    };
  } catch (error) {
    logger.warn(
      { merchantId, returnRequestId, error },
      "Could not resolve an exchange payment link",
    );
    return null;
  }
};

/**
 * Reconciles an exchange draft with Shopify, so a paid one stops asking for
 * payment.
 *
 * Completing a draft through its invoice link turns it into a real order, and
 * nothing tells this app that happened — which left the admin showing "Invoice
 * sent — awaiting payment" and the shopper a "Pay now" button against an
 * exchange they had already paid for.
 *
 * Read on demand rather than pushed: the same reasoning as the order sync. A
 * webhook can't be delivered to an instance that sleeps, and whoever opens the
 * return is the one who needs it current.
 *
 * Never throws, and does nothing once the draft is settled — so the ordinary
 * case costs one query and every case after that costs nothing.
 */
export const refreshExchangeDraft = async (
  merchantId: string,
  returnRequestId: string,
): Promise<void> => {
  try {
    const draft = await prisma.exchangeDraftOrder.findFirst({
      where: { returnRequestId, returnRequest: { merchantId } },
    });
    if (!draft) return;
    if (draft.status === "COMPLETED" || draft.status === "CANCELLED") return;

    const data = await queryShop<{
      draftOrder: {
        name: string | null;
        status: string;
        invoiceUrl: string | null;
        order: { id: string; name: string } | null;
      } | null;
    }>(merchantId, DRAFT_ORDER_STATE, { id: draft.externalId });

    const remote = data.draftOrder;
    if (!remote) return;

    /**
     * Shopify's own status is the authority, but `order` is the fact that
     * matters: a draft that names an order has been paid and converted,
     * whatever the status string says.
     */
    const paid = Boolean(remote.order) || remote.status === "COMPLETED";
    const cancelled = !paid && remote.status === "CANCELLED";
    if (!paid && !cancelled) return;

    await prisma.exchangeDraftOrder.update({
      where: { id: draft.id },
      data: {
        status: paid ? "COMPLETED" : "CANCELLED",
        externalOrderId: remote.order?.id ?? null,
        completedAt: paid ? new Date() : null,
        // A completed draft's invoice link is spent; keeping it would put a
        // dead "Pay now" in front of someone who has already paid.
        invoiceUrl: paid ? null : draft.invoiceUrl,
      },
    });

    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "STATUS_CHANGED",
        message: paid
          ? `Exchange paid — order ${remote.order?.name ?? "created"} in Shopify`
          : `Exchange draft ${draft.name ?? ""} was cancelled in Shopify`,
        metadata: { draftOrderId: draft.externalId, orderId: remote.order?.id ?? null },
      },
    });

    logger.info(
      { merchantId, returnRequestId, paid, orderId: remote.order?.id },
      "Exchange draft reconciled with Shopify",
    );

    /**
     * A paid exchange arrives in Shopify as an ordinary unfulfilled order —
     * ready to ship, for items that are still in the shopper's hands. Hold it
     * until the return is processed.
     *
     * Any status short of resolution qualifies, not just SUBMITTED: the usual
     * route is approve, invoice, pay, so restricting this to unreviewed returns
     * would have meant the common case was never held at all. Skipped once the
     * return is RESOLVED, where releasing is the whole point, and after a
     * rejection or cancellation, where the merchant may have taken the order
     * over by hand.
     */
    const HOLD_WHILE = ["SUBMITTED", "APPROVED", "IN_TRANSIT", "RECEIVED"];
    if (paid) {
      const request = await prisma.returnRequest.findUnique({
        where: { id: returnRequestId },
        select: { status: true },
      });
      if (request && HOLD_WHILE.includes(request.status)) {
        await holdExchangeFulfillment(merchantId, returnRequestId);
      }
    }
  } catch (error) {
    logger.warn(
      { merchantId, returnRequestId, error },
      "Could not refresh the exchange draft",
    );
  }
};
