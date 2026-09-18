/**
 * What a redacted record's email becomes when a customer asks to be forgotten
 * (Shopify's customers/redact webhook).
 *
 * Not null: the column is required, and rows are looked up by email in several
 * places. A recognisable placeholder also makes it obvious in the admin that
 * the person asked to be forgotten, rather than looking like corrupt data.
 *
 * It is public — this repository is — so it must never work as a credential:
 * every place that accepts an email as proof of an order or a return checks
 * `isRedacted` first, or the placeholder would open the very records it was
 * meant to close.
 */
export const REDACTED_EMAIL = "redacted@removed.invalid";

export const isRedacted = (email: string | null | undefined): boolean =>
  typeof email === "string" && email.toLowerCase() === REDACTED_EMAIL;
