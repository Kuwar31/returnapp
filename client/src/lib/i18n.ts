import { en } from "./locales/en";
import { CATALOGUES } from "./locales";

/**
 * The languages the portal speaks.
 *
 * `label` is the language's own name, because a merchant scanning a dropdown
 * for their market recognises "Deutsch" faster than "German" — and a shopper
 * shown the list would recognise nothing else. `english` sits beside it for
 * anyone configuring a market they don't themselves speak.
 */
export interface LocaleOption {
  code: string;
  label: string;
  english: string;
  dir: "ltr" | "rtl";
}

const ALL_LOCALES: LocaleOption[] = [
  { code: "en", label: "English", english: "English", dir: "ltr" },
  { code: "fr", label: "Français", english: "French", dir: "ltr" },
  { code: "de", label: "Deutsch", english: "German", dir: "ltr" },
  { code: "es", label: "Español", english: "Spanish", dir: "ltr" },
  { code: "it", label: "Italiano", english: "Italian", dir: "ltr" },
  { code: "pt", label: "Português", english: "Portuguese", dir: "ltr" },
  { code: "nl", label: "Nederlands", english: "Dutch", dir: "ltr" },
  { code: "sv", label: "Svenska", english: "Swedish", dir: "ltr" },
  { code: "da", label: "Dansk", english: "Danish", dir: "ltr" },
  { code: "pl", label: "Polski", english: "Polish", dir: "ltr" },
  { code: "ja", label: "日本語", english: "Japanese", dir: "ltr" },
  { code: "zh", label: "简体中文", english: "Chinese (Simplified)", dir: "ltr" },
  { code: "ar", label: "العربية", english: "Arabic", dir: "rtl" },
];

/**
 * Only the languages actually finished.
 *
 * Missing keys fall through to English, which is the right behaviour for a
 * string added after a translation was written — but it would be the wrong
 * thing to build a dropdown on: offering "Svenska" and then showing a Swedish
 * shopper an English portal is a worse failure than not offering it. So the
 * list a merchant chooses from is derived from the catalogues themselves, and
 * a language appears the moment its file is filled in.
 *
 * The threshold is generous rather than exact so that adding one English key
 * doesn't withdraw twelve languages until each is caught up.
 */
const REQUIRED_COVERAGE = 0.9;
const totalKeys = Object.keys(en).length;

export const LOCALES: LocaleOption[] = ALL_LOCALES.filter(
  (l) =>
    l.code === "en" ||
    Object.keys(CATALOGUES[l.code] ?? {}).length >= totalKeys * REQUIRED_COVERAGE,
);

const byCode = new Map(ALL_LOCALES.map((l) => [l.code, l]));

export const localeDir = (code: string): "ltr" | "rtl" =>
  byCode.get(code)?.dir ?? "ltr";

export type Key = keyof typeof en;

/**
 * The plural categories CLDR defines. English uses two of them, so the English
 * catalogue only ever declares `_one` and `_other` — but Polish needs `_few`
 * and `_many`, and Arabic all six. A translation has to be able to say more
 * than its source did.
 */
type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/**
 * A translation: any English key, plus whichever plural forms that language
 * actually inflects. Still closed rather than `Record<string, string>`, so a
 * mistyped key is caught here instead of silently falling back to English at
 * runtime — which is exactly the failure that would be hardest to notice.
 */
export type Dict = Partial<
  Record<Key | `${PluralKeyOf<Key>}_${PluralCategory}`, string>
>;

type PluralKeyOf<K> = K extends `${infer Base}_one` ? Base : never;

/**
 * The base of a plural key — "picker.selected" for the pair
 * "picker.selected_one" / "picker.selected_other".
 *
 * Derived from the catalogue rather than declared, so a plural added there is
 * immediately callable and one removed is immediately a compile error at the
 * call site.
 */
/**
 * Written through a generic so the conditional distributes over the union.
 * Applied to the alias directly it checks the whole union at once, matches
 * nothing, and quietly resolves to `never` — which types every call site as an
 * error with no clue why.
 */
export type PluralKey = PluralKeyOf<Key>;

/**
 * One string, in the portal's language.
 *
 * Falls through to English for anything a translation hasn't caught up with,
 * rather than showing the key or an empty space: a shopper reading one English
 * sentence in an otherwise French page can still finish their return, which is
 * not true of "review.summary.title".
 *
 * `{name}` placeholders are filled from `vars`. Interpolation happens after
 * lookup so a translator can move a placeholder to wherever their language
 * needs it, which is most of the reason to have placeholders at all.
 */
export const translate = (
  locale: string,
  key: Key,
  vars?: Record<string, string | number>,
): string => {
  const dict = CATALOGUES[locale];
  const template = dict?.[key] ?? en[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
};

/**
 * The plural-aware form of the same thing.
 *
 * Keys are suffixed with the CLDR category — `_one`, `_other`, and `_few` or
 * `_many` where a language needs them — and `Intl.PluralRules` picks. Doing it
 * this way rather than with an `n === 1` ternary is the difference between
 * working in Polish and not: it has three plural forms, and Arabic has six.
 */
export const translatePlural = (
  locale: string,
  key: PluralKey,
  count: number,
  vars?: Record<string, string | number>,
): string => {
  let category: string;
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  const dict = CATALOGUES[locale];
  const candidates = [`${key}_${category}`, `${key}_other`, `${key}_one`];
  for (const candidate of candidates) {
    const value = dict?.[candidate as Key] ?? en[candidate as Key];
    if (value) {
      return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name === "count"
          ? String(count)
          : vars && name in vars
            ? String(vars[name])
            : whole,
      );
    }
  }
  return String(count);
};

export type TranslateFn = {
  (key: Key, vars?: Record<string, string | number>): string;
  plural: (
    key: PluralKey,
    count: number,
    vars?: Record<string, string | number>,
  ) => string;
  locale: string;
};

/**
 * The locale the portal is currently rendering in.
 *
 * A module-level value because route actions and loaders run outside the React
 * tree and so can't reach a hook — and those are exactly where the lookup
 * failures a shopper is most likely to see are worded. PortalLayout sets it
 * before anything can be submitted.
 */
let activeLocale = "en";

export const setActiveLocale = (code: string) => {
  activeLocale = code;
};

/** For code outside a component. Inside one, prefer the hook. */
export const at = (
  key: Key,
  vars?: Record<string, string | number>,
): string => translate(activeLocale, key, vars);

/** Binds a locale once, so components call `t("key")` and nothing else. */
export const makeTranslator = (locale: string): TranslateFn => {
  const t = ((key, vars) => translate(locale, key, vars)) as TranslateFn;
  t.plural = (key, count, vars) => translatePlural(locale, key, count, vars);
  t.locale = locale;
  return t;
};
