import { Prisma, type ResolutionType } from "@prisma/client";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { displayConverter, round2, toDecimal, ZERO } from "../../lib/money.js";
import { evaluateOrder } from "../policy/eligibility.service.js";
import {
  getReasonTree,
  resolveGroupForProductType,
} from "../settings/reasons.service.js";
import { resolveDisplayMode } from "../settings/merchant-settings.js";
import {
  qualifiesForAutoApproval,
  quoteReturn,
  summaryResolution,
} from "../policy/quote.service.js";
import { notifyInBackground } from "../email/notifications.js";
import {
  browseProducts,
  describeVariants,
  getProductVariants,
  resolveVariants,
} from "../shopify/catalogue.service.js";
import {
  ensureShopifyReturn,
  getShopifyReturnableQuantities,
} from "../shopify/returns.service.js";
import { syncOrderByNumber } from "../shopify/order.sync.js";
import { generateReference } from "../returns/reference.js";
import type { QuoteInput, SubmitInput } from "./portal.schemas.js";

/** Returns the policy attached to the order, or the merchant's default. */
const resolvePolicy = async (merchantId: string, policyId: string | null) => {
  const policy = policyId
    ? await prisma.returnPolicy.findFirst({
        where: { id: policyId, merchantId, active: true },
      })
    : null;
  if (policy) return policy;

  const fallback = await prisma.returnPolicy.findFirst({
    where: { merchantId, isDefault: true, active: true },
  });
  if (!fallback) {
    throw unprocessable(
      "This store hasn't finished setting up its return policy yet.",
    );
  }
  return fallback;
};

export const getMerchantBySlug = async (slug: string) => {
  const merchant = await prisma.merchant.findFirst({
    where: { slug, status: "ACTIVE" },
    include: { branding: true },
  });
  if (!merchant) throw notFound("We couldn't find that store's returns portal.");
  return merchant;
};

/**
 * Verifies an order belongs to the given email. Returns null rather than
 * throwing so the route can send one generic message for "wrong number" and
 * "wrong email" — revealing which was wrong lets anyone enumerate orders.
 */
export const lookupOrder = async (
  merchantId: string,
  orderNumber: string,
  email: string,
) => {
  /**
   * Refresh from Shopify before answering, in place of the order and
   * fulfillment webhooks — see syncOrderByNumber for why they can't be relied
   * on here.
   *
   * This is the right moment for it whatever the hosting: lookup is the only
   * point where staleness is visible to anyone, and it also picks up an order
   * placed since the last backfill, which used to mean the portal insisted a
   * real order didn't exist.
   */
  await syncOrderByNumber(merchantId, orderNumber);

  const order = await prisma.order.findFirst({
    where: { merchantId, orderNumber },
    include: { lineItems: { orderBy: { title: "asc" } } },
  });
  if (!order) return null;
  if (order.email.toLowerCase() !== email.toLowerCase()) return null;
  return order;
};

/**
 * The image shown behind the portal.
 *
 * A merchant-set `heroImageUrl` always wins. Otherwise one is borrowed from the
 * store's own catalogue — brand-appropriate by construction, needs no stock
 * photography, and raises no licensing question. The result is written back so
 * this costs one Shopify call per store, not one per page view.
 *
 * Returns null rather than throwing: the portal renders perfectly well on a
 * plain background, so a catalogue that can't be read is not an error.
 */
export const resolveHeroImage = async (
  merchantId: string,
): Promise<string | null> => {
  const branding = await prisma.portalBranding.findUnique({
    where: { merchantId },
    select: { heroImageUrl: true },
  });
  if (branding?.heroImageUrl) return branding.heroImageUrl;

  try {
    const { products } = await browseProducts(merchantId, { limit: 10 });
    // Prefer a product with several variants: those tend to be real catalogue
    // photography rather than a gift card or a placeholder.
    const best =
      products.find((p) => p.imageUrl && p.variants.length > 1) ??
      products.find((p) => p.imageUrl);
    if (!best?.imageUrl) return null;

    await prisma.portalBranding.updateMany({
      where: { merchantId },
      data: { heroImageUrl: best.imageUrl },
    });
    return best.imageUrl;
  } catch (error) {
    logger.debug({ merchantId, error }, "No catalogue image for the portal hero");
    return null;
  }
};

export const getOrderEligibility = async (
  merchantId: string,
  orderId: string,
) => {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    include: { lineItems: { orderBy: { title: "asc" } } },
  });
  if (!order) throw notFound("Order not found.");

  const policy = await resolvePolicy(merchantId, order.policyId);

  /**
   * Reasons are resolved per line, not per order.
   *
   * A merchant words returns differently for footwear than for homeware, so
   * each item's product type picks its group. Groups are returned once and
   * referenced by id rather than inlined on every item — an order of six
   * shoes would otherwise repeat the same tree six times.
   */
  const groupByLine = new Map<string, string>();
  const groupsById = new Map<string, { id: string; randomizeOrder: boolean }>();
  for (const line of order.lineItems) {
    const group = await resolveGroupForProductType(merchantId, line.productType);
    if (!group) continue;
    groupByLine.set(line.id, group.id);
    groupsById.set(group.id, {
      id: group.id,
      randomizeOrder: group.randomizeOrder,
    });
  }

  const reasonGroups = await Promise.all(
    [...groupsById.values()].map(async (g) => ({
      id: g.id,
      reasons: await getReasonTree(g.id, g.randomizeOrder),
    })),
  );

  /**
   * Ask Shopify what it will actually accept, rather than trusting our mirror.
   *
   * This runs here — at lookup, before the shopper picks anything — so the only
   * items ever offered are ones Shopify will take. Consulting it later, at
   * approval, meant discovering conflicts after the customer had been promised
   * a return and emailed about it.
   *
   * Best-effort: if Shopify is unreachable we fall back to our own counts rather
   * than blocking the portal outright. A stale offer is recoverable; an
   * unusable returns page is not.
   */
  let shopifyReturnable: Map<string, number> | undefined;
  let unfulfilledQuantities: Map<string, number> | undefined;
  let exchangeReplacements: Set<string> | undefined;
  if (order.externalId) {
    try {
      const fromShopify = await getShopifyReturnableQuantities(
        merchantId,
        order.externalId,
      );
      /**
       * An empty result is ambiguous — it means either "nothing is returnable"
       * or "Shopify has never heard of this order" (a locally seeded order, or
       * one whose external id is stale). Treating it as zero would make every
       * item unreturnable and take the whole portal down for that order, so an
       * empty map is treated as *unknown* and our own counts stand.
       *
       * The risk this leaves is narrow: an order whose items are genuinely all
       * returned elsewhere would still be offered, and then fail at approval —
       * which is the behaviour we had before consulting Shopify at all.
       */
      unfulfilledQuantities = fromShopify.unfulfilled;
      exchangeReplacements = fromShopify.exchangeReplacements;
      if (fromShopify.returnable.size > 0) {
        shopifyReturnable = fromShopify.returnable;
      } else {
        logger.debug(
          { merchantId, orderId: order.id },
          "Shopify reported no returnable fulfillments; using local counts",
        );
      }
    } catch (error) {
      logger.warn(
        { merchantId, orderId: order.id, error },
        "Could not read returnable quantities from Shopify; using local counts",
      );
    }
  }

  const eligibility = evaluateOrder(
    order,
    policy,
    new Date(),
    shopifyReturnable,
    unfulfilledQuantities,
    exchangeReplacements,
  );

  // Item prices are converted here too, so the picker and the running total
  // never disagree about which currency they're in.
  const fx = displayConverter(
    order,
    await resolveDisplayMode(merchantId),
    order.currency,
  );

  return {
    order,
    policy,
    reasonGroups,
    eligibility: {
      ...eligibility,
      items: eligibility.items.map((item) => ({
        ...item,
        unitPrice: fx.money(toDecimal(item.unitPrice)) ?? item.unitPrice,
        currency: fx.currency,
        reasonGroupId: groupByLine.get(item.id) ?? null,
      })),
    },
  };
};

/**
 * Maps the shopper's raw selections onto real order lines, rejecting anything
 * that isn't currently returnable. Prices always come from the database, never
 * from the request body.
 */
const resolveSelections = async (
  merchantId: string,
  orderId: string,
  input: QuoteInput,
) => {
  const { order, policy, eligibility } = await getOrderEligibility(
    merchantId,
    orderId,
  );

  if (!eligibility.withinWindow) {
    throw unprocessable(
      `This order is outside the ${policy.returnWindowDays}-day return window.`,
    );
  }
  const linesById = new Map(order.lineItems.map((l) => [l.id, l]));
  const eligibleById = new Map(eligibility.items.map((i) => [i.id, i]));

  /**
   * Selections are articles, so the same line legitimately appears several
   * times. The returnable limit therefore has to be checked against how many
   * articles were chosen in total, not against each one on its own.
   */
  const chosenPerLine = new Map<string, number>();
  for (const selection of input.items) {
    chosenPerLine.set(
      selection.orderLineItemId,
      (chosenPerLine.get(selection.orderLineItemId) ?? 0) + 1,
    );
  }

  const resolved = input.items.map((selection) => {
    const line = linesById.get(selection.orderLineItemId);
    const evaluated = eligibleById.get(selection.orderLineItemId);
    if (!line || !evaluated) {
      throw badRequest("One of the selected items isn't part of this order.");
    }
    if (!evaluated.eligible) {
      throw unprocessable(
        evaluated.ineligibleReason ?? `${line.title} can't be returned.`,
      );
    }
    if ((chosenPerLine.get(line.id) ?? 0) > evaluated.returnableQuantity) {
      throw unprocessable(
        `You can only return ${evaluated.returnableQuantity} of ${line.title}.`,
      );
    }
    // Each line carries its own resolution now, so each is checked against the
    // policy separately — a shopper can't smuggle in an option this store
    // doesn't offer by attaching it to one item out of several.
    if (!eligibility.allowedResolutions.includes(selection.resolution)) {
      throw badRequest(
        `"${line.title}" can't be resolved that way for this order.`,
      );
    }
    return { line, selection };
  });

  /**
   * Price every chosen replacement from Shopify, never from the request.
   * One round trip for all of them, and it doubles as an availability check.
   */
  const variantIds = input.items
    .map((i) => i.exchange?.variantId)
    .filter((v): v is string => Boolean(v));
  const variants = variantIds.length
    ? await resolveVariants(merchantId, variantIds)
    : new Map();

  for (const item of input.items) {
    if (item.exchange && !variants.has(item.exchange.variantId)) {
      throw badRequest("One of the exchange options is no longer available.");
    }
  }

  return { order, policy, resolved, variants };
};

/**
 * Converts catalogue prices into the display currency, keyed to this order.
 *
 * Shopify hands back catalogue prices in shop currency, and sending them on
 * untouched put an unconverted item price next to a converted quote total —
 * the same "€30.00 under a €3,351.60 subtotal" mismatch the serializers were
 * fixed for. The shopper is choosing between these prices and the summary that
 * follows from them, so they have to be in the same money.
 *
 * The rate is the order's own, so a replacement is priced by the rate the
 * shopper already paid at rather than today's.
 */
const catalogueConverter = async (merchantId: string, orderId: string) => {
  const order = await prisma.order.findFirstOrThrow({
    where: { id: orderId, merchantId },
  });
  const fx = displayConverter(
    order,
    await resolveDisplayMode(merchantId),
    order.currency,
  );
  return {
    currency: fx.currency,
    price: (value: number) => fx.money(toDecimal(value)) ?? value,
  };
};

/**
 * Exchange options for one returned item: the other variants of the same
 * product, which covers the "wrong size" case that dominates real exchanges.
 */
export const getExchangeOptions = async (
  merchantId: string,
  orderId: string,
  orderLineItemId: string,
) => {
  const line = await prisma.orderLineItem.findFirst({
    where: { id: orderLineItemId, orderId },
  });
  if (!line) throw notFound("That item isn't part of this order.");

  const fx = await catalogueConverter(merchantId, orderId);

  if (!line.productId) {
    // Nothing to swap for — the item didn't come from Shopify, or predates
    // product ids being captured during sync.
    return {
      product: null,
      variants: [],
      currentVariantId: line.variantId,
      currency: fx.currency,
    };
  }

  const product = await getProductVariants(merchantId, line.productId);
  return {
    product: product
      ? { id: product.id, title: product.title, images: product.images ?? [] }
      : null,
    variants: (product?.variants ?? []).map((v) => ({
      ...v,
      price: fx.price(v.price),
    })),
    // Lets the picker mark the size they already have.
    currentVariantId: line.variantId,
    currency: fx.currency,
  };
};

/**
 * Fills in the display details of exchange variants a shopper already chose.
 *
 * The portal draft lives in the browser and outlives deploys, so a selection
 * saved before a field existed carries no picture and no split title. Rather
 * than make the shopper redo their choice, the page asks for what it's missing.
 *
 * Prices come back converted, like every other money field the portal sends.
 */
export const describeExchangeVariants = async (
  merchantId: string,
  orderId: string,
  variantIds: string[],
) => {
  const [described, fx] = await Promise.all([
    describeVariants(merchantId, variantIds),
    catalogueConverter(merchantId, orderId),
  ]);
  return {
    currency: fx.currency,
    variants: [...described.entries()].map(([id, v]) => ({
      id,
      title: v.title,
      variantTitle: v.variantTitle,
      imageUrl: v.imageUrl,
      price: fx.price(v.price),
    })),
  };
};

export const browseExchangeProducts = async (
  merchantId: string,
  orderId: string,
  { search, cursor }: { search?: string; cursor?: string },
) => {
  const [result, fx] = await Promise.all([
    browseProducts(merchantId, { search, cursor }),
    catalogueConverter(merchantId, orderId),
  ]);
  return {
    ...result,
    products: result.products.map((p) => ({
      ...p,
      minPrice: fx.price(p.minPrice),
      maxPrice: fx.price(p.maxPrice),
      currency: fx.currency,
      variants: p.variants.map((v) => ({ ...v, price: fx.price(v.price) })),
    })),
  };
};

/**
 * Turns validated selections into priced quote lines.
 *
 * Shared by the live estimate and by submit, so the figures a shopper is shown
 * are computed by exactly the same code that persists them.
 */
const toQuoteLines = (
  resolved: Array<{ line: { unitPrice: Prisma.Decimal }; selection: QuoteInput["items"][number] }>,
  variants: Map<string, { price: number }>,
) =>
  resolved.map(({ line, selection }) => {
    const chosen = selection.exchange
      ? variants.get(selection.exchange.variantId)
      : undefined;
    return {
      unitPrice: toDecimal(line.unitPrice),
      quantity: 1,
      resolution: selection.resolution as ResolutionType,
      exchangeValue: chosen
        ? round2(toDecimal(chosen.price).mul(selection.exchange!.quantity))
        : ZERO,
    };
  });

/** Live estimate shown as the shopper picks items — nothing is persisted. */
export const quoteSelection = async (
  merchantId: string,
  orderId: string,
  input: QuoteInput,
) => {
  const { order, policy, resolved, variants } = await resolveSelections(
    merchantId,
    orderId,
    input,
  );

  const quote = quoteReturn({
    lines: toQuoteLines(resolved, variants),
    policy,
  });

  /**
   * Converted at the boundary, like every other money response. The shopper
   * sees what they were charged when the merchant has chosen presentment.
   */
  const display = await resolveDisplayMode(merchantId);
  const fx = displayConverter(order, display, order.currency);

  return {
    currency: fx.currency,
    itemsSubtotal: fx.money(quote.itemsSubtotal),
    bonusCredit: fx.money(quote.bonusCredit),
    restockingFee: fx.money(quote.restockingFee),
    estimatedTotal: fx.money(quote.estimatedTotal),
    amountDue: fx.money(quote.amountDue),
    // Per-item breakdown so the portal can show each line's own outcome.
    lines: quote.lines.map((l, i) => ({
      orderLineItemId: resolved[i].selection.orderLineItemId,
      resolution: l.resolution,
      itemsSubtotal: fx.money(l.itemsSubtotal),
      bonusCredit: fx.money(l.bonusCredit),
      exchangeValue: fx.money(l.exchangeValue),
      credited: fx.money(l.credited),
      due: fx.money(l.due),
    })),
  };
};

export const submitReturn = async (
  merchantId: string,
  orderId: string,
  input: SubmitInput,
) => {
  const { order, policy, resolved, variants } = await resolveSelections(
    merchantId,
    orderId,
    input,
  );

  const quote = quoteReturn({
    lines: toQuoteLines(resolved, variants),
    policy,
  });

  const reasons = await prisma.returnReason.findMany({
    where: { merchantId, active: true },
  });
  // Keyed by id, not code: several reasons legitimately share a Shopify code,
  // so a code no longer identifies which one the shopper actually chose.
  const reasonById = new Map(reasons.map((r) => [r.id, r]));

  for (const { selection } of resolved) {
    const reason = reasonById.get(selection.reasonId);
    if (!reason) throw badRequest("Choose a valid reason for each item.");
    if (reason.requiresNote && !selection.reasonNote) {
      throw badRequest(`Add a note explaining "${reason.label}".`);
    }
    if (reason.requiresPhoto && selection.photoUrls.length === 0) {
      throw badRequest(`Add a photo for "${reason.label}".`);
    }
  }

  const autoApproved = qualifiesForAutoApproval(policy, quote);

  // One transaction so a partial write can't leave an order's returned
  // quantities out of step with the request that caused them.
  const created = await prisma.$transaction(async (tx) => {
    const created = await tx.returnRequest.create({
      data: {
        merchantId,
        orderId: order.id,
        policyId: policy.id,
        reference: generateReference(),
        status: autoApproved ? "APPROVED" : "SUBMITTED",
        // A single label for lists and reporting; the per-line resolutions
        // below are what actually drive payouts.
        resolution: summaryResolution(
          quote.lines.map((l) => ({
            resolution: l.resolution,
            itemsSubtotal: l.itemsSubtotal,
          })),
        ),
        customerEmail: order.email,
        customerName: order.customerName,
        customerNote: input.customerNote ?? null,
        exchangeSurplusMethod: input.exchangeSurplusMethod ?? "REFUND",
        currency: order.currency,
        itemsSubtotal: quote.itemsSubtotal,
        bonusCredit: quote.bonusCredit,
        restockingFee: quote.restockingFee,
        estimatedTotal: quote.estimatedTotal,
        ...(autoApproved ? { reviewedAt: new Date() } : {}),
        lineItems: {
          create: resolved.map(({ line, selection }) => ({
            orderLineItemId: line.id,
            reasonId: selection.reasonId,
            quantity: 1,
            reasonNote: selection.reasonNote ?? null,
            photoUrls: selection.photoUrls,
            resolution: selection.resolution as ResolutionType,
            unitPrice: toDecimal(line.unitPrice),
            lineTotal: round2(toDecimal(line.unitPrice)),
          })),
        },
        events: {
          create: [
            {
              type: "CREATED",
              message: `Return requested by ${order.email}`,
            },
            ...(autoApproved
              ? [
                  {
                    type: "STATUS_CHANGED" as const,
                    message: "Auto-approved by policy",
                  },
                ]
              : []),
          ],
        },
      },
      include: {
        lineItems: { include: { reason: true, orderLineItem: true } },
        exchangeItems: true,
        shipment: true,
        events: { orderBy: { createdAt: "asc" } },
      },
    });

    /**
     * Exchanges are created after the lines exist, because each one points at
     * the specific line it replaces. Prices come from `variants` — resolved
     * from Shopify — never from the request body.
     */
    const lineByOrderLineItemId = new Map(
      created.lineItems.map((li) => [li.orderLineItemId, li]),
    );
    for (const { selection } of resolved) {
      if (!selection.exchange) continue;
      const variant = variants.get(selection.exchange.variantId)!;
      const line = lineByOrderLineItemId.get(selection.orderLineItemId)!;
      await tx.exchangeItem.create({
        data: {
          returnRequestId: created.id,
          returnLineItemId: line.id,
          productId: variant.productId,
          variantId: variant.id,
          sku: variant.sku,
          title: variant.title,
          variantTitle: variant.variantTitle,
          imageUrl: variant.imageUrl,
          quantity: selection.exchange.quantity,
          unitPrice: toDecimal(variant.price),
          /**
           * What swapping this line costs, per unit: positive means the shopper
           * upgraded and owes the difference, negative means they traded down.
           * Recorded here because the confirmation page and the admin both need
           * to state the balance after the quote object is gone.
           */
          priceDifference: round2(
            toDecimal(variant.price).sub(line.unitPrice),
          ),
        },
      });
    }

    // Reserve the units so a second request can't return the same item twice.
    // One increment per article, so three units of a line reserve three.
    for (const { line } of resolved) {
      await tx.orderLineItem.update({
        where: { id: line.id },
        data: { returnedQuantity: { increment: 1 } },
      });
    }

    return tx.returnRequest.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        lineItems: { include: { reason: true, orderLineItem: true } },
        exchangeItems: true,
        shipment: true,
        events: { orderBy: { createdAt: "asc" } },
      },
    });
  });

  // An auto-approved request never passes through the admin approve endpoint,
  // so it has to mirror itself into Shopify here — otherwise every return under
  // the auto-approve threshold would exist only in our database.
  if (created.status === "APPROVED") {
    await ensureShopifyReturn(merchantId, created.id);
  }

  // Only once the transaction has committed — otherwise a rollback would still
  // have emailed the shopper about a return that doesn't exist. Auto-approved
  // requests skip straight to the approval email.
  notifyInBackground(
    created.id,
    created.status === "APPROVED" ? "APPROVED" : "SUBMITTED",
  );

  return created;
};

/** Everything the shopper's confirmation page renders. */
const confirmationInclude = {
  order: true,
  lineItems: { include: { reason: true, orderLineItem: true } },
  exchangeItems: true,
  shipment: true,
  events: { orderBy: { createdAt: "asc" } },
  feedback: true,
  // Carries the checkout link for an exchange the shopper still owes on.
  exchangeDraft: true,
} satisfies Prisma.ReturnRequestInclude;

export const getReturnByReference = async (
  merchantId: string,
  reference: string,
  email: string,
) => {
  const request = await prisma.returnRequest.findFirst({
    where: { merchantId, reference },
    include: confirmationInclude,
  });
  if (!request) return null;
  if (request.customerEmail.toLowerCase() !== email.toLowerCase()) return null;
  return request;
};

/**
 * Shopper-initiated cancellation.
 *
 * Deliberately limited to returns the store hasn't approved yet. Once approved
 * a Shopify Return object exists, the label may already be out, and unwinding
 * that is a merchant decision — so past that point this refuses and points the
 * shopper at support rather than leaving the two systems disagreeing.
 */
export const cancelReturnByReference = async (
  merchantId: string,
  reference: string,
  email: string,
) => {
  const request = await getReturnByReference(merchantId, reference, email);
  if (!request) return null;

  if (request.status === "CANCELLED") return request;

  if (request.status !== "SUBMITTED") {
    throw unprocessable(
      "This return has already been reviewed, so it can no longer be cancelled here. Please contact the store.",
    );
  }

  return prisma.$transaction(async (tx) => {
    // Written before the final read so the response already carries the event.
    await tx.returnEvent.create({
      data: {
        returnRequestId: request.id,
        type: "STATUS_CHANGED",
        message: "Cancelled by the customer from the returns portal",
        metadata: { from: request.status, to: "CANCELLED", source: "portal" },
      },
    });

    return tx.returnRequest.update({
      where: { id: request.id },
      data: { status: "CANCELLED" },
      include: confirmationInclude,
    });
  });
};

/**
 * Stores the confirmation-page survey.
 *
 * Upserted rather than appended: a shopper who revises a score is correcting
 * one answer, and counting both would skew the averages the merchant reads.
 */
export const saveReturnFeedback = async (
  merchantId: string,
  reference: string,
  email: string,
  input: { easeScore?: number; repeatScore?: number; comment?: string },
) => {
  const request = await getReturnByReference(merchantId, reference, email);
  if (!request) return null;

  const data = {
    easeScore: input.easeScore ?? null,
    repeatScore: input.repeatScore ?? null,
    comment: input.comment?.trim() || null,
  };

  await prisma.returnFeedback.upsert({
    where: { returnRequestId: request.id },
    create: { returnRequestId: request.id, ...data },
    update: data,
  });

  return prisma.returnRequest.findUniqueOrThrow({
    where: { id: request.id },
    include: confirmationInclude,
  });
};
