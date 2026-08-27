import { badRequest } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { queryShop } from "./shopify.client.js";
import {
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
  minPrice: number;
  maxPrice: number;
  currency: string;
  variants: ExchangeVariant[];
}

type MediaShape = { nodes?: Array<{ preview?: { image?: { url: string } | null } | null }> } | null;

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
  return {
    id: product.id,
    title: product.title,
    imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    currency: "",
    variants,
  };
};

/** Browsable catalogue for "exchange for another product". */
export const browseProducts = async (
  merchantId: string,
  { search, cursor, limit = 24 }: { search?: string; cursor?: string; limit?: number },
): Promise<{ products: ExchangeProduct[]; nextCursor: string | null }> => {
  // Only offer what a shopper could actually buy right now.
  const query = ["status:active", "published_status:published"]
    .concat(search ? [`title:*${search.replace(/[*"\\]/g, "")}*`] : [])
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
