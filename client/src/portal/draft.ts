import type { ItemDecision } from "./ItemDrawer";

/**
 * The in-progress return, held between the item page and the review page.
 *
 * sessionStorage rather than router state so a refresh on the review page
 * doesn't discard everything the shopper just chose. Scoped per order, and
 * cleared on submit, so a second return never inherits the first one's picks.
 */
const key = (orderId: string) => `returns.draft.${orderId}`;

/**
 * Keyed by *article*, not by order line: `<lineId>#<n>`.
 *
 * Three of the same product are three separate keys, because each unit carries
 * its own reason and its own resolution — one damaged, one the wrong size.
 */
export type Draft = Record<string, ItemDecision>;

/** The article key for the nth unit of a line. */
export const articleKey = (lineId: string, index: number) =>
  `${lineId}#${index}`;

/** The order line an article key belongs to. */
export const lineIdOf = (key: string) => key.split("#")[0];

export const saveDraft = (orderId: string, draft: Draft): void => {
  try {
    sessionStorage.setItem(key(orderId), JSON.stringify(draft));
  } catch {
    // Private browsing can refuse storage; the flow still works forwards, the
    // shopper just loses their picks if they reload.
  }
};

export const loadDraft = (orderId: string): Draft => {
  try {
    const raw = sessionStorage.getItem(key(orderId));
    return raw ? (JSON.parse(raw) as Draft) : {};
  } catch {
    return {};
  }
};

/**
 * The stored exchange price, but only when it's in the currency being rendered.
 *
 * A draft survives reloads and setting changes, so its price can be in a
 * currency the page is no longer showing. Returning null then makes the label
 * disappear, which is honest — the quote alongside it is always current and
 * still tells the shopper what they'll pay. Relabelling it instead is how an
 * unconverted "₹100.00" ended up under a converted "₹11,172.00".
 */
export const exchangePriceIn = (
  decision: { exchangePrice: number | null; exchangeCurrency?: string | null },
  currency: string,
): number | null => {
  if (decision.exchangePrice === null) return null;
  // Drafts written before the currency was stamped carry no claim about it;
  // trusting them is what this guard exists to prevent.
  if (decision.exchangeCurrency !== currency) return null;
  return decision.exchangePrice;
};

export const clearDraft = (orderId: string): void => {
  try {
    sessionStorage.removeItem(key(orderId));
  } catch {
    /* nothing to clean up */
  }
};

/**
 * Turns stored decisions into the payload the API expects.
 *
 * One entry per article. The same `orderLineItemId` appearing several times is
 * expected, not a bug — the server counts them against what's returnable.
 */
export const toSelections = (draft: Draft) =>
  Object.entries(draft).map(([key, d]) => ({
    orderLineItemId: lineIdOf(key),
    reasonId: d.reasonId,
    reasonNote: d.reasonNote || undefined,
    photoUrls: [] as string[],
    resolution: d.resolution,
    ...(d.exchangeVariantId
      ? { exchange: { variantId: d.exchangeVariantId, quantity: 1 } }
      : {}),
  }));
