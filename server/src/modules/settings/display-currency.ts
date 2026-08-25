import type { DisplayCurrency } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * The merchant's chosen display currency, cached briefly.
 *
 * Every serialized response needs it, so reading it from the database on each
 * one would add a query per request for a value that changes about once. The
 * TTL is short enough that toggling the setting takes effect on the next page
 * load rather than needing a restart.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { value: DisplayCurrency; expires: number }>();

export const resolveDisplayMode = async (
  merchantId: string,
): Promise<DisplayCurrency> => {
  const hit = cache.get(merchantId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { displayCurrency: true },
  });
  const value = merchant?.displayCurrency ?? "SHOP";
  cache.set(merchantId, { value, expires: Date.now() + TTL_MS });
  return value;
};

/** Called when the setting changes, so the change is visible immediately. */
export const clearDisplayModeCache = (merchantId: string): void => {
  cache.delete(merchantId);
};
