import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { round2, toDecimal } from "../../lib/money.js";
import { queryShop } from "./shopify.client.js";
import {
  FIND_CUSTOMER_BY_EMAIL,
  GIFT_CARD_CREATE,
  STORE_CREDIT_ACCOUNT_CREDIT,
} from "./returns.graphql.js";

interface UserError {
  field?: string[] | null;
  message: string;
}

/**
 * Finds the Shopify Customer GID for a return.
 *
 * Prefers the id captured during order sync, falling back to an email lookup so
 * orders imported before that field existed still work. The resolved id is
 * written back to the order to avoid repeating the lookup.
 */
export const resolveCustomerId = async (
  merchantId: string,
  orderId: string,
  email: string,
): Promise<string | null> => {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, customerExternalId: true },
  });
  if (order.customerExternalId) return order.customerExternalId;

  const sanitized = email.replace(/["'\\()]/g, "");
  const data = await queryShop<{
    customers: { nodes: Array<{ id: string; email: string | null }> };
  }>(merchantId, FIND_CUSTOMER_BY_EMAIL, { query: `email:${sanitized}` });

  const match = data.customers.nodes.find(
    (c) => (c.email ?? "").toLowerCase() === email.toLowerCase(),
  );
  if (!match) return null;

  await prisma.order.update({
    where: { id: order.id },
    data: { customerExternalId: match.id },
  });
  return match.id;
};

/**
 * Converts a payout from shop currency into the currency the customer actually
 * paid in.
 *
 * Store credit accounts and gift cards are denominated per currency, and a
 * balance in a currency the customer never checks out in is unspendable. So a
 * payout is converted using the order's *own* effective rate — presentment
 * total over shop total — rather than a live rate. That keeps the refund
 * consistent with the prices the customer actually saw, and needs no FX feed.
 *
 * Falls back to shop currency when the order predates presentment capture or
 * the numbers are unusable, which is correct for single-currency stores.
 */
const toCustomerCurrency = (
  amountInShopCurrency: Prisma.Decimal,
  order: {
    currency: string;
    total: Prisma.Decimal;
    presentmentCurrency: string | null;
    presentmentTotal: Prisma.Decimal | null;
  },
): { amount: Prisma.Decimal; currency: string; converted: boolean } => {
  const target = order.presentmentCurrency;
  if (!target || target === order.currency) {
    return { amount: amountInShopCurrency, currency: order.currency, converted: false };
  }

  const shopTotal = toDecimal(order.total);
  const presentmentTotal =
    order.presentmentTotal === null ? null : toDecimal(order.presentmentTotal);

  if (!presentmentTotal || shopTotal.lessThanOrEqualTo(0)) {
    // We know the currency but not the rate — crediting the raw number in a
    // different currency would be badly wrong, so stay in shop currency.
    return { amount: amountInShopCurrency, currency: order.currency, converted: false };
  }

  const rate = presentmentTotal.div(shopTotal);
  return {
    amount: round2(amountInShopCurrency.mul(rate)),
    currency: target,
    converted: true,
  };
};

export interface CreditResult {
  accountId: string | null;
  transactionId: string | null;
  amount: number;
  currency: string;
  balanceAfter: number | null;
}

/**
 * Credits the customer's Shopify store credit account for a resolved return.
 *
 * Throws on failure so the caller can abort the resolution rather than tell a
 * customer they have credit that doesn't exist — the same rule cash refunds
 * follow.
 *
 * Guest checkouts have no customer record and therefore no account to credit;
 * those surface as a clear error rather than silently succeeding.
 */
export const issueShopifyStoreCredit = async (
  merchantId: string,
  returnRequestId: string,
  /**
   * The store-credit share of this return. Omitted means the whole return, for
   * the single-resolution case; a mixed return must pass only its own portion
   * or the customer is credited for items they were refunded for.
   */
  amountOverride?: Prisma.Decimal,
): Promise<CreditResult> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { order: true },
  });

  /**
   * Same guard as gift cards: storeCreditAccountCredit is not idempotent, so a
   * retry would credit the customer twice.
   */
  const existing = await prisma.storeCredit.findUnique({
    where: { returnRequestId },
  });
  if (existing?.kind === "STORE_CREDIT" && existing.externalAccountId) {
    throw new AppError(
      409,
      "ALREADY_ISSUED",
      `Store credit was already issued for ${request.reference}.`,
    );
  }

  const customerId = await resolveCustomerId(
    merchantId,
    request.orderId,
    request.customerEmail,
  );
  if (!customerId) {
    throw new AppError(
      409,
      "NO_CUSTOMER_ACCOUNT",
      `No Shopify customer found for ${request.customerEmail}. Store credit needs a customer account — this may have been a guest checkout.`,
    );
  }

  const amount = amountOverride ?? toDecimal(request.estimatedTotal);
  if (amount.lessThanOrEqualTo(0)) {
    throw new AppError(
      422,
      "NOTHING_TO_CREDIT",
      "This return works out to nothing once fees are applied.",
    );
  }

  const payout = toCustomerCurrency(amount, request.order);
  const currency = payout.currency;

  const data = await queryShop<{
    storeCreditAccountCredit: {
      storeCreditAccountTransaction: {
        amount: { amount: string; currencyCode: string };
        balanceAfterTransaction: { amount: string; currencyCode: string } | null;
        account: { id: string } | null;
        createdAt: string;
      } | null;
      userErrors: UserError[];
    };
  }>(merchantId, STORE_CREDIT_ACCOUNT_CREDIT, {
    id: customerId,
    creditInput: {
      creditAmount: { amount: payout.amount.toFixed(2), currencyCode: currency },
    },
  });

  const errors = data.storeCreditAccountCredit.userErrors;
  if (errors.length > 0) {
    throw new AppError(
      422,
      "STORE_CREDIT_FAILED",
      `Shopify rejected the store credit: ${errors.map((e) => e.message).join("; ")}`,
    );
  }

  const txn = data.storeCreditAccountCredit.storeCreditAccountTransaction;
  if (!txn) {
    throw new AppError(
      502,
      "STORE_CREDIT_FAILED",
      "Shopify returned no store credit transaction.",
    );
  }

  logger.info(
    {
      merchantId,
      returnRequestId,
      amount: txn.amount.amount,
      currency,
      converted: payout.converted,
    },
    "Store credit issued in Shopify",
  );

  return {
    accountId: txn.account?.id ?? null,
    // Transactions aren't individually addressable by id in the payload, so the
    // account id plus timestamp is what we keep for reconciliation.
    transactionId: txn.account ? `${txn.account.id}@${txn.createdAt}` : null,
    amount: parseFloat(txn.amount.amount),
    currency: txn.amount.currencyCode,
    balanceAfter: txn.balanceAfterTransaction
      ? parseFloat(txn.balanceAfterTransaction.amount)
      : null,
  };
};

export interface GiftCardResult {
  giftCardId: string;
  /** The redeemable code. Only ever available on the create response. */
  code: string;
  maskedCode: string | null;
  amount: number;
  currency: string;
  expiresOn: string | null;
}

/**
 * Issues a Shopify gift card for a resolved return.
 *
 * Unlike store credit, a gift card is bearer value: anyone with the code can
 * spend it, and it does not require a customer account. It is still attached to
 * the customer when one exists, so it shows on their record and they can find
 * it themselves.
 *
 * Throws on failure so the caller aborts the resolution rather than telling a
 * customer they have a card that was never created.
 */
export const issueShopifyGiftCard = async (
  merchantId: string,
  returnRequestId: string,
  /** The gift-card share of this return; omitted means the whole return. */
  amountOverride?: Prisma.Decimal,
): Promise<GiftCardResult> => {
  const request = await prisma.returnRequest.findFirstOrThrow({
    where: { id: returnRequestId, merchantId },
    include: { order: true },
  });

  /**
   * A gift card is real money, and giftCardCreate is not idempotent — calling
   * it twice mints two cards. Our own record is the guard, so a retry after a
   * later step failed can never issue a second card.
   */
  const existing = await prisma.storeCredit.findUnique({
    where: { returnRequestId },
  });
  if (existing?.kind === "GIFT_CARD" && existing.externalAccountId) {
    throw new AppError(
      409,
      "ALREADY_ISSUED",
      `A gift card was already issued for ${request.reference}.`,
    );
  }

  const amount = amountOverride ?? toDecimal(request.estimatedTotal);
  if (amount.lessThanOrEqualTo(0)) {
    throw new AppError(
      422,
      "NOTHING_TO_CREDIT",
      "This return works out to nothing once fees are applied.",
    );
  }

  // Optional: a guest checkout still gets a working card, just unattached.
  const customerId = await resolveCustomerId(
    merchantId,
    request.orderId,
    request.customerEmail,
  ).catch(() => null);

  type GiftCardPayload = {
    giftCardCreate: {
      giftCard: {
        id: string;
        maskedCode: string | null;
        balance: { amount: string; currencyCode: string };
        expiresOn: string | null;
      } | null;
      giftCardCode: string | null;
      userErrors: UserError[];
    };
  };

  /**
   * Gift cards are always denominated in the SHOP currency — `initialValue` is
   * a bare decimal with no currency field, unlike a store credit amount. So the
   * presentment conversion must NOT be applied here: passing an INR figure made
   * Shopify read ₹12,430 as €12,430 and reject it against the €2,000 card cap.
   * That cap is the only reason it didn't quietly issue a 110x overpayment.
   *
   * Exactly one mutation, always. giftCardCreate is not idempotent, so a retry
   * on top of a partial success would mint a second live card.
   */
  const data = await queryShop<GiftCardPayload>(
    merchantId,
    GIFT_CARD_CREATE,
    {
      input: {
        initialValue: amount.toFixed(2),
        ...(customerId ? { customerId } : {}),
        note: `Return ${request.reference}`,
      },
    },
  );

  const errors = data.giftCardCreate.userErrors;
  if (errors.length > 0) {
    throw new AppError(
      422,
      "GIFT_CARD_FAILED",
      `Shopify rejected the gift card: ${errors.map((e) => e.message).join("; ")}`,
    );
  }

  const card = data.giftCardCreate.giftCard;
  const code = data.giftCardCreate.giftCardCode;
  if (!card || !code) {
    throw new AppError(
      502,
      "GIFT_CARD_FAILED",
      "Shopify created no gift card, or returned no code.",
    );
  }

  logger.info(
    { merchantId, returnRequestId, giftCardId: card.id },
    "Gift card issued in Shopify",
  );

  return {
    giftCardId: card.id,
    code,
    maskedCode: card.maskedCode,
    amount: parseFloat(card.balance.amount),
    currency: card.balance.currencyCode,
    expiresOn: card.expiresOn,
  };
};
