/**
 * Which locale numbers and dates are formatted in.
 *
 * A module-level value set once by PortalLayout, rather than a parameter on
 * every call: `money()` is used in perhaps sixty places across the portal, and
 * threading a locale through all of them would mean sixty chances to forget —
 * with the failure being a French shopper reading "$1,234.56" where their own
 * conventions say "1 234,56 $". The admin never sets it, so it stays "en-US"
 * there, which is what it has always been.
 */
let formatLocale = "en-US";

export const setFormatLocale = (locale: string) => {
  formatLocale = locale || "en-US";
};

export const money = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(formatLocale, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

export const shortDate = (value: string | Date): string =>
  new Date(value).toLocaleDateString(formatLocale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export const dateTime = (value: string | Date): string =>
  new Date(value).toLocaleString(formatLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
