import type { Key, TranslateFn } from "./i18n";
import type { LookupCriterion, PortalBranding } from "./types";

/**
 * The verification field on the lookup screen, worked out from what the
 * store allows.
 *
 * Shared by the portal and the admin's preview of it, so the merchant sees
 * the exact label their customers will — including how a choice of several
 * reads in the language they picked.
 */

type LookupCopy = Pick<
  PortalBranding,
  "lookupCriteria" | "emailLabel" | "zipLabel" | "phoneLabel"
>;

/** The order the field lists them in, whatever order the merchant ticked. */
const CRITERION_ORDER: LookupCriterion[] = ["EMAIL", "ZIP", "PHONE"];

/** How each one is called in a sentence, as opposed to over the field. */
const CRITERION_KEY: Record<LookupCriterion, Key> = {
  EMAIL: "lookup.criterion.email",
  ZIP: "lookup.criterion.zip",
  PHONE: "lookup.criterion.phone",
};

/**
 * Canonical order, and never empty: the server refuses a save with nothing
 * ticked, but the field still needs an answer if one ever reaches here.
 */
export const activeCriteria = (b: LookupCopy): LookupCriterion[] => {
  const on = CRITERION_ORDER.filter((c) => b.lookupCriteria.includes(c));
  return on.length ? on : ["EMAIL"];
};

const criterionLabel = (b: LookupCopy, c: LookupCriterion): string =>
  c === "EMAIL" ? b.emailLabel : c === "ZIP" ? b.zipLabel : b.phoneLabel;

/**
 * "A, B or C" in the shopper's language. Intl.ListFormat knows each one's
 * conjunction and comma rules — "A、B、またはC", "A, B ou C" — and the fallback
 * is for a browser old enough to lack it, which gets slashes rather than an
 * English "or" dropped into another language.
 */
const disjunction = (locale: string, items: string[]): string => {
  try {
    return new Intl.ListFormat(locale, { type: "disjunction" }).format(items);
  } catch {
    return items.join(" / ");
  }
};

/** The label over the field: one label, or all of them offered as a choice. */
export const lookupFieldLabel = (b: LookupCopy, locale: string): string =>
  disjunction(
    locale,
    activeCriteria(b).map((c) => criterionLabel(b, c)),
  );

const criterionList = (
  criteria: LookupCriterion[],
  locale: string,
  t: TranslateFn,
): string =>
  disjunction(
    locale,
    criteria.map((c) => t(CRITERION_KEY[c])),
  );

/**
 * The sentence under the title. Email alone keeps the wording the portal has
 * always had — "the email you used at checkout" — since it says more than a
 * list of one would.
 */
export const lookupIntro = (
  b: LookupCopy,
  locale: string,
  t: TranslateFn,
): string => {
  const criteria = activeCriteria(b);
  if (criteria.length === 1 && criteria[0] === "EMAIL") return t("lookup.intro");
  return t("lookup.introBy", { field: criterionList(criteria, locale, t) });
};

/** What to say when the form was sent with a field empty. */
export const lookupMissingMessage = (
  b: LookupCopy,
  locale: string,
  t: TranslateFn,
): string => {
  const criteria = activeCriteria(b);
  if (criteria.length === 1 && criteria[0] === "EMAIL") {
    return t("lookup.error.missing");
  }
  return t("lookup.error.missingBy", {
    field: criterionList(criteria, locale, t),
  });
};

export interface LookupInputProps {
  type: "email" | "tel" | "text";
  autoComplete: string;
  placeholder?: string;
}

/**
 * The browser's own keyboard and autofill when there's one kind of answer;
 * plain text when there are several, since a `type="email"` field would
 * refuse a postcode before it ever reached the server.
 */
export const lookupInputProps = (
  b: LookupCopy,
  t: TranslateFn,
): LookupInputProps => {
  const criteria = activeCriteria(b);
  if (criteria.length > 1) return { type: "text", autoComplete: "off" };
  switch (criteria[0]) {
    case "EMAIL":
      return {
        type: "email",
        autoComplete: "email",
        placeholder: t("lookup.emailPlaceholder"),
      };
    case "ZIP":
      return {
        type: "text",
        autoComplete: "postal-code",
        placeholder: t("lookup.zipPlaceholder"),
      };
    case "PHONE":
      return {
        type: "tel",
        autoComplete: "tel",
        placeholder: t("lookup.phonePlaceholder"),
      };
  }
};
