import type { Prisma } from "@prisma/client";
import { logger } from "../../lib/logger.js";
import { returnStatusUrl } from "../../lib/portal-links.js";
import { prisma } from "../../lib/prisma.js";
import { toDecimal } from "../../lib/money.js";
import { sendMail, type Mail } from "./mailer.js";
import { getExchangePaymentUrl } from "../shopify/exchange.service.js";
import {
  approvedEmail,
  declinedEmail,
  receivedEmail,
  resolvedEmail,
  submittedEmail,
  type EmailBrand,
  type EmailReturn,
} from "./templates.js";

export type NotificationKind =
  | "SUBMITTED"
  | "APPROVED"
  | "DECLINED"
  | "RECEIVED"
  | "RESOLVED";

/**
 * Loads everything the templates need in one query and shapes it. Returns null
 * when the return has vanished, so callers can no-op rather than throw.
 */
const loadContext = async (returnRequestId: string) => {
  const request = await prisma.returnRequest.findUnique({
    where: { id: returnRequestId },
    include: {
      order: { select: { orderNumber: true } },
      merchant: { select: { name: true, slug: true, branding: true } },
      lineItems: { include: { reason: true, orderLineItem: true } },
      storeCredit: { select: { code: true } },
      // Carries the invoice link on the draft-order route.
      exchangeDraft: true,
    },
  });
  if (!request) return null;

  const statusUrl = returnStatusUrl(
    request.merchant.slug,
    request.reference,
    request.customerEmail,
  );

  const brand: EmailBrand = {
    merchantName: request.merchant.name,
    accentColor: request.merchant.branding?.accentColor ?? "#111213",
    supportEmail: request.merchant.branding?.supportEmail ?? null,
    statusUrl,
  };

  const payload: EmailReturn = {
    reference: request.reference,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    orderNumber: request.order.orderNumber,
    resolution: request.resolution,
    currency: request.currency,
    estimatedTotal: toDecimal(request.estimatedTotal).toNumber(),
    settledTotal:
      request.settledTotal === null
        ? null
        : toDecimal(request.settledTotal).toNumber(),
    rejectionReason: request.rejectionReason,
    items: request.lineItems.map((item) => ({
      title: item.orderLineItem?.title ?? "Item",
      variantTitle: item.orderLineItem?.variantTitle ?? null,
      quantity: item.quantity,
      reasonLabel: item.reason?.label ?? null,
    })),
    payment: await resolvePayment(request.merchantId, request),
  };

  return { payload, brand, creditCode: request.storeCredit?.code ?? null };
};

/**
 * Where the shopper pays an exchange difference, if they owe one.
 *
 * The two exchange routes produce it at different moments, which is why both
 * the approval and the resolution mail can carry it: a draft order has its
 * invoice link the moment the return is approved, while a native exchange only
 * puts a balance on the order once it is processed.
 *
 * Returns null whenever nothing is owed, so a refund, a trade-down or an even
 * swap never gets a payment prompt in the post.
 */
const resolvePayment = async (
  merchantId: string,
  request: {
    id: string;
    exchangeDraft: {
      invoiceUrl: string | null;
      status: string;
      balanceDue: Prisma.Decimal;
      currency: string;
    } | null;
  },
): Promise<{ url: string; amount: number; currency: string } | null> => {
  const draft = request.exchangeDraft;
  if (draft?.invoiceUrl && draft.status !== "COMPLETED") {
    const due = toDecimal(draft.balanceDue).toNumber();
    if (due > 0) {
      return { url: draft.invoiceUrl, amount: due, currency: draft.currency };
    }
    return null;
  }
  return getExchangePaymentUrl(merchantId, request.id);
};

const build = (
  kind: NotificationKind,
  payload: EmailReturn,
  brand: EmailBrand,
  creditCode: string | null,
): Mail => {
  switch (kind) {
    case "SUBMITTED":
      return submittedEmail(payload, brand);
    case "APPROVED":
      return approvedEmail(payload, brand);
    case "DECLINED":
      return declinedEmail(payload, brand);
    case "RECEIVED":
      return receivedEmail(payload, brand);
    case "RESOLVED":
      return resolvedEmail(payload, brand, creditCode);
  }
};

/**
 * Sends one lifecycle notification and records it on the return's timeline.
 *
 * Never throws: a notification is a side effect of a state change that has
 * already been committed, so a mail failure must not surface as a failed API
 * call. Failures are logged and left visible in the timeline instead.
 */
export const notify = async (
  returnRequestId: string,
  kind: NotificationKind,
): Promise<void> => {
  try {
    const context = await loadContext(returnRequestId);
    if (!context) return;

    const mail = build(
      kind,
      context.payload,
      context.brand,
      context.creditCode,
    );
    const { delivered, reason } = await sendMail(mail);

    await prisma.returnEvent.create({
      data: {
        returnRequestId,
        type: "EMAIL_SENT",
        message: delivered
          ? `Emailed ${mail.to}: ${mail.subject}`
          // The reason goes on the timeline, not just the logs — a merchant
          // shouldn't need host access to find out why a customer never heard
          // from them.
          : `Couldn't email ${mail.to}: ${reason ?? "delivery failed"}`,
        metadata: { kind, delivered, subject: mail.subject, reason },
      },
    });
  } catch (error) {
    logger.error(
      { err: error, returnRequestId, kind },
      "Notification failed unexpectedly",
    );
  }
};

/**
 * Fire-and-forget wrapper for request handlers. Keeps SMTP latency off the
 * response path — the shopper shouldn't wait on a mail server to see their
 * confirmation screen.
 */
export const notifyInBackground = (
  returnRequestId: string,
  kind: NotificationKind,
): void => {
  void notify(returnRequestId, kind);
};
