/**
 * Asks the connected store what orders it actually has, so an empty backfill
 * can be told apart from a backfill whose filter excluded everything.
 *
 *   npx tsx prisma/shopify-probe.ts [merchantSlug]
 */
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { createDecipheriv } from "node:crypto";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();

const decrypt = (payload: string): string => {
  const [iv, tag, data] = payload.split(":");
  const d = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.ENCRYPTION_KEY!, "hex"),
    Buffer.from(iv, "hex"),
  );
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    d.update(Buffer.from(data, "hex")),
    d.final(),
  ]).toString("utf8");
};

const QUERY = `#graphql
  query Probe($query: String) {
    ordersCount(query: $query) { count }
    orders(first: 10, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      nodes {
        name
        email
        processedAt
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        fulfillments(first: 3) { createdAt deliveredAt displayStatus }
      }
    }
  }
`;

async function main() {
  const slug = process.argv[2] ?? "demo-store";
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { slug } });
  const integration = await prisma.integration.findFirstOrThrow({
    where: { merchantId: merchant.id, provider: "SHOPIFY", active: true },
  });

  const shop = integration.externalShopId!;
  const token = decrypt(integration.accessToken!);
  const version = process.env.SHOPIFY_API_VERSION ?? "2026-04";

  const run = async (label: string, query: string | null) => {
    const res = await fetch(
      `https://${shop}/admin/api/${version}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: QUERY, variables: { query } }),
      },
    );
    const body = await res.json();
    if (body.errors) {
      console.log(`\n${label}: ERROR ${JSON.stringify(body.errors)}`);
      return;
    }
    const count = body.data?.ordersCount?.count ?? 0;
    console.log(`\n${label}\n  filter: ${query ?? "(none)"}\n  count:  ${count}`);
    for (const o of body.data?.orders?.nodes ?? []) {
      console.log(
        `   ${o.name}  ${o.processedAt?.slice(0, 10)}  ${o.displayFulfillmentStatus}` +
          `  ${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}` +
          `  email=${o.email ?? "(none)"}`,
      );
    }
  };

  console.log(`Store: ${shop}`);
  await run("ALL ORDERS", null);
  await run("WHAT THE BACKFILL ASKS FOR", "fulfillment_status:shipped");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
