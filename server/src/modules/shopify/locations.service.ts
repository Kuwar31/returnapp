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
}

const LOCATIONS = `#graphql
  query RestockLocations {
    locations(first: 50, includeInactive: false) {
      nodes { id name isActive fulfillsOnlineOrders }
    }
  }
`;

/** Active locations, the ones that fulfil online orders first. */
export const listLocations = async (
  merchantId: string,
): Promise<ShopLocation[]> => {
  const data = await queryShop<{
    locations: { nodes: Array<ShopLocation & { isActive: boolean }> };
  }>(merchantId, LOCATIONS);
  return data.locations.nodes
    .filter((l) => l.isActive)
    .map(({ id, name, fulfillsOnlineOrders }) => ({ id, name, fulfillsOnlineOrders }))
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
