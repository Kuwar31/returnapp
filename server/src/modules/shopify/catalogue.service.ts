import { badRequest } from "../../lib/errors.js";
import { storeAvailabilityRequired } from "../settings/merchant-settings.js";
import { logger } from "../../lib/logger.js";
import { queryShop } from "./shopify.client.js";
import {
  BROWSE_COLLECTIONS,
  BROWSE_PRODUCTS,
  PRODUCT_VARIANTS,
  VARIANT_IMAGES,
  VARIANTS_BY_ID,
} from "./catalogue.graphql.js";

export interface ExchangeVariant {
  id: string;
  title: string;
  sku: string | null;
  price: number;
  available: boolean;
  imageUrl: string | null;
  /** e.g. [{ name: "Size", value: "37" }] — what the picker labels buttons with. */
  options: Array<{ name: string; value: string }>;
}

export interface ExchangeProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  /** Every shot of the product, for the swap screen's gallery. */
  images?: string[];
  minPrice: number;
  maxPrice: number;
  currency: string;
  variants: ExchangeVariant[];
}

type MediaShape = { nodes?: Array<{ preview?: { image?: { url: string } | null } | null }> } | null;

/**
 * Names a variant's options, e.g. "Size: 37".
 *
 * Shopify's variant title carries only the values, so a single-option product
 * reads as a bare number. "Title" is its placeholder on products with no real
 * options and is dropped; merchants type the rest by hand, so the first letter
 * is raised.
 */
const describeOptions = (
  options: Array<{ name: string; value: string }> | undefined | null,
  fallback: string,
): string => {
  const named = (options ?? [])
    .filter((o) => o?.name && o.name.toLowerCase() !== "title")
    .map((o) => `${o.name.charAt(0).toUpperCase()}${o.name.slice(1)}: ${o.value}`);
  if (named.length > 0) return named.join(" · ");
  // Every option was the placeholder, so the product has none. Returning the
  // fallback would print "Default Title" as though it were a real choice.
  return options && options.length > 0 ? "" : fallback;
};

const firstImage = (media: MediaShape): string | null =>
  media?.nodes?.[0]?.preview?.image?.url ?? null;

/**
 * The other variants of a product the shopper already owns — "exchange for a
 * new size".
 *
 * Unavailable variants are returned rather than filtered so the picker can grey
 * out a sold-out size instead of silently omitting it, which reads as a bug to
 * a shopper who knows the size exists.
 */
export const getProductVariants = async (
  merchantId: string,
  productId: string,
): Promise<ExchangeProduct | null> => {
  const data = await queryShop<{
    product: {
      id: string;
      title: string;
      featuredMedia: { preview?: { image?: { url: string } | null } | null } | null;
      media: MediaShape;
      variants: {
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          availableForSale: boolean;
          price: string;
          media: MediaShape;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(merchantId, PRODUCT_VARIANTS, { productId });

  const product = data.product;
  if (!product) return null;

  const variants: ExchangeVariant[] = product.variants.nodes.map((v) => ({
    id: v.id,
    title: v.title,
    sku: v.sku,
    price: parseFloat(v.price),
    available: v.availableForSale,
    imageUrl: firstImage(v.media) ?? product.featuredMedia?.preview?.image?.url ?? null,
    options: v.selectedOptions,
  }));

  const prices = variants.map((v) => v.price);
  // Hero first, then the rest, de-duplicated — Shopify usually repeats the
  // featured shot inside media and a gallery that opens on a duplicate looks
  // broken.
  const hero = product.featuredMedia?.preview?.image?.url ?? null;
  const gallery = [
    ...new Set(
      [hero, ...(product.media?.nodes ?? []).map((n) => n?.preview?.image?.url ?? null)]
        .filter((url): url is string => Boolean(url)),
    ),
  ];

  return {
    id: product.id,
    title: product.title,
    imageUrl: hero,
    images: gallery,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    currency: "",
    variants,
  };
};

/** Browsable catalogue for "exchange for another product". */
export interface ExchangeCollection {
  id: string;
  title: string;
}

/**
 * The collections a shopper can filter the catalogue by.
 *
 * Empty ones are dropped: a rail entry that leads to "no products" is worse
 * than not offering it. Failures return nothing rather than throwing — the
 * rail is navigation, and losing it should never cost the shopper the grid.
 */
export const browseCollections = async (
  merchantId: string,
): Promise<ExchangeCollection[]> => {
  try {
    const data = await queryShop<{
      collections: {
        nodes: Array<{
          id: string;
          title: string;
          productsCount: { count: number } | null;
        }>;
      };
    }>(merchantId, BROWSE_COLLECTIONS, { first: 30 });

    return data.collections.nodes
      .filter((c) => (c.productsCount?.count ?? 0) > 0)
      .map((c) => ({ id: c.id, title: c.title }));
  } catch (error) {
    logger.warn({ merchantId, error }, "Could not read collections");
    return [];
  }
};

export const browseProducts = async (
  merchantId: string,
  {
    search,
    cursor,
    collectionId,
    limit = 24,
  }: { search?: string; cursor?: string; collectionId?: string; limit?: number },
): Promise<{ products: ExchangeProduct[]; nextCursor: string | null }> => {
  /**
   * Only what a shopper could actually buy right now.
   *
   * `published_status:published` is the online store channel specifically, and
   * it is a merchant setting rather than a constant: a store that keeps some
   * products off the storefront but still wants them offered as exchanges can
   * turn it off. On by default, because offering something the storefront
   * won't sell is the surprising behaviour.
   */
  const matchAvailability = await storeAvailabilityRequired(merchantId);
  const query = ["status:active"]
    .concat(matchAvailability ? ["published_status:published"] : [])
    .concat(search ? [`title:*${search.replace(/[*"\\]/g, "")}*`] : [])
    // Shopify's product search takes the numeric id, not the GID.
    .concat(
      collectionId
        ? [`collection_id:${collectionId.split("/").pop()}`]
        : [],
    )
    .join(" AND ");

  const data = await queryShop<{
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        id: string;
        title: string;
        featuredMedia: { preview?: { image?: { url: string } | null } | null } | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
        };
        variants: {
          nodes: Array<{
            id: string;
            title: string;
            sku: string | null;
            availableForSale: boolean;
            price: string;
            media: MediaShape;
            selectedOptions: Array<{ name: string; value: string }>;
          }>;
        };
      }>;
    };
  }>(merchantId, BROWSE_PRODUCTS, {
    first: Math.min(limit, 50),
    after: cursor ?? null,
    query,
  });

  const products = data.products.nodes
    .map((p) => ({
      id: p.id,
      title: p.title,
      imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
      minPrice: parseFloat(p.priceRangeV2.minVariantPrice.amount),
      maxPrice: parseFloat(p.priceRangeV2.maxVariantPrice.amount),
      currency: p.priceRangeV2.minVariantPrice.currencyCode,
      variants: p.variants.nodes
        .filter((v) => v.availableForSale)
        .map((v) => ({
          id: v.id,
          title: v.title,
          sku: v.sku,
          price: parseFloat(v.price),
          available: v.availableForSale,
          imageUrl:
            firstImage(v.media) ?? p.featuredMedia?.preview?.image?.url ?? null,
          options: v.selectedOptions,
        })),
    }))
    // A product whose variants are all sold out isn't exchangeable.
    .filter((p) => p.variants.length > 0);

  return {
    products,
    nextCursor: data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null,
  };
};

/**
 * Image URLs for a set of variants, keyed by variant id.
 *
 * Separate from resolveVariants because that one is a purchase-time trust
 * check and rejects anything out of stock — which would be wrong here: a
 * sold-out item still needs its picture shown on a return.
 *
 * Never throws. A missing image is a cosmetic loss, not a reason to fail an
 * order import.
 */
export const fetchVariantImages = async (
  merchantId: string,
  variantIds: string[],
): Promise<Map<string, string>> => {
  const images = new Map<string, string>();
  if (variantIds.length === 0) return images;

  try {
    const data = await queryShop<{
      nodes: Array<{
        id: string;
        media: MediaShape;
        product: { featuredMedia?: { preview?: { image?: { url: string } | null } | null } | null } | null;
      } | null>;
    }>(merchantId, VARIANT_IMAGES, { ids: [...new Set(variantIds)].slice(0, 250) });

    for (const node of data.nodes) {
      if (!node) continue;
      // Prefer the variant's own shot; fall back to the product's hero image,
      // since most variants don't carry a distinct picture.
      const url =
        firstImage(node.media) ??
        node.product?.featuredMedia?.preview?.image?.url ??
        null;
      if (url) images.set(node.id, url);
    }
  } catch (error) {
    logger.warn({ merchantId, error }, "Could not fetch variant images");
  }
  return images;
};

export interface ResolvedVariant {
  id: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  price: number;
  imageUrl: string | null;
  productId: string | null;
  available: boolean;
}

/**
 * Re-reads the variants a shopper picked, straight from Shopify.
 *
 * This is the trust boundary for exchanges: the client sends variant ids only,
 * and every title, price and availability flag used in the quote comes from
 * here. Anything unavailable is rejected rather than priced.
 */
export const resolveVariants = async (
  merchantId: string,
  variantIds: string[],
): Promise<Map<string, ResolvedVariant>> => {
  if (variantIds.length === 0) return new Map();

  const data = await queryShop<{
    nodes: Array<{
      id: string;
      title: string;
      sku: string | null;
      availableForSale: boolean;
      price: string;
      media: MediaShape;
      product: {
        id: string;
        title: string;
        featuredMedia?: { preview?: { image?: { url: string } | null } | null } | null;
      } | null;
    } | null>;
  }>(merchantId, VARIANTS_BY_ID, { ids: [...new Set(variantIds)] });

  const map = new Map<string, ResolvedVariant>();
  for (const node of data.nodes) {
    if (!node) continue;
    if (!node.availableForSale) {
      throw badRequest(
        `"${node.product?.title ?? "That item"}" is out of stock in the option you chose.`,
      );
    }
    map.set(node.id, {
      id: node.id,
      title: node.product?.title ?? node.title,
      variantTitle: node.title,
      sku: node.sku,
      price: parseFloat(node.price),
      // Same fallback the rest of the catalogue uses — see fetchVariantImages.
      imageUrl:
        firstImage(node.media) ??
        node.product?.featuredMedia?.preview?.image?.url ??
        null,
      productId: node.product?.id ?? null,
      available: node.availableForSale,
    });
  }
  return map;
};

/**
 * Display details for variants the shopper has already chosen.
 *
 * Separate from resolveVariants, which is the purchase-time trust check and
 * throws on anything out of stock — wrong here, because this only ever
 * describes a choice that was already made and validated. A sold-out variant
 * still needs its name and picture rendered.
 *
 * Exists because the portal draft outlives deploys: a selection saved before a
 * field was recorded has no way to fill it in from local state, and the shopper
 * shouldn't have to redo their choice to get a picture.
 */
export const describeVariants = async (
  merchantId: string,
  variantIds: string[],
): Promise<
  Map<
    string,
    { title: string; variantTitle: string; imageUrl: string | null; price: number }
  >
> => {
  const out = new Map<
    string,
    { title: string; variantTitle: string; imageUrl: string | null; price: number }
  >();
  if (variantIds.length === 0) return out;

  try {
    const data = await queryShop<{
      nodes: Array<{
        id: string;
        title: string;
        price: string;
        selectedOptions?: Array<{ name: string; value: string }> | null;
        media: MediaShape;
        product: {
          title: string;
          featuredMedia?: { preview?: { image?: { url: string } | null } | null } | null;
        } | null;
      } | null>;
    }>(merchantId, VARIANTS_BY_ID, {
      ids: [...new Set(variantIds)].slice(0, 100),
    });

    for (const node of data.nodes) {
      if (!node) continue;
      out.set(node.id, {
        title: node.product?.title ?? node.title,
        // Named, so a top-up doesn't put a bare "3" back into a draft that the
        // picker had already labelled "Size: 3".
        variantTitle: describeOptions(node.selectedOptions, node.title),
        imageUrl:
          firstImage(node.media) ??
          node.product?.featuredMedia?.preview?.image?.url ??
          null,
        price: parseFloat(node.price),
      });
    }
  } catch (error) {
    logger.warn({ merchantId, error }, "Could not describe exchange variants");
  }
  return out;
};
