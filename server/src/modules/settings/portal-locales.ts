/**
 * The languages the portal has translations for.
 *
 * Mirrors LOCALES in client/src/lib/i18n.ts, which holds the names and the
 * writing direction. Only the codes live here, because the server's one job
 * with them is to refuse a language the portal couldn't render — a stored
 * "sw" would leave a Swahili shop reading English with no sign of why.
 */
export const LOCALE_CODES = [
  "en",
  "fr",
  "de",
  "es",
  "it",
  "pt",
  "nl",
  "sv",
  "da",
  "pl",
  "ja",
  "zh",
  "ar",
] as const;
