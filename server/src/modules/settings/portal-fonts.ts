/**
 * The font keys the portal knows how to render.
 *
 * Mirrors client/src/lib/fonts.ts, which holds the actual stacks and decides
 * which need loading from Google. Only the keys live here, because the server
 * has one job with them: refuse a value the portal couldn't render.
 */
export const FONT_KEYS = [
  "SYSTEM",
  "HELVETICA",
  "VERDANA",
  "GEORGIA",
  "TIMES",
  "COURIER",
  "INTER",
  "POPPINS",
  "DM_SANS",
  "PLAYFAIR",
] as const;
