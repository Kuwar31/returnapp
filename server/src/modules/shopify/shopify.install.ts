import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { encrypt } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { isValidShopDomain, shopifyGraphQL } from "./shopify.client.js";

export const NONCE_COOKIE = "shopify_oauth_state";

export const newNonce = (): string => randomBytes(16).toString("hex");

export const authorizeUrl = (shop: string, nonce: string): string => {
  const params = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY ?? "",
    scope: env.SHOPIFY_SCOPES,
    redirect_uri: `${env.APP_URL}/api/shopify/callback`,
    state: nonce,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
};

interface TokenResponse {
  access_token: string;
  scope: string;
}

/** Trades the one-time OAuth code for a permanent offline access token. */
export const exchangeCodeForToken = async (
  shop: string,
  code: string,
): Promise<TokenResponse> => {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
    }),
  });
  if (!response.ok) {
    throw unauthorized("Shopify rejected the authorization code.");
  }
  return (await response.json()) as TokenResponse;
};

const SHOP_QUERY = `#graphql
  query ConnectedShop {
    shop {
      name
      email
      myshopifyDomain
      primaryDomain { host }
      currencyCode
      ianaTimezone
    }
  }
`;

interface ShopQueryResult {
  shop: {
    name: string;
    email: string | null;
    myshopifyDomain: string;
    primaryDomain: { host: string } | null;
    currencyCode: string;
    ianaTimezone: string;
  };
}

/** Turns a shop domain into a URL-safe portal slug: acme.myshopify.com -> acme */
const slugFor = async (shop: string): Promise<string> => {
  const base = shop.replace(/\.myshopify\.com$/, "").toLowerCase();
  let slug = base;
  let suffix = 1;
  // Slugs are the public portal path, so they must stay unique across tenants.
  while (await prisma.merchant.findFirst({ where: { slug } })) {
    const owner = await prisma.merchant.findFirst({
      where: { slug, domain: shop },
    });
    if (owner) return slug;
    slug = `${base}-${++suffix}`;
  }
  return slug;
};

const DEFAULT_REASONS = [
  { code: "SIZE_TOO_SMALL", label: "Too small", sortOrder: 1 },
  { code: "SIZE_TOO_LARGE", label: "Too large", sortOrder: 2 },
  { code: "COLOR", label: "Color not as expected", sortOrder: 3 },
  {
    code: "DEFECTIVE",
    label: "Damaged or defective",
    requiresPhoto: true,
    requiresNote: true,
    sortOrder: 4,
  },
  { code: "NOT_AS_DESCRIBED", label: "Not as described", sortOrder: 5 },
  { code: "WRONG_ITEM", label: "Received the wrong item", sortOrder: 6 },
  { code: "STYLE", label: "Didn't like the style", sortOrder: 7 },
  { code: "UNWANTED", label: "Changed my mind", sortOrder: 8 },
  { code: "OTHER", label: "Other", requiresNote: true, sortOrder: 9 },
];

/**
 * Creates or updates the merchant record for a freshly authorized shop, and
 * seeds a default policy and reason set so the portal works immediately.
 */
export const provisionMerchant = async (
  shop: string,
  accessToken: string,
  scope: string,
) => {
  if (!isValidShopDomain(shop)) throw badRequest("Invalid shop domain.");

  const { shop: details } = await shopifyGraphQL<ShopQueryResult>(
    shop,
    accessToken,
    SHOP_QUERY,
  );

  const existing = await prisma.merchant.findFirst({
    where: { domain: shop },
  });

  const merchant = existing
    ? await prisma.merchant.update({
        where: { id: existing.id },
        data: {
          name: details.name,
          email: details.email,
          currency: details.currencyCode,
          timezone: details.ianaTimezone,
          status: "ACTIVE",
        },
      })
    : await prisma.merchant.create({
        data: {
          slug: await slugFor(shop),
          name: details.name,
          domain: shop,
          email: details.email,
          currency: details.currencyCode,
          timezone: details.ianaTimezone,
          branding: { create: { supportEmail: details.email } },
          policies: {
            create: {
              name: "Standard policy",
              isDefault: true,
              returnWindowDays: 30,
              windowStartsFrom: "DELIVERY",
            },
          },
          reasons: { create: DEFAULT_REASONS },
        },
      });

  await prisma.integration.upsert({
    where: {
      merchantId_provider: { merchantId: merchant.id, provider: "SHOPIFY" },
    },
    update: {
      accessToken: encrypt(accessToken),
      scopes: scope,
      externalShopId: shop,
      active: true,
      connectedAt: new Date(),
    },
    create: {
      merchantId: merchant.id,
      provider: "SHOPIFY",
      accessToken: encrypt(accessToken),
      scopes: scope,
      externalShopId: shop,
    },
  });

  logger.info({ shop, merchantId: merchant.id }, "Shopify store connected");
  return merchant;
};

const WEBHOOK_CREATE = `#graphql
  mutation RegisterWebhook(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

/** Topics we need to keep Postgres in step with the store. */
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "APP_UNINSTALLED",
] as const;

export const registerWebhooks = async (shop: string, accessToken: string) => {
  const uri = `${env.APP_URL}/api/shopify/webhooks`;

  for (const topic of WEBHOOK_TOPICS) {
    try {
      const result = await shopifyGraphQL<{
        webhookSubscriptionCreate: {
          userErrors: Array<{ message: string }>;
        };
      }>(shop, accessToken, WEBHOOK_CREATE, {
        topic,
        webhookSubscription: { uri, format: "JSON" },
      });

      const errors = result.webhookSubscriptionCreate.userErrors;
      // Re-registering an identical subscription is expected on reinstall.
      const meaningful = errors.filter(
        (e) => !/already exists|taken/i.test(e.message),
      );
      if (meaningful.length > 0) {
        logger.warn({ shop, topic, errors: meaningful }, "Webhook registration issue");
      }
    } catch (error) {
      logger.error({ shop, topic, error }, "Failed to register webhook");
    }
  }
};
