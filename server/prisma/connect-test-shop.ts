/**
 * Marks a merchant as Shopify-connected with a dummy token, so webhook
 * handling and the admin's connection panel can be exercised locally without
 * a real store or tunnel.
 *
 *   npx tsx prisma/connect-test-shop.ts [merchantSlug] [shopDomain]
 *
 * The token is fake, so anything that calls out to Shopify (backfill, the
 * Admin API) will fail by design — only the inbound webhook path works.
 */
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { createCipheriv, randomBytes } from "node:crypto";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();

const encrypt = (plaintext: string): string => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    enc.toString("hex"),
  ].join(":");
};

async function main() {
  const slug = process.argv[2] ?? "demo-store";
  const shop = process.argv[3] ?? `${slug}.myshopify.com`;

  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { slug } });

  await prisma.integration.upsert({
    where: {
      merchantId_provider: { merchantId: merchant.id, provider: "SHOPIFY" },
    },
    update: {
      accessToken: encrypt("shpat_fake_token_for_local_testing"),
      externalShopId: shop,
      scopes: "read_orders,read_fulfillments,read_products,read_customers",
      active: true,
    },
    create: {
      merchantId: merchant.id,
      provider: "SHOPIFY",
      accessToken: encrypt("shpat_fake_token_for_local_testing"),
      externalShopId: shop,
      scopes: "read_orders,read_fulfillments,read_products,read_customers",
    },
  });

  console.log(`Connected ${shop} -> merchant "${merchant.name}" (${slug})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
