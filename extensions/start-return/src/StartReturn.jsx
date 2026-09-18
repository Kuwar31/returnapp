import "@shopify/ui-extensions/preact";
import { render } from "preact";

/**
 * The "Start a return" button in the order action menu.
 *
 * Decided before the first render rather than after, as Shopify asks for
 * this target: the menu shouldn't flash a button that then disappears. The
 * button asks the returns app itself whether this order can be returned
 * and where to send the shopper, proving itself with Shopify's session
 * token. The app already mirrors the store's orders, so nothing has to be
 * read through Shopify's customer or storefront APIs from here.
 *
 * The link carries the order number and email, which is all the portal's
 * own lookup asks for, so the button grants nothing a shopper couldn't type.
 *
 * The JSX here must compile to Preact's runtime: tsconfig.json beside this
 * file says so. Without it the CLI's bundler reaches for React, which this
 * repo has installed for the admin, and Preact then fails to mount the
 * frozen React elements with "Cannot add property __, object is not
 * extensible" — silently, as far as the shopper is concerned: no button.
 */

/** Where the returns app runs. */
const API = "https://returnapp-yxkl.onrender.com";

const askApp = async () => {
  const token = await shopify.sessionToken.get();
  const response = await fetch(`${API}/api/shopify/start-return?order=${encodeURIComponent(shopify.orderId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    // The app says why in its body; that sentence is what a developer needs.
    let said = "";
    try {
      const body = await response.json();
      if (body && body.error && typeof body.error.message === "string") said = body.error.message;
    } catch {
      // A body that isn't JSON says nothing more than the status did.
    }
    throw new Error(`the returns app answered ${response.status}${said ? `: ${said}` : ""}`);
  }
  return response.json();
};

/** The merchant's own portal address, when they set one, with the same order and email on it. */
const withPortalSetting = (answer) => {
  const configured = shopify.settings?.value?.portal_url;
  if (typeof configured !== "string" || !configured.trim() || !answer.orderNumber) return answer.url;
  const url = new URL(configured.trim());
  url.searchParams.set("order", answer.orderNumber);
  if (answer.email) url.searchParams.set("email", answer.email);
  return url.toString();
};

export default async () => {
  let href = null;
  try {
    const answer = await askApp();
    href = answer.url ? withPortalSetting(answer) : null;
    if (!href) {
      // The reason is a code for the menu and, when the app has one, a sentence for the developer.
      const why = [answer.reason ?? "the order can't be returned", answer.detail].filter(Boolean).join(" — ");
      console.warn(`Start a return: no button — ${why}`);
    }
  } catch (error) {
    console.error("Start a return: couldn't reach the returns app", error);
  }
  const label = String(shopify.settings?.value?.label ?? "").trim() || "Start a return";
  // Rendered either way, as Shopify's own example for this target does; a component that returns nothing is how a menu item stays absent.
  render(<StartReturn href={href} label={label} />, document.body);
};

function StartReturn({ href, label }) {
  if (!href) return null;
  return <s-button href={href}>{label}</s-button>;
}
