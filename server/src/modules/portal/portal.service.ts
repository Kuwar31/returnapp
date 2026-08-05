import { Prisma, type ResolutionType } from "@prisma/client";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { round2, toDecimal, ZERO } from "../../lib/money.js";
import { evaluateOrder } from "../policy/eligibility.service.js";
import { qualifiesForAutoApproval, quoteReturn } from "../policy/quote.service.js";
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
  const order = await prisma.order.findFirst({
    where: { merchantId, orderNumber },
    include: { lineItems: { orderBy: { title: "asc" } } },
  });
  if (!order) return null;
  if (order.email.toLowerCase() !== email.toLowerCase()) return null;
  return order;
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
  const reasons = await prisma.returnReason.findMany({
    where: { merchantId, active: true },
    orderBy: { sortOrder: "asc" },
  });

  return {
    order,
    policy,
    reasons,
    eligibility: evaluateOrder(order, policy),
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
  if (!eligibility.allowedResolutions.includes(input.resolution)) {
    throw badRequest("That resolution isn't offered for this order.");
  }

  const linesById = new Map(order.lineItems.map((l) => [l.id, l]));
  const eligibleById = new Map(eligibility.items.map((i) => [i.id, i]));

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
    if (selection.quantity > evaluated.returnableQuantity) {
      throw unprocessable(
        `You can only return ${evaluated.returnableQuantity} of ${line.title}.`,
      );
    }
    return { line, selection };
  });

  return { order, policy, resolved };
};

const exchangeValueOf = (input: SubmitInput): Prisma.Decimal =>
  round2(
    input.exchangeItems.reduce(
      (sum, item) => sum.add(toDecimal(item.unitPrice).mul(item.quantity)),
      ZERO,
    ),
  );

/** Live estimate shown as the shopper picks items — nothing is persisted. */
export const quoteSelection = async (
  merchantId: string,
  orderId: string,
  input: QuoteInput,
) => {
  const { policy, resolved } = await resolveSelections(
    merchantId,
    orderId,
    input,
  );

  const quote = quoteReturn({
    lines: resolved.map(({ line, selection }) => ({
      unitPrice: toDecimal(line.unitPrice),
      quantity: selection.quantity,
    })),
    policy,
    resolution: input.resolution as ResolutionType,
  });

  return {
    currency: policy ? resolved[0].line.currency : "USD",
    itemsSubtotal: quote.itemsSubtotal.toNumber(),
    bonusCredit: quote.bonusCredit.toNumber(),
    restockingFee: quote.restockingFee.toNumber(),
    shippingFee: quote.shippingFee.toNumber(),
    estimatedTotal: quote.estimatedTotal.toNumber(),
    amountDue: quote.amountDue.toNumber(),
  };
};

export const submitReturn = async (
  merchantId: string,
  orderId: string,
  input: SubmitInput,
) => {
  const { order, policy, resolved } = await resolveSelections(
    merchantId,
    orderId,
    input,
  );

  const exchangeValue = exchangeValueOf(input);
  const quote = quoteReturn({
    lines: resolved.map(({ line, selection }) => ({
      unitPrice: toDecimal(line.unitPrice),
      quantity: selection.quantity,
    })),
    policy,
    resolution: input.resolution as ResolutionType,
    exchangeValue,
  });

  const reasons = await prisma.returnReason.findMany({
    where: { merchantId, active: true },
  });
  const reasonByCode = new Map(reasons.map((r) => [r.code, r]));

  for (const { selection } of resolved) {
    const reason = reasonByCode.get(selection.reasonCode);
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
  return prisma.$transaction(async (tx) => {
    const created = await tx.returnRequest.create({
      data: {
        merchantId,
        orderId: order.id,
        policyId: policy.id,
        reference: generateReference(),
        status: autoApproved ? "APPROVED" : "SUBMITTED",
        resolution: input.resolution as ResolutionType,
        customerEmail: order.email,
        customerName: order.customerName,
        customerNote: input.customerNote ?? null,
        currency: order.currency,
        itemsSubtotal: quote.itemsSubtotal,
        bonusCredit: quote.bonusCredit,
        restockingFee: quote.restockingFee,
        shippingFee: quote.shippingFee,
        estimatedTotal: quote.estimatedTotal,
        ...(autoApproved ? { reviewedAt: new Date() } : {}),
        lineItems: {
          create: resolved.map(({ line, selection }) => ({
            orderLineItemId: line.id,
            reasonId: reasonByCode.get(selection.reasonCode)!.id,
            quantity: selection.quantity,
            reasonNote: selection.reasonNote ?? null,
            photoUrls: selection.photoUrls,
            unitPrice: toDecimal(line.unitPrice),
            lineTotal: round2(toDecimal(line.unitPrice).mul(selection.quantity)),
          })),
        },
        exchangeItems: {
          create: input.exchangeItems.map((item) => ({
            productId: item.productId ?? null,
            variantId: item.variantId,
            sku: item.sku ?? null,
            title: item.title,
            variantTitle: item.variantTitle ?? null,
            imageUrl: item.imageUrl ?? null,
            quantity: item.quantity,
            unitPrice: toDecimal(item.unitPrice),
            priceDifference: ZERO,
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

    // Reserve the units so a second request can't return the same item twice.
    for (const { line, selection } of resolved) {
      await tx.orderLineItem.update({
        where: { id: line.id },
        data: { returnedQuantity: { increment: selection.quantity } },
      });
    }

    return created;
  });
};

export const getReturnByReference = async (
  merchantId: string,
  reference: string,
  email: string,
) => {
  const request = await prisma.returnRequest.findFirst({
    where: { merchantId, reference },
    include: {
      lineItems: { include: { reason: true, orderLineItem: true } },
      exchangeItems: true,
      shipment: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!request) return null;
  if (request.customerEmail.toLowerCase() !== email.toLowerCase()) return null;
  return request;
};
