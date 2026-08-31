/**
 * Shopify sends orders in two different shapes: webhooks are REST-style
 * snake_case, the Admin GraphQL API is camelCase with GIDs. Both are
 * normalized here so the persistence layer only sees one shape.
 */

export interface NormalizedLineItem {
  externalId: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  /// Drives which reason group the portal offers for this line.
  productType: string | null;
  title: string;
  variantTitle: string | null;
  /** Option axis and value, e.g. [{ name: "Size", value: "37" }]. */
  variantOptions?: Array<{ name: string; value: string }> | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
}

export interface NormalizedOrder {
  externalId: string;
  /** Shopify Customer GID; null for guest checkouts. */
  customerExternalId: string | null;
  orderNumber: string;
  email: string;
  customerName: string | null;
  currency: string;
  subtotal: number;
  total: number;
  /** What the customer was charged in, when it differs from shop currency. */
  presentmentCurrency: string | null;
  presentmentTotal: number | null;
  placedAt: Date;
  fulfilledAt: Date | null;
  deliveredAt: Date | null;
  shippingAddress: unknown;
  lineItems: NormalizedLineItem[];
}

const num = (value: unknown): number => {
  const parsed = typeof value === "string" ? parseFloat(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const date = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** "#1001" -> "1001"; the portal asks shoppers for the bare number. */
const stripHash = (name: string): string => name.replace(/^#/, "");

// --------------------------------------------------------------------------
// Webhook payloads (REST shape)
// --------------------------------------------------------------------------

interface WebhookLineItem {
  id: number;
  admin_graphql_api_id?: string;
  product_id?: number | null;
  variant_id?: number | null;
  sku?: string | null;
  product_type?: string | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  price?: string;
  total_discount?: string;
}

export interface WebhookOrder {
  id: number;
  admin_graphql_api_id?: string;
  name: string;
  email?: string | null;
  contact_email?: string | null;
  currency: string;
  subtotal_price?: string;
  total_price?: string;
  presentment_currency?: string | null;
  total_price_set?: {
    presentment_money?: { amount?: string; currency_code?: string } | null;
  } | null;
  created_at: string;
  processed_at?: string | null;
  cancelled_at?: string | null;
  customer?: {
    id?: number | null;
    admin_graphql_api_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
  shipping_address?: unknown;
  line_items?: WebhookLineItem[];
  fulfillments?: Array<{
    created_at?: string;
    updated_at?: string;
    status?: string | null;
    shipment_status?: string | null;
  }>;
}

export const mapWebhookOrder = (
  payload: WebhookOrder,
): NormalizedOrder | null => {
  const email = (payload.email ?? payload.contact_email ?? "").trim();
  // Without an email the shopper can never authenticate against this order,
  // so there's nothing useful we could do with it.
  if (!email) return null;

  const fulfillments = payload.fulfillments ?? [];
  const fulfilledAt = fulfillments.length
    ? date(fulfillments[0].created_at)
    : null;
  // Shopify reports delivery via shipment_status on the fulfillment.
  const delivered = fulfillments.find(
    (f) => f.shipment_status === "delivered",
  );
  const deliveredAt = delivered
    ? date(delivered.updated_at) ?? date(delivered.created_at)
    : null;

  const customerName = payload.customer
    ? [payload.customer.first_name, payload.customer.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || null
    : null;

  return {
    externalId:
      payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`,
    customerExternalId:
      payload.customer?.admin_graphql_api_id ??
      (payload.customer?.id
        ? `gid://shopify/Customer/${payload.customer.id}`
        : null),
    orderNumber: stripHash(payload.name),
    email: email.toLowerCase(),
    customerName,
    currency: payload.currency,
    subtotal: num(payload.subtotal_price),
    total: num(payload.total_price),
    presentmentCurrency:
      payload.total_price_set?.presentment_money?.currency_code ??
      payload.presentment_currency ??
      null,
    presentmentTotal: payload.total_price_set?.presentment_money?.amount
      ? num(payload.total_price_set.presentment_money.amount)
      : null,
    placedAt: date(payload.processed_at) ?? date(payload.created_at) ?? new Date(),
    fulfilledAt,
    deliveredAt,
    shippingAddress: payload.shipping_address ?? null,
    lineItems: (payload.line_items ?? []).map((line) => {
      // REST gives list price plus a line-level discount; the portal needs the
      // per-unit price actually paid.
      const gross = num(line.price) * line.quantity;
      const net = gross - num(line.total_discount);
      return {
        externalId:
          line.admin_graphql_api_id ?? `gid://shopify/LineItem/${line.id}`,
        productId: line.product_id
          ? `gid://shopify/Product/${line.product_id}`
          : null,
        variantId: line.variant_id
          ? `gid://shopify/ProductVariant/${line.variant_id}`
          : null,
        sku: line.sku ?? null,
        productType: line.product_type ?? null,
        title: line.title,
        variantTitle: line.variant_title ?? null,
        // Webhook payloads carry no image; the GraphQL backfill fills it in.
        imageUrl: null,
        quantity: line.quantity,
        unitPrice: line.quantity > 0 ? net / line.quantity : 0,
        currency: payload.currency,
      };
    }),
  };
};

// --------------------------------------------------------------------------
// Admin GraphQL payloads
// --------------------------------------------------------------------------

export interface GraphQLOrderNode {
  id: string;
  name: string;
  email: string | null;
  processedAt: string;
  currencyCode: string;
  customer: { id: string; displayName: string | null } | null;
  subtotalPriceSet: { shopMoney: { amount: string } } | null;
  totalPriceSet: {
    shopMoney: { amount: string };
    presentmentMoney?: { amount: string; currencyCode: string } | null;
  } | null;
  fulfillments: Array<{
    createdAt: string;
    deliveredAt: string | null;
    displayStatus: string | null;
  }>;
  shippingAddress: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    countryCodeV2?: string | null;
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      image: { url: string } | null;
      discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
      product: { id: string; productType: string | null } | null;
      variant: {
        id: string;
        selectedOptions?: Array<{ name: string; value: string }> | null;
      } | null;
    }>;
  };
}

export const mapGraphQLOrder = (
  node: GraphQLOrderNode,
): NormalizedOrder | null => {
  if (!node.email) return null;

  const fulfilledAt = node.fulfillments.length
    ? date(node.fulfillments[0].createdAt)
    : null;
  const deliveredAt =
    node.fulfillments
      .map((f) => date(f.deliveredAt))
      .find((d): d is Date => d !== null) ?? null;

  return {
    externalId: node.id,
    customerExternalId: node.customer?.id ?? null,
    orderNumber: stripHash(node.name),
    email: node.email.toLowerCase(),
    customerName: node.customer?.displayName ?? null,
    currency: node.currencyCode,
    subtotal: num(node.subtotalPriceSet?.shopMoney.amount),
    total: num(node.totalPriceSet?.shopMoney.amount),
    presentmentCurrency:
      node.totalPriceSet?.presentmentMoney?.currencyCode ?? null,
    presentmentTotal: node.totalPriceSet?.presentmentMoney
      ? num(node.totalPriceSet.presentmentMoney.amount)
      : null,
    placedAt: date(node.processedAt) ?? new Date(),
    fulfilledAt,
    deliveredAt,
    shippingAddress: node.shippingAddress ?? null,
    lineItems: node.lineItems.nodes.map((line) => ({
      externalId: line.id,
      productId: line.product?.id ?? null,
      productType: line.product?.productType || null,
      variantId: line.variant?.id ?? null,
      sku: line.sku ?? null,
      title: line.title,
      variantTitle: line.variantTitle ?? null,
      /**
       * "Title" is Shopify's placeholder on products with no real options, so
       * it is dropped here rather than shown to a shopper as "Title: Default
       * Title".
       */
      variantOptions:
        line.variant?.selectedOptions?.filter(
          (o) => o.name.toLowerCase() !== "title",
        ) ?? null,
      imageUrl: line.image?.url ?? null,
      quantity: line.quantity,
      unitPrice: num(line.discountedUnitPriceSet?.shopMoney.amount),
      currency: node.currencyCode,
    })),
  };
};
