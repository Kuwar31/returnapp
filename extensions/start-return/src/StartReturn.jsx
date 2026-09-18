import "@shopify/ui-extensions/preact";
import { render } from "preact";

/**
 * The "Start a return" button in the order action menu.
 *
 * Decided before the first render rather than after, as Shopify asks for
 * this target: the menu shouldn't flash a button that then disappears. The
 * order's name, whether anything has shipped, and the shopper's email all
 * come from the Customer Account API; the store's address from the
 * Storefront API, unless the merchant gave a portal address in settings.
 *
 * The link carries the order number and email so the portal can do the
 * lookup itself and land the shopper on their items — which is all the
 * portal ever asks for, so nothing here grants access the shopper lacks.
 */

const API = "2026-04";

const post = async (url, query, variables) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const { data, errors } = await response.json();
  // Said out loud: a missing scope is the usual reason, and the console is where a merchant's developer looks first.
  if (errors?.length) console.warn("Start a return:", errors.map((e) => e.message).join("; "));
  return data ?? null;
};

/** The order and the person, or null when the order can't be returned yet. */
const loadOrder = async () => {
  const data = await post(
    `shopify://customer-account/api/${API}/graphql.json`,
    `query StartReturn($orderId: ID!) {
      order(id: $orderId) {
        name
        cancelledAt
        fulfillments(first: 1) { nodes { id } }
      }
      customer { emailAddress { emailAddress } }
    }`,
    { orderId: shopify.orderId },
  );
  const order = data?.order;
  if (!order || order.cancelledAt || order.fulfillments.nodes.length === 0) return null;
  return {
    orderNumber: String(order.name ?? "").replace(/^#/, ""),
    email: data?.customer?.emailAddress?.emailAddress ?? "",
  };
};

/** Where the portal lives: the merchant's setting, else the store's own /apps/returns. */
const loadPortalUrl = async () => {
  const configured = shopify.settings?.value?.portal_url;
  if (typeof configured === "string" && configured.trim()) return configured.trim().replace(/\/+$/, "");
  try {
    const data = await post(
      `shopify://storefront/api/${API}/graphql.json`,
      `query StoreAddress { shop { primaryDomain { url } } }`,
      {},
    );
    const origin = data?.shop?.primaryDomain?.url;
    if (typeof origin === "string" && origin) return `${origin.replace(/\/+$/, "")}/apps/returns`;
  } catch {
    // Fall through: without an address there is nothing to link to.
  }
  return null;
};

export default async () => {
  let href = null;
  try {
    const [order, portal] = await Promise.all([loadOrder(), loadPortalUrl()]);
    if (order && portal) {
      const url = new URL(portal);
      url.searchParams.set("order", order.orderNumber);
      if (order.email) url.searchParams.set("email", order.email);
      href = url.toString();
    }
  } catch (error) {
    console.error("Start a return: couldn't prepare the link", error);
  }
  if (!href) console.warn("Start a return: no button — the order isn't fulfilled, or the order or store address couldn't be read.");
  const label = String(shopify.settings?.value?.label ?? "").trim() || "Start a return";
  render(<StartReturn href={href} label={label} />, document.body);
};

function StartReturn({ href, label }) {
  // Nothing shipped yet, or nothing to link to: no button, as Shopify's own returns behave.
  if (!href) return null;
  return <s-button href={href}>{label}</s-button>;
}
