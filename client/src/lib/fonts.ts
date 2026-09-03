/**
 * The typefaces a merchant can choose for their portal.
 *
 * Deliberately short. Every entry is either already on the device or a Google
 * font we load on demand — a longer list would mostly be names that silently
 * fall back to something else on half the machines that open the page, which
 * looks like a bug rather than a choice.
 */
export interface FontOption {
  key: string;
  label: string;
  stack: string;
  /** Fetched from Google Fonts when chosen; the rest need no network. */
  google?: string;
}

export const FONTS: FontOption[] = [
  {
    key: "SYSTEM",
    label: "System default",
    stack:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  {
    key: "HELVETICA",
    label: "Helvetica",
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  { key: "VERDANA", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { key: "GEORGIA", label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { key: "TIMES", label: "Times", stack: "'Times New Roman', Times, serif" },
  {
    key: "COURIER",
    label: "Courier",
    stack: "'Courier New', Courier, monospace",
  },
  {
    key: "INTER",
    label: "Inter",
    stack: "Inter, -apple-system, sans-serif",
    google: "Inter:wght@400;500;600;700",
  },
  {
    key: "POPPINS",
    label: "Poppins",
    stack: "Poppins, -apple-system, sans-serif",
    google: "Poppins:wght@400;500;600;700",
  },
  {
    key: "DM_SANS",
    label: "DM Sans",
    stack: "'DM Sans', -apple-system, sans-serif",
    google: "DM+Sans:wght@400;500;700",
  },
  {
    key: "PLAYFAIR",
    label: "Playfair Display",
    stack: "'Playfair Display', Georgia, serif",
    google: "Playfair+Display:wght@400;600;700",
  },
];

export const FONT_KEYS = FONTS.map((f) => f.key);

const byKey = new Map(FONTS.map((f) => [f.key, f]));

export const fontStack = (key: string | null | undefined): string =>
  byKey.get(key ?? "SYSTEM")?.stack ?? FONTS[0].stack;

/**
 * Loads the Google fonts among the given choices, once each.
 *
 * A link element rather than an @import so it can be added after the app has
 * booted, and keyed by href so choosing the same face for headings and body
 * doesn't request it twice.
 */
export const ensureFontsLoaded = (keys: Array<string | null | undefined>) => {
  if (typeof document === "undefined") return;
  const families = [
    ...new Set(
      keys
        .map((k) => byKey.get(k ?? "")?.google)
        .filter((g): g is string => Boolean(g)),
    ),
  ];
  for (const family of families) {
    const href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
};

/** Radius in px for each named step, so the portal and its preview agree. */
export const RADIUS_PX: Record<string, string> = {
  SHARP: "0px",
  CURVED: "14px",
  ROUNDED: "26px",
};
