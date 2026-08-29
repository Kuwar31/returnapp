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

/**
 * Names a chosen variant's options, e.g. "Size: 37".
 *
 * Shopify's variant title is only the value, so a single-option product reads
 * as a bare "3" wherever it is printed. Merchants type these names by hand, so
 * the first letter is raised; "Title" is Shopify's placeholder on products with
 * no real options and is dropped rather than shown.
 */
export const describeVariant = (
  options: Array<{ name: string; value: string }> | undefined | null,
  fallback: string | null,
): string | null => {
  const named = (options ?? [])
    .filter((o) => o?.name && o.name.toLowerCase() !== "title")
    .map((o) => `${o.name.charAt(0).toUpperCase()}${o.name.slice(1)}: ${o.value}`);
  if (named.length > 0) return named.join(" · ");
  /**
   * Options were present and every one was Shopify's "Title" placeholder, so
   * the product has none. The fallback is only for when options are unknown —
   * using it here prints "Default Title" as though the shopper chose it.
   */
  return options && options.length > 0 ? null : fallback;
};

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

/**
 * Fills in exchange display details a stored draft is missing.
 *
 * Drafts survive deploys, so one saved before a field existed carries no
 * picture and no split title — which is how a chosen replacement rendered as a
 * grey box next to a combined "Product · Variant" label. Rather than ask the
 * shopper to pick again, the page fetches what it lacks.
 *
 * Returns null when there is nothing to fill, so callers can skip the write
 * entirely and avoid a pointless re-render.
 */
export const hydrateExchangeDetails = async (
  draft: Draft,
  fetchInfo: (ids: string[]) => Promise<{
    currency: string;
    variants: Array<{
      id: string;
      title: string;
      variantTitle: string;
      imageUrl: string | null;
      price: number;
    }>;
  }>,
): Promise<Draft | null> => {
  const stale = Object.entries(draft).filter(
    ([, d]) => d.exchangeVariantId && !d.exchangeImageUrl,
  );
  if (stale.length === 0) return null;

  try {
    const info = await fetchInfo([
      ...new Set(stale.map(([, d]) => d.exchangeVariantId!)),
    ]);
    const byId = new Map(info.variants.map((v) => [v.id, v]));

    let changed = false;
    const next: Draft = { ...draft };
    for (const [key, decision] of stale) {
      const v = byId.get(decision.exchangeVariantId!);
      if (!v) continue;
      next[key] = {
        ...decision,
        exchangeImageUrl: v.imageUrl,
        exchangeProductTitle: v.title,
        exchangeVariantTitle: v.variantTitle,
        // Re-stamped together: a price without its currency is what made these
        // figures unreadable in the first place.
        exchangePrice: v.price,
        exchangeCurrency: info.currency,
      };
      changed = true;
    }
    return changed ? next : null;
  } catch {
    // Cosmetic. A failed top-up leaves the draft exactly as it was.
    return null;
  }
};
