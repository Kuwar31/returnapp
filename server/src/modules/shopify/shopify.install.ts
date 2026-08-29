import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { encrypt } from "../../lib/crypto.js";
import { seedDefaultReasonGroup } from "../settings/reason-defaults.js";
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


/**
 * Creates or updates the merchant record for a freshly authorized shop, and
 * seeds a default policy and reason set so the portal works immediately.
 */
export const provisionMerchant = async (
  shop: string,
  accessToken: string,
  scope: string,
  /**
   * The merchant account that started the install. Passing it links the store
   * to an existing account with staff users; without it a fresh merchant is
   * created, which has no way to sign in until an invite flow exists.
   */
  linkToMerchantId?: string,
) => {
  if (!isValidShopDomain(shop)) throw badRequest("Invalid shop domain.");

  const { shop: details } = await shopifyGraphQL<ShopQueryResult>(
    shop,
    accessToken,
    SHOP_QUERY,
  );

  // Prefer the signed-in account, then any account already holding this
  // domain, before falling back to creating one.
  const claimed = linkToMerchantId
    ? await prisma.merchant.findUnique({ where: { id: linkToMerchantId } })
    : null;

  if (claimed) {
    const conflict = await prisma.merchant.findFirst({
      where: { domain: shop, id: { not: claimed.id } },
    });
    if (conflict) {
      throw badRequest(
        `${shop} is already connected to another account on this server.`,
      );
    }
  }

  const existing =
    claimed ?? (await prisma.merchant.findFirst({ where: { domain: shop } }));

  const merchant = existing
    ? await prisma.merchant.update({
        where: { id: existing.id },
        data: {
          // Claim the domain, but keep the account's own name — an existing
          // account may have been set up before the store was connected.
          domain: shop,
          email: existing.email ?? details.email,
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
        },
      });

  /**
   * Runs for linked merchants too, not just newly created ones.
   *
   * The update branch above deliberately preserves an existing account's own
   * setup — but an account created by the bootstrap script has none, and the
   * portal can't offer a return without a policy and a reason group.
   */
  await ensurePortalDefaults(merchant.id);

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

  // A linked account may predate this code (or have been created by a bare
  // install), so make sure the portal has a policy and reasons to work with.
  await ensurePortalDefaults(merchant.id);

  logger.info({ shop, merchantId: merchant.id }, "Shopify store connected");
  return merchant;
};

/** Guarantees the rows the shopper portal cannot function without. */
const ensurePortalDefaults = async (merchantId: string) => {
  const hasPolicy = await prisma.returnPolicy.findFirst({
    where: { merchantId, isDefault: true },
    select: { id: true },
  });
  if (!hasPolicy) {
    await prisma.returnPolicy.create({
      data: {
        merchantId,
        name: "Standard policy",
        isDefault: true,
        returnWindowDays: 30,
        windowStartsFrom: "DELIVERY",
      },
    });
  }

  await seedDefaultReasonGroup(prisma, merchantId);

  await prisma.portalBranding.upsert({
    where: { merchantId },
    update: {},
    create: { merchantId },
  });
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

const WEBHOOK_LIST = `#graphql
  query WebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
`;

const WEBHOOK_DELETE = `#graphql
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

/**
 * Only what has no alternative.
 *
 * The order and fulfillment topics used to live here and were removed because
 * they could not be delivered, not because they were wrong: this app runs on an
 * instance that sleeps when idle and takes over twenty seconds to wake, while
 * Shopify allows a webhook five. Every delivery to a sleeping instance failed,
 * and the store's log filled with errors that said nothing about the code.
 * Orders are now read from Shopify at lookup instead — see syncOrderByNumber.
 *
 * Uninstall stays. There is no read path that can notice it: once the token is
 * revoked there is nothing left to poll with, so if this notification is missed
 * the app keeps a dead integration forever.
 *
 * Worth restoring the order topics if this ever moves to an instance that stays
 * awake — a webhook is still the only way to hear about an order nobody looks up.
 */
export const WEBHOOK_TOPICS = ["APP_UNINSTALLED"] as const;

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

  await pruneWebhooks(shop, accessToken);
};

/**
 * Deletes subscriptions this app no longer wants.
 *
 * Registering fewer topics does not remove the ones already on the store, so
 * without this the order and fulfillment subscriptions keep being delivered,
 * keep timing out, and keep filling the merchant's log with errors about code
 * that no longer expects them.
 *
 * Matched on topic alone, not on callback URL. Shopify only ever lists the
 * calling app's own subscriptions, so everything here is ours — and this store
 * had each dropped topic registered twice, once against production and once
 * against a developer's tunnel, so every order fired ten deliveries instead of
 * five. Scoping to one URL would have left the other set behind for good.
 *
 * Topics still in use are left alone at every URL, so a developer running
 * locally keeps their own uninstall hook.
 */
const pruneWebhooks = async (shop: string, accessToken: string) => {
  const keep = new Set<string>(WEBHOOK_TOPICS);

  try {
    const listed = await shopifyGraphQL<{
      webhookSubscriptions: {
        nodes: Array<{
          id: string;
          topic: string;
          endpoint: { __typename: string; callbackUrl?: string };
        }>;
      };
    }>(shop, accessToken, WEBHOOK_LIST, { first: 100 });

    for (const sub of listed.webhookSubscriptions.nodes) {
      if (keep.has(sub.topic)) continue;

      const result = await shopifyGraphQL<{
        webhookSubscriptionDelete: { userErrors: Array<{ message: string }> };
      }>(shop, accessToken, WEBHOOK_DELETE, { id: sub.id });

      const errors = result.webhookSubscriptionDelete.userErrors;
      if (errors.length > 0) {
        logger.warn({ shop, topic: sub.topic, errors }, "Could not remove webhook");
      } else {
        logger.info({ shop, topic: sub.topic }, "Removed webhook we no longer use");
      }
    }
  } catch (error) {
    // Non-fatal: a stale subscription is noise, not a broken install.
    logger.warn({ shop, error }, "Could not prune webhooks");
  }
};
