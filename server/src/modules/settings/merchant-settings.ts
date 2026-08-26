import type { DisplayCurrency, ExchangeMethod } from "@prisma/client";
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
}

const DEFAULTS: MerchantSettings = {
  displayCurrency: "SHOP",
  exchangeMethod: "DRAFT_ORDER",
};

const cache = new Map<string, { value: MerchantSettings; expires: number }>();

export const getMerchantSettings = async (
  merchantId: string,
): Promise<MerchantSettings> => {
  const hit = cache.get(merchantId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { displayCurrency: true, exchangeMethod: true },
  });
  const value: MerchantSettings = {
    displayCurrency: merchant?.displayCurrency ?? DEFAULTS.displayCurrency,
    exchangeMethod: merchant?.exchangeMethod ?? DEFAULTS.exchangeMethod,
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

/** Called when either setting changes, so the change is visible immediately. */
export const clearMerchantSettingsCache = (merchantId: string): void => {
  cache.delete(merchantId);
};
