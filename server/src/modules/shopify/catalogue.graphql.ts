/**
 * Product lookups backing the exchange picker.
 *
 * Prices come from here rather than from the client, so a shopper can never
 * name their own exchange value.
 *
 * Images use `media` / `featuredMedia`; the older `image` and `featuredImage`
 * fields are deprecated in 2026-04.
 */

/**
 * Every variant of the product being returned — the "exchange for a new size"
 * case, which is the overwhelmingly common one.
 */
export const PRODUCT_VARIANTS = `#graphql
  query ProductVariants($productId: ID!) {
    product(id: $productId) {
      id
      title
      featuredMedia { preview { image { url } } }
      # The gallery for the swap screen. A shopper choosing a different size is
      # deciding whether they still want the thing, and one thumbnail is not
      # enough to decide on.
      media(first: 10) { nodes { preview { image { url } } } }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          availableForSale
          inventoryQuantity
          price
          media(first: 1) { nodes { preview { image { url } } } }
          selectedOptions { name value }
        }
      }
    }
  }
`;

/**
 * A browsable slice of the catalogue for "exchange for another product".
 *
 * Only published, in-stock variants are offered downstream: letting a shopper
 * pick something unavailable produces an exchange that can never ship.
 */
export const BROWSE_PRODUCTS = `#graphql
  query BrowseProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        featuredMedia { preview { image { url } } }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            availableForSale
            price
            media(first: 1) { nodes { preview { image { url } } } }
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

/**
 * Authoritative price and availability for the variants a shopper actually
 * chose, re-read at quote and submit time so a price change between browsing
 * and submitting can't be exploited.
 */
export const VARIANTS_BY_ID = `#graphql
  query VariantsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        availableForSale
        price
        media(first: 1) { nodes { preview { image { url } } } }
        # The product's hero shot as a fallback: most variants carry no picture
        # of their own, so reading only the variant's media left the exchange
        # item as a grey box on the confirmation page.
        product {
          id
          title
          featuredMedia { preview { image { url } } }
        }
      }
    }
  }
`;

/**
 * Just enough to put a picture on a returned line item.
 *
 * Webhook order payloads carry no image data at all, so every order that
 * arrives the normal way needs this afterwards or the portal shows grey boxes.
 */
export const VARIANT_IMAGES = `#graphql
  query VariantImages($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        media(first: 1) { nodes { preview { image { url } } } }
        product { featuredMedia { preview { image { url } } } }
      }
    }
  }
`;
