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

/** Where to send someone back to after they've already submitted this order. */
export interface SubmittedReturn {
  reference: string;
  email: string;
  /** When it was submitted, so a forgotten breadcrumb can be aged out. */
  at?: string;
}

const submittedKey = (orderId: string) => `returns.submitted.${orderId}`;

/**
 * How long a "you have a return in progress" pointer is worth keeping. Long
 * enough to outlast any return's journey, short enough that a device doesn't
 * carry a pointer to something settled last winter.
 */
const SUBMITTED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Remembers the return just created for an order.
 *
 * localStorage rather than sessionStorage, deliberately: sessionStorage dies
 * with the tab, which is precisely the case this exists for — a shopper who
 * closes the page and comes back later, or who is sent off to Shopify's
 * checkout for an upsell. Without it they land on the item picker with their
 * own items greyed out as "already returned", which reads like a failure.
 *
 * The reference and the email are the shopper's own, on the shopper's own
 * device, and are the same pair their confirmation email carries.
 */
export const rememberSubmitted = (
  orderId: string,
  submitted: SubmittedReturn,
): void => {
  try {
    localStorage.setItem(
      submittedKey(orderId),
      JSON.stringify({ ...submitted, at: submitted.at ?? new Date().toISOString() }),
    );
  } catch {
    /* the shopper just doesn't get the shortcut back */
  }
};

export const loadSubmitted = (orderId: string): SubmittedReturn | null => {
  const read = (store: Storage) => {
    try {
      const raw = store.getItem(submittedKey(orderId));
      return raw ? (JSON.parse(raw) as SubmittedReturn) : null;
    } catch {
      return null;
    }
  };

  // sessionStorage is read as a fallback so anyone mid-flow when this moved
  // isn't stranded on the picker with no way back to their own return.
  const found = read(localStorage) ?? read(sessionStorage);
  if (!found?.reference) return null;

  if (found.at && Date.now() - Date.parse(found.at) > SUBMITTED_TTL_MS) {
    try {
      localStorage.removeItem(submittedKey(orderId));
    } catch {
      /* nothing to clean up */
    }
    return null;
  }
  return found;
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
 * The same selections, with everything not already swapped marked as an
 * exchange so its value funds the basket.
 *
 * A line the shopper has already exchanged for something specific keeps that
 * choice: they picked a size, and the basket is being paid for by the *other*
 * items. Rewriting those too was what let a swapped item's price leak into the
 * credit on offer — the shopper was shown money they had already spent.
 *
 * A basket can't be bought with a refund, so every remaining line becomes an
 * exchange here rather than asking the shopper to re-pick each one: the choice
 * stays where they made it, once, on the offer.
 */
export const toShopSelections = (draft: Draft) =>
  toSelections(draft).map((selection) =>
    "exchange" in selection
      ? selection
      : { ...selection, resolution: "EXCHANGE" as const },
  );

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

/**
 * The "shop now" basket.
 *
 * Kept apart from the returned-items draft rather than folded into it: a
 * basket belongs to the return as a whole, while every entry in `Draft` is one
 * returned article with its own reason and resolution. Storing a pooled thing
 * inside a per-article map would mean inventing an article to hang it on.
 */
export interface CartLine {
  variantId: string;
  quantity: number;
  /** Display only — the server reprices everything from Shopify on submit. */
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  price: number;
  currency: string;
}

const cartKey = (orderId: string) => `returns.cart.${orderId}`;

export const loadCart = (orderId: string): CartLine[] => {
  try {
    const raw = sessionStorage.getItem(cartKey(orderId));
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
};

export const saveCart = (orderId: string, cart: CartLine[]): void => {
  try {
    sessionStorage.setItem(cartKey(orderId), JSON.stringify(cart));
  } catch {
    /* private browsing; the basket just won't survive a reload */
  }
};

export const clearCart = (orderId: string): void => {
  try {
    sessionStorage.removeItem(cartKey(orderId));
  } catch {
    /* nothing to clean up */
  }
};

/** What the basket costs, for the running total on the shop screen. */
export const cartTotal = (cart: CartLine[]): number =>
  Math.round(cart.reduce((sum, l) => sum + l.price * l.quantity, 0) * 100) / 100;
