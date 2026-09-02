import { Prisma } from "@prisma/client";
import type {
  BonusType,
  DisplayCurrency,
  ExchangeMethod,
  VariantExchangeDifference,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * The merchant's display and exchange settings, cached briefly.
 *
 * Both are read on paths that run per request — every serialized response needs
 * the display currency, and every approval needs the exchange method — so
 * reading them from the database each time would add a query apiece for values
 * that change about once. One cache entry covers both because they come from
 * the same row: fetching them separately meant two queries to answer one
 * question.
 *
 * The TTL is short enough that changing a setting takes effect on the next page
 * load rather than needing a restart, and the settings route clears the entry
 * outright so the merchant sees their own change immediately.
 */
const TTL_MS = 30_000;

interface MerchantSettings {
  displayCurrency: DisplayCurrency;
  exchangeMethod: ExchangeMethod;
  variantExchangeDifference: VariantExchangeDifference;
  /** The sweetener for exchanging; null means "use the policy percentage". */
  exchangeBonus: { type: BonusType; value: Prisma.Decimal } | null;
  /** The sweetener for spending a return in the catalogue. */
  shopNowBonus: { type: BonusType; value: Prisma.Decimal };
}

const DEFAULTS: MerchantSettings = {
  displayCurrency: "SHOP",
  exchangeMethod: "DRAFT_ORDER",
  // What the app did before the setting existed, so nothing changes for a
  // store that never opens the page.
  variantExchangeDifference: "CHARGE",
  exchangeBonus: null,
  shopNowBonus: { type: "FIXED", value: new Prisma.Decimal(0) },
};

const cache = new Map<string, { value: MerchantSettings; expires: number }>();

export const getMerchantSettings = async (
  merchantId: string,
): Promise<MerchantSettings> => {
  const hit = cache.get(merchantId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      displayCurrency: true,
      exchangeMethod: true,
      variantExchangeDifference: true,
      exchangeBonusType: true,
      exchangeBonusValue: true,
      shopNowBonusType: true,
      shopNowBonusAmount: true,
    },
  });
  const value: MerchantSettings = {
    displayCurrency: merchant?.displayCurrency ?? DEFAULTS.displayCurrency,
    exchangeMethod: merchant?.exchangeMethod ?? DEFAULTS.exchangeMethod,
    variantExchangeDifference:
      merchant?.variantExchangeDifference ??
      DEFAULTS.variantExchangeDifference,
    // Null value, not null column: an unset bonus falls back to the policy's
    // percentage rather than silently paying nothing.
    exchangeBonus:
      merchant?.exchangeBonusValue == null
        ? null
        : {
            type: merchant.exchangeBonusType,
            value: merchant.exchangeBonusValue,
          },
    shopNowBonus: {
      type: merchant?.shopNowBonusType ?? "FIXED",
      value: merchant?.shopNowBonusAmount ?? new Prisma.Decimal(0),
    },
  };
  cache.set(merchantId, { value, expires: Date.now() + TTL_MS });
  return value;
};

/** Which currency to render figures in. */
export const resolveDisplayMode = async (
  merchantId: string,
): Promise<DisplayCurrency> => (await getMerchantSettings(merchantId)).displayCurrency;

/** Which mechanism creates the replacement for an exchange. */
export const resolveExchangeMethod = async (
  merchantId: string,
): Promise<ExchangeMethod> => (await getMerchantSettings(merchantId)).exchangeMethod;

/** How a size swap's price gap is settled. */
export const resolveVariantDifference = async (
  merchantId: string,
): Promise<VariantExchangeDifference> =>
  (await getMerchantSettings(merchantId)).variantExchangeDifference;

/** The sweetener for exchanging, or null to use the policy's percentage. */
export const resolveExchangeBonus = async (merchantId: string) =>
  (await getMerchantSettings(merchantId)).exchangeBonus ?? undefined;

/** The sweetener for spending a return in the catalogue. */
export const resolveShopNowBonus = async (merchantId: string) =>
  (await getMerchantSettings(merchantId)).shopNowBonus;

/** Called when any of these change, so the change is visible immediately. */
export const clearMerchantSettingsCache = (merchantId: string): void => {
  cache.delete(merchantId);
};
