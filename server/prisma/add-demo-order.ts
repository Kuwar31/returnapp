/**
 * Adds another returnable order to the demo store. Useful for re-testing the
 * portal after a previous run has consumed order 1001's returnable items.
 *
 *   npx tsx prisma/add-demo-order.ts [orderNumber]
 */
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function main() {
  const orderNumber = process.argv[2] ?? "1002";

  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { slug: "demo-store" },
  });
  const policy = await prisma.returnPolicy.findFirstOrThrow({
    where: { merchantId: merchant.id, isDefault: true },
  });

  const existing = await prisma.order.findFirst({
    where: { merchantId: merchant.id, orderNumber },
  });
  if (existing) {
    await prisma.order.delete({ where: { id: existing.id } });
  }

  await prisma.order.create({
    data: {
      merchantId: merchant.id,
      policyId: policy.id,
      orderNumber,
      email: "shopper@example.com",
      customerName: "Alex Shopper",
      currency: "USD",
      subtotal: 218.0,
      total: 232.0,
      placedAt: daysAgo(9),
      fulfilledAt: daysAgo(7),
      deliveredAt: daysAgo(4),
      lineItems: {
        create: [
          {
            sku: "HOOD-NVY-L",
            title: "Fleece Hoodie",
            variantTitle: "Navy / L",
            quantity: 1,
            unitPrice: 78.0,
            currency: "USD",
          },
          {
            sku: "TEE-WHT-M",
            title: "Everyday Cotton Tee",
            variantTitle: "White / M",
            quantity: 2,
            unitPrice: 32.0,
            currency: "USD",
          },
          {
            sku: "CAP-BLK",
            title: "Canvas Cap",
            variantTitle: "Black",
            quantity: 1,
            unitPrice: 28.0,
            currency: "USD",
          },
          {
            sku: "BELT-TAN",
            title: "Leather Belt",
            variantTitle: "Tan / 34",
            quantity: 1,
            unitPrice: 48.0,
            currency: "USD",
            finalSale: true,
          },
        ],
      },
    },
  });

  console.log(`Added order ${orderNumber} for shopper@example.com`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
