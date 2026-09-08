import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { queryShop } from "./shopify.client.js";

/**
 * The places a store keeps stock, as Shopify lists them.
 *
 * Restocking has to name one — Shopify won't infer it — so these feed the
 * default-location setting and the per-item menu on a return.
 */
export interface ShopLocation {
  id: string;
  name: string;
  /** Whether online orders ship from here; the primary location when unset. */
  fulfillsOnlineOrders: boolean;
  /**
   * The postal address on one line, for choosing a return destination and
   * for telling a shopper where to send the parcel. Null when Shopify holds
   * no street address for the location.
   */
  address: string | null;
}

const LOCATIONS = `#graphql
  query RestockLocations {
    locations(first: 50, includeInactive: false) {
      nodes {
        id name isActive fulfillsOnlineOrders
        address { address1 address2 city provinceCode zip country }
      }
    }
  }
`;

interface LocationNode {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
  } | null;
}

/** "1 Oxford Street, Dublin, D02 XA32, Ireland" — or null with no street. */
const oneLine = (address: LocationNode["address"]): string | null => {
  if (!address?.address1) return null;
  return [
    address.address1,
    address.address2,
    [address.city, address.provinceCode].filter(Boolean).join(" "),
    address.zip,
    address.country,
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
};

/** Active locations, the ones that fulfil online orders first. */
export const listLocations = async (
  merchantId: string,
): Promise<ShopLocation[]> => {
  const data = await queryShop<{ locations: { nodes: LocationNode[] } }>(
    merchantId,
    LOCATIONS,
  );
  return data.locations.nodes
    .filter((l) => l.isActive)
    .map(({ id, name, fulfillsOnlineOrders, address }) => ({
      id,
      name,
      fulfillsOnlineOrders,
      address: oneLine(address),
    }))
    .sort(
      (a, b) =>
        Number(b.fulfillsOnlineOrders) - Number(a.fulfillsOnlineOrders) ||
        a.name.localeCompare(b.name),
    );
};

/**
 * Same, but a store that isn't connected gets an empty list rather than an
 * error: a settings page still has to render, and a menu that offers only
 * the default is all it can honestly promise.
 */
export const listLocationsIfConnected = async (
  merchantId: string,
): Promise<ShopLocation[]> => {
  try {
    return await listLocations(merchantId);
  } catch (error) {
    if (
      error instanceof AppError &&
      ["NOT_CONNECTED", "TOKEN_UNREADABLE", "SHOPIFY_UNAUTHORIZED"].includes(
        error.code,
      )
    ) {
      return [];
    }
    throw error;
  }
};

/**
 * Whether this store's token can read stock per location, which counting
 * exchange availability at chosen locations needs.
 *
 * Asked before the merchant chooses locations rather than discovered when a
 * shopper browses: a store connected before read_inventory was requested has
 * a token without it, and the only fix is reconnecting, which is the
 * merchant's to do. Null means access is fine.
 */
export const inventoryAccessProblem = async (
  merchantId: string,
): Promise<string | null> => {
  try {
    await queryShop(
      merchantId,
      `#graphql
        query InventoryAccessProbe {
          locations(first: 1) { nodes { id inventoryLevels(first: 1) { nodes { id } } } }
        }
      `,
    );
    return null;
  } catch (error) {
    const code = error instanceof AppError ? error.code : null;
    if (
      code === "NOT_CONNECTED" ||
      code === "TOKEN_UNREADABLE" ||
      code === "SHOPIFY_UNAUTHORIZED"
    ) {
      return "Connect your Shopify store to choose inventory locations.";
    }
    if (code === "SHOPIFY_GRAPHQL_ERROR") {
      return (
        "Your Shopify connection doesn't include inventory access yet. " +
        "Reconnect the store from Settings → General to grant it; until then " +
        "stock is counted across every location."
      );
    }
    logger.warn({ merchantId, error }, "Could not check inventory access");
    return "Shopify couldn't be reached to check inventory access. Try again in a moment.";
  }
};

/** The location that ships online orders, else the first there is. */
export const primaryLocationId = (
  locations: ShopLocation[],
): string | undefined =>
  (locations.find((l) => l.fulfillsOnlineOrders) ?? locations[0])?.id;

const FULFILLMENT_LOCATIONS = `#graphql
  query FulfillmentLocations($id: ID!) {
    order(id: $id) {
      fulfillments(first: 25) {
        location { id }
        fulfillmentLineItems(first: 100) { nodes { id } }
      }
    }
  }
`;

/**
 * Where each fulfilled line shipped from, keyed by FulfillmentLineItem id.
 *
 * "Put it back where it came from" is the default that needs no setup, and
 * the only one that is right for a store shipping from several warehouses.
 * Empty when Shopify can't be read; the caller falls back rather than fails.
 */
export const fulfillmentLocations = async (
  merchantId: string,
  orderExternalId: string,
): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  try {
    const data = await queryShop<{
      order: {
        fulfillments: Array<{
          location: { id: string } | null;
          fulfillmentLineItems: { nodes: Array<{ id: string }> };
        }>;
      } | null;
    }>(merchantId, FULFILLMENT_LOCATIONS, { id: orderExternalId });
    for (const fulfillment of data.order?.fulfillments ?? []) {
      if (!fulfillment.location) continue;
      for (const line of fulfillment.fulfillmentLineItems.nodes) {
        map.set(line.id, fulfillment.location.id);
      }
    }
  } catch (error) {
    logger.warn(
      { merchantId, orderExternalId, error },
      "Could not read where the order was fulfilled from",
    );
  }
  return map;
};
