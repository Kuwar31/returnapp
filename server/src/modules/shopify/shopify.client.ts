import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { decrypt } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";

const SHOP_DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export const isValidShopDomain = (shop: string): boolean =>
  SHOP_DOMAIN.test(shop);

export interface GraphQLResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Calls the Shopify Admin GraphQL API for one shop.
 *
 * Retries on 429 and 5xx using the Retry-After header when Shopify sends one,
 * since the backfill can easily outrun the leaky-bucket rate limit.
 */
export const shopifyGraphQL = async <T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> => {
  const response = await fetch(
    `https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 4) {
      throw new AppError(
        502,
        "SHOPIFY_UNAVAILABLE",
        `Shopify returned ${response.status} after ${attempt + 1} attempts.`,
      );
    }
    const retryAfter = Number(response.headers.get("Retry-After") ?? 0);
    const delayMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500;
    logger.warn(
      { shop, status: response.status, delayMs },
      "Shopify throttled or unavailable, retrying",
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return shopifyGraphQL<T>(shop, accessToken, query, variables, attempt + 1);
  }

  if (response.status === 401 || response.status === 403) {
    // The merchant uninstalled or revoked the app — stop using this token.
    await prisma.integration
      .updateMany({
        where: { provider: "SHOPIFY", externalShopId: shop },
        data: { active: false },
      })
      .catch(() => undefined);
    throw new AppError(
      401,
      "SHOPIFY_UNAUTHORIZED",
      "Shopify rejected the access token. Reconnect the store.",
    );
  }

  if (!response.ok) {
    throw new AppError(
      502,
      "SHOPIFY_ERROR",
      `Shopify returned ${response.status}.`,
    );
  }

  const body = (await response.json()) as GraphQLResult<T>;
  if (body.errors?.length) {
    throw new AppError(
      502,
      "SHOPIFY_GRAPHQL_ERROR",
      body.errors.map((e) => e.message).join("; "),
    );
  }
  if (!body.data) {
    throw new AppError(502, "SHOPIFY_ERROR", "Shopify returned no data.");
  }
  return body.data;
};

/** Resolves the stored, decrypted token for a merchant's connected store. */
export const getShopCredentials = async (merchantId: string) => {
  const integration = await prisma.integration.findFirst({
    where: { merchantId, provider: "SHOPIFY", active: true },
  });
  if (!integration?.accessToken || !integration.externalShopId) {
    throw new AppError(
      409,
      "NOT_CONNECTED",
      "This store isn't connected to Shopify yet.",
    );
  }
  return {
    shop: integration.externalShopId,
    accessToken: decrypt(integration.accessToken),
  };
};

/** Convenience wrapper: look up credentials, then run the query. */
export const queryShop = async <T>(
  merchantId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const { shop, accessToken } = await getShopCredentials(merchantId);
  return shopifyGraphQL<T>(shop, accessToken, query, variables);
};
