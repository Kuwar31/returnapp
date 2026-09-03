import type { Dict } from "../i18n";
import { ar } from "./ar";
import { da } from "./da";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { ja } from "./ja";
import { nl } from "./nl";
import { pl } from "./pl";
import { pt } from "./pt";
import { sv } from "./sv";
import { zh } from "./zh";

/**
 * Every translation, keyed by locale. English isn't here: it's the source the
 * others fall back to, so listing it as an override of itself would let the
 * two drift.
 *
 * Adding a language is a file and a line — here and in LOCALES — and no change
 * to any component.
 */
export const CATALOGUES: Record<string, Dict | undefined> = {
  ar,
  da,
  de,
  es,
  fr,
  it,
  ja,
  nl,
  pl,
  pt,
  sv,
  zh,
};
