import { formatMoney } from "../../lib/money.js";
import type { Mail } from "./mailer.js";

export interface EmailBrand {
  merchantName: string;
  accentColor: string;
  supportEmail: string | null;
  /** Link to the shopper's status page, already signed with reference + email. */
  statusUrl: string;
}

export interface EmailReturn {
  reference: string;
  customerName: string | null;
  customerEmail: string;
  orderNumber: string;
  resolution: string;
  currency: string;
  estimatedTotal: number;
  settledTotal: number | null;
  rejectionReason: string | null;
  items: Array<{
    title: string;
    variantTitle: string | null;
    quantity: number;
    reasonLabel: string | null;
  }>;
  /**
   * Where to pay an outstanding exchange balance, when one exists.
   *
   * Absent for a refund, a trade-down or an even swap — nothing is owed, so
   * inviting payment would be wrong. Present only once the exchange has
   * actually been raised in Shopify, which is why the approval mail can carry
   * it on the draft-order route and the resolution mail carries it on the
   * native one.
   */
  payment?: { url: string; amount: number; currency: string } | null;
}

/** Escapes interpolated values so a product title can't inject markup. */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const greeting = (request: EmailReturn): string =>
  request.customerName ? `Hi ${request.customerName.split(" ")[0]},` : "Hi,";

const itemLines = (request: EmailReturn): string =>
  request.items
    .map((item) => {
      const variant = item.variantTitle ? ` · ${esc(item.variantTitle)}` : "";
      const reason = item.reasonLabel ? ` — ${esc(item.reasonLabel)}` : "";
      return `<tr><td style="padding:6px 0;border-bottom:1px solid #ececed;font-size:14px;color:#1a1a1c">
        ${esc(item.title)}${variant} × ${item.quantity}${reason}
      </td></tr>`;
    })
    .join("");

const itemLinesText = (request: EmailReturn): string =>
  request.items
    .map((item) => {
      const variant = item.variantTitle ? ` · ${item.variantTitle}` : "";
      const reason = item.reasonLabel ? ` — ${item.reasonLabel}` : "";
      return `  - ${item.title}${variant} × ${item.quantity}${reason}`;
    })
    .join("\n");

/**
 * Shared shell. Table-based and inline-styled on purpose: email clients ignore
 * <style> blocks and flexbox, so this is the layout that survives Gmail,
 * Outlook and Apple Mail alike.
 */
const shell = ({
  brand,
  heading,
  intro,
  body = "",
  ctaLabel,
}: {
  brand: EmailBrand;
  heading: string;
  intro: string;
  body?: string;
  ctaLabel: string;
}): string => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f6;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <tr><td>
        <p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8c9196">
          ${esc(brand.merchantName)}
        </p>
        <h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#1a1a1c">${esc(heading)}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#4a4a4d">${intro}</p>
        ${body}
        <a href="${brand.statusUrl}" style="display:inline-block;margin-top:8px;padding:12px 22px;background:${esc(brand.accentColor)};color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600">
          ${esc(ctaLabel)}
        </a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#8c9196">
          ${
            brand.supportEmail
              ? `Questions? Reply to this email or contact <a href="mailto:${esc(brand.supportEmail)}" style="color:#8c9196">${esc(brand.supportEmail)}</a>.`
              : "Questions? Just reply to this email."
          }
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

const summaryBlock = (request: EmailReturn, label: string): string => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
    ${itemLines(request)}
    <tr><td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#1a1a1c">
      ${label}: ${formatMoney(request.settledTotal ?? request.estimatedTotal, request.currency)}
    </td></tr>
  </table>`;

const footerText = (brand: EmailBrand): string =>
  `\n\nView your return: ${brand.statusUrl}\n` +
  (brand.supportEmail ? `Questions? ${brand.supportEmail}\n` : "");

const RESOLUTION_WORD: Record<string, string> = {
  REFUND: "refund",
  STORE_CREDIT: "store credit",
  GIFT_CARD: "gift card",
  EXCHANGE: "exchange",
  INSTANT_EXCHANGE: "exchange",
  WARRANTY: "warranty replacement",
};

export const submittedEmail = (
  request: EmailReturn,
  brand: EmailBrand,
): Mail => {
  const word = RESOLUTION_WORD[request.resolution] ?? "return";
  return {
    to: request.customerEmail,
    subject: `We've got your return request (${request.reference})`,
    html: shell({
      brand,
      heading: "Your return request is in",
      intro: `${greeting(request)} thanks for sending this over. We're reviewing your ${esc(word)} request for order #${esc(request.orderNumber)} and will email you as soon as it's approved.`,
      body: summaryBlock(request, "Estimated total"),
      ctaLabel: "Track your return",
    }),
    text:
      `${greeting(request)}\n\nThanks for sending this over. We're reviewing your ${word} request for order #${request.orderNumber}.\n\n` +
      `Reference: ${request.reference}\n\n${itemLinesText(request)}\n\n` +
      `Estimated total: ${formatMoney(request.estimatedTotal, request.currency)}` +
      footerText(brand),
  };
};

/**
 * The "pay the difference" call to action.
 *
 * Deliberately its own block rather than a line inside the summary: it is the
 * one thing in the mail the shopper has to act on, and burying it under a list
 * of items is how an exchange ends up abandoned.
 */
const paymentBlock = (request: EmailReturn): string =>
  request.payment
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0">
  <tr><td style="background:#fff4f4;border:1px solid #f0c9c9;border-radius:10px;padding:16px">
    <p style="margin:0 0 4px;font-size:13px;color:#8c9196">To complete your exchange</p>
    <p style="margin:0 0 14px;font-size:20px;font-weight:700;color:#1a1a1c">${esc(
      formatMoney(request.payment.amount, request.payment.currency),
    )}</p>
    <a href="${esc(request.payment.url)}" style="display:inline-block;background:#1a1a1c;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:600">Pay now</a>
  </td></tr>
</table>`
    : "";

const paymentText = (request: EmailReturn): string =>
  request.payment
    ? `\n\nTo complete your exchange, pay ${formatMoney(
        request.payment.amount,
        request.payment.currency,
      )}:\n${request.payment.url}`
    : "";

export const approvedEmail = (
  request: EmailReturn,
  brand: EmailBrand,
): Mail => ({
  to: request.customerEmail,
  subject: `Your return is approved (${request.reference})`,
  html: shell({
    brand,
    heading: "Your return is approved",
    intro: `${greeting(request)} good news — your return for order #${esc(request.orderNumber)} has been approved. Send the items back and we'll process your ${esc(RESOLUTION_WORD[request.resolution] ?? "return")} as soon as they arrive.`,
    body: summaryBlock(request, "Estimated total") + paymentBlock(request),
    ctaLabel: "See return instructions",
  }),
  text:
    `${greeting(request)}\n\nYour return for order #${request.orderNumber} has been approved. Send the items back and we'll process your ${RESOLUTION_WORD[request.resolution] ?? "return"} once they arrive.\n\n` +
    `Reference: ${request.reference}\n\n${itemLinesText(request)}\n\n` +
    `Estimated total: ${formatMoney(request.estimatedTotal, request.currency)}` +
    paymentText(request) +
    footerText(brand),
});

export const declinedEmail = (
  request: EmailReturn,
  brand: EmailBrand,
): Mail => ({
  to: request.customerEmail,
  subject: `About your return request (${request.reference})`,
  html: shell({
    brand,
    heading: "We couldn't approve this return",
    intro: `${greeting(request)} we've reviewed your request for order #${esc(request.orderNumber)} and unfortunately can't approve it.${
      request.rejectionReason
        ? ` <br><br><strong>Reason:</strong> ${esc(request.rejectionReason)}`
        : ""
    }`,
    ctaLabel: "View details",
  }),
  text:
    `${greeting(request)}\n\nWe've reviewed your request for order #${request.orderNumber} and unfortunately can't approve it.\n\n` +
    (request.rejectionReason ? `Reason: ${request.rejectionReason}\n\n` : "") +
    `Reference: ${request.reference}` +
    footerText(brand),
});

export const receivedEmail = (
  request: EmailReturn,
  brand: EmailBrand,
): Mail => ({
  to: request.customerEmail,
  subject: `We've received your return (${request.reference})`,
  html: shell({
    brand,
    heading: "Your items arrived",
    intro: `${greeting(request)} your return has reached us and is being checked over. Your ${esc(RESOLUTION_WORD[request.resolution] ?? "refund")} will follow shortly.`,
    body: summaryBlock(request, "Expected total"),
    ctaLabel: "Track your return",
  }),
  text:
    `${greeting(request)}\n\nYour return has reached us and is being checked over. Your ${RESOLUTION_WORD[request.resolution] ?? "refund"} will follow shortly.\n\n` +
    `Reference: ${request.reference}` +
    footerText(brand),
});

export const resolvedEmail = (
  request: EmailReturn,
  brand: EmailBrand,
  /** Present for store-credit resolutions so the shopper gets their code. */
  creditCode?: string | null,
): Mail => {
  const amount = formatMoney(
    request.settledTotal ?? request.estimatedTotal,
    request.currency,
  );

  const isGiftCard = request.resolution === "GIFT_CARD";
  const isCredit = request.resolution === "STORE_CREDIT";
  const heading = isGiftCard
    ? "Your gift card is here"
    : isCredit
      ? "Your store credit is ready"
      : request.resolution === "REFUND"
        ? "Your refund is on its way"
        : "Your exchange is on its way";

  const intro = isGiftCard
    ? `${greeting(request)} your return is all wrapped up. Here is your gift card for <strong>${amount}</strong> — enter the code at checkout.`
    : isCredit
    ? `${greeting(request)} your return is all wrapped up and your store credit of <strong>${amount}</strong> is ready to spend.`
    : request.resolution === "REFUND"
      ? `${greeting(request)} your return is complete and a refund of <strong>${amount}</strong> has been issued to your original payment method. Banks usually take 3–5 business days to show it.`
      : request.payment
        ? `${greeting(request)} your return is complete. One step left — settle the difference below and your replacement ships straight away.`
        : `${greeting(request)} your return is complete and your replacement is on its way.`;

  // Gift cards and store credit both surface a code block; only the gift card
  // code is actually redeemable at checkout.
  const creditBlock =
    (isCredit || isGiftCard) && creditCode
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
           <tr><td style="padding:16px;background:#f6f6f7;border-radius:10px;text-align:center">
             <p style="margin:0 0 6px;font-size:13px;color:#6b7177">${
               isGiftCard ? "Your gift card code" : "Your credit code"
             }</p>
             <p style="margin:0;font-size:20px;font-weight:700;letter-spacing:.06em;color:#1a1a1c">${esc(creditCode)}</p>
           </td></tr>
         </table>`
      : "";

  return {
    to: request.customerEmail,
    subject: isGiftCard
      ? `Your ${amount} gift card (${request.reference})`
      : isCredit
        ? `Your ${amount} store credit is ready (${request.reference})`
        : `Your return is complete (${request.reference})`,
    html: shell({
      brand,
      heading,
      intro,
      body: creditBlock + paymentBlock(request),
      ctaLabel: isCredit || isGiftCard ? "Start shopping" : "View your return",
    }),
    text:
      `${greeting(request)}\n\n` +
      (isGiftCard
        ? `Your return is complete. Here is your gift card for ${amount} — enter the code at checkout.\n\n` +
          (creditCode ? `Gift card code: ${creditCode}\n\n` : "")
        : isCredit
        ? `Your return is complete and your store credit of ${amount} is ready to spend.\n\n` +
          (creditCode ? `Credit code: ${creditCode}\n\n` : "")
        : request.resolution === "REFUND"
          ? `Your return is complete and a refund of ${amount} has been issued to your original payment method. Banks usually take 3-5 business days to show it.\n\n`
          : request.payment
            ? `Your return is complete. One step left — settle the difference below and your replacement ships straight away.\n\n`
            : `Your return is complete and your replacement is on its way.\n\n`) +
      `Reference: ${request.reference}` +
      paymentText(request) +
      footerText(brand),
  };
};

/**
 * The merchant changed what's being accepted, so what the shopper is getting
 * moved. Deliberately states the new figure rather than the change: a customer
 * doesn't hold the old number in their head, and "we've adjusted it to X" is
 * the sentence they can act on.
 */
export const editedEmail = (request: EmailReturn, brand: EmailBrand): Mail => ({
  to: request.customerEmail,
  subject: `An update to your return (${request.reference})`,
  html: shell({
    brand,
    heading: "We've updated your return",
    intro: `${greeting(request)} we've made a change to your return for order #${esc(request.orderNumber)} after checking the items over. Here's where it stands now.`,
    body: summaryBlock(request, "Updated total"),
    ctaLabel: "See your return",
  }),
  text:
    `${greeting(request)}\n\nWe've made a change to your return for order #${request.orderNumber} after checking the items over. ` +
    `Updated total: ${formatMoney(request.settledTotal ?? request.estimatedTotal, request.currency)}\n\n` +
    `Reference: ${request.reference}` +
    footerText(brand),
});

/**
 * Approved, and nothing has arrived. A nudge, not a warning — nothing has gone
 * wrong yet, and treating a slow week as a problem is how a helpful email
 * turns into a nagging one.
 */
export const reminderEmail = (
  request: EmailReturn,
  brand: EmailBrand,
  days: number,
): Mail => ({
  to: request.customerEmail,
  subject: `Don't forget to send your return back (${request.reference})`,
  html: shell({
    brand,
    heading: "Your return is still waiting",
    intro: `${greeting(request)} we approved your return for order #${esc(request.orderNumber)} ${days} days ago and it hasn't reached us yet. Pop it in the post whenever you're ready — everything below is still reserved for you.`,
    body: summaryBlock(request, "Estimated total"),
    ctaLabel: "See return instructions",
  }),
  text:
    `${greeting(request)}\n\nWe approved your return for order #${request.orderNumber} ${days} days ago and it hasn't reached us yet. ` +
    `Send it back whenever you're ready.\n\nReference: ${request.reference}` +
    footerText(brand),
});

/** The last nudge, with the date it stops being possible. */
export const expiringEmail = (
  request: EmailReturn,
  brand: EmailBrand,
  daysLeft: number,
): Mail => ({
  to: request.customerEmail,
  subject: `Your return closes in ${daysLeft} days (${request.reference})`,
  html: shell({
    brand,
    heading: `${daysLeft} days left to send your return`,
    intro: `${greeting(request)} your approved return for order #${esc(request.orderNumber)} hasn't reached us. If it isn't on its way within ${daysLeft} days we'll close the request, and you'd need to start a new one.`,
    body: summaryBlock(request, "Estimated total"),
    ctaLabel: "See return instructions",
  }),
  text:
    `${greeting(request)}\n\nYour approved return for order #${request.orderNumber} hasn't reached us. ` +
    `If it isn't on its way within ${daysLeft} days we'll close the request.\n\nReference: ${request.reference}` +
    footerText(brand),
});

/**
 * Closed. Says plainly that a new request is possible, because the alternative
 * reading — "you've missed your chance entirely" — is both wrong and the one a
 * shopper will assume.
 */
export const expiredEmail = (request: EmailReturn, brand: EmailBrand): Mail => ({
  to: request.customerEmail,
  subject: `Your return request has closed (${request.reference})`,
  html: shell({
    brand,
    heading: "Your return request has closed",
    intro: `${greeting(request)} we never received the items for your return on order #${esc(request.orderNumber)}, so we've closed the request. If you still want to send them back, start a new return and we'll take it from there.`,
    ctaLabel: "Start a new return",
  }),
  text:
    `${greeting(request)}\n\nWe never received the items for your return on order #${request.orderNumber}, so we've closed the request. ` +
    `If you still want to send them back, start a new return.\n\nReference: ${request.reference}` +
    footerText(brand),
});
