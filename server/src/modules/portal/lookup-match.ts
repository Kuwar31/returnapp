import type { LookupCriterion } from "@prisma/client";

/**
 * How a shopper proves an order is theirs, against what the order holds.
 *
 * Pure functions: the routes decide *which* of these a store allows, and
 * `lookupOrder` fetches what they compare against. Everything here is the
 * comparison itself, kept apart so the normalisation rules — the only part
 * with any judgement in it — can be read and tested on their own.
 */

/** The order the portal lists them in, whatever order the merchant ticked. */
export const CRITERION_ORDER: LookupCriterion[] = ["EMAIL", "ZIP", "PHONE"];

/** Canonical order, duplicates dropped. */
export const normalizeCriteria = (
  criteria: readonly LookupCriterion[],
): LookupCriterion[] => CRITERION_ORDER.filter((c) => criteria.includes(c));

export const emailMatches = (
  stored: string | null | undefined,
  typed: string,
): boolean =>
  Boolean(stored) && stored!.trim().toLowerCase() === typed.trim().toLowerCase();

/** Case and spacing are how postcodes get written differently, not what they are. */
export const normalizeZip = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const zipMatches = (
  stored: string | null | undefined,
  typed: string,
): boolean => {
  if (!stored) return false;
  const a = normalizeZip(stored);
  const b = normalizeZip(typed);
  if (!a || !b) return false;
  if (a === b) return true;
  /**
   * A US ZIP+4 on the order against the five digits everyone actually knows.
   * That direction only, and only when both are purely numeric, so a typed
   * "1234" can't stand in for "12345".
   */
  return /^\d{9}$/.test(a) && /^\d{5}$/.test(b) && a.startsWith(b);
};

/**
 * Digits only, minus an international dial-out prefix: "+1 (415) 555-0100",
 * "1-415-555-0100" and "00 1 415 555 0100" are one number.
 */
export const normalizePhone = (value: string): string =>
  value.replace(/\D/g, "").replace(/^00/, "");

/**
 * Enough that a shopper's local number still matches, not so few that a
 * guess would.
 */
const MIN_PHONE_DIGITS = 7;

/**
 * A number with and without its trunk prefix.
 *
 * Most national formats outside North America start with a 0 that the
 * international form drops — "020 7946 0958" is "+44 20 7946 0958" — so a
 * shopper typing the number as they'd dial it at home has one digit Shopify's
 * copy doesn't. Both shapes are tried rather than guessing which the store's
 * country uses.
 */
const withoutTrunk = (digits: string): string[] =>
  digits.startsWith("0") ? [digits, digits.slice(1)] : [digits];

/**
 * Phone numbers rarely arrive twice in the same shape: Shopify holds what
 * checkout produced, usually E.164, and the shopper types what's on their
 * phone. Comparing from the end handles a country code present on one side
 * and not the other, in either direction.
 */
export const phoneMatches = (
  stored: string | null | undefined,
  typed: string,
): boolean => {
  if (!stored) return false;
  for (const a of withoutTrunk(normalizePhone(stored))) {
    for (const b of withoutTrunk(normalizePhone(typed))) {
      if (a.length < MIN_PHONE_DIGITS || b.length < MIN_PHONE_DIGITS) continue;
      if (a.endsWith(b) || b.endsWith(a)) return true;
    }
  }
  return false;
};

/** The postcode off an address as either Shopify shape stores it. */
export const addressZip = (address: unknown): string | null => {
  if (!address || typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  for (const key of ["zip", "postalCode", "postal_code"]) {
    const value = a[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

export interface LookupSubject {
  email: string;
  phone: string | null;
  shippingAddress: unknown;
}

export const matchesCriterion = (
  order: LookupSubject,
  criterion: LookupCriterion,
  typed: string,
): boolean => {
  switch (criterion) {
    case "EMAIL":
      return emailMatches(order.email, typed);
    case "ZIP":
      return zipMatches(addressZip(order.shippingAddress), typed);
    case "PHONE":
      return phoneMatches(order.phone, typed);
  }
};
