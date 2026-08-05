import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const prisma = new PrismaClient();

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

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function main() {
  const merchant = await prisma.merchant.upsert({
    where: { slug: "demo-store" },
    update: {},
    create: {
      slug: "demo-store",
      name: "Demo Store",
      domain: "demo-store.myshopify.com",
      email: "ops@demo-store.test",
      currency: "USD",
      branding: {
        create: {
          headline: "Returns & Exchanges",
          subheadline: "Start a return or exchange in a few clicks",
          accentColor: "#111213",
          supportEmail: "help@demo-store.test",
        },
      },
    },
  });

  const passwordHash = await bcrypt.hash("password123", 10);
  await prisma.user.upsert({
    where: { merchantId_email: { merchantId: merchant.id, email: "owner@demo-store.test" } },
    update: {},
    create: {
      merchantId: merchant.id,
      email: "owner@demo-store.test",
      passwordHash,
      name: "Demo Owner",
      role: "OWNER",
    },
  });

  const policy = await prisma.returnPolicy.upsert({
    where: { id: `${merchant.id}-default` },
    update: {},
    create: {
      id: `${merchant.id}-default`,
      merchantId: merchant.id,
      name: "Standard policy",
      isDefault: true,
      returnWindowDays: 30,
      windowStartsFrom: "DELIVERY",
      allowRefund: true,
      allowStoreCredit: true,
      allowExchange: true,
      // 10% extra when the shopper takes credit instead of cash.
      bonusCreditPercent: 10,
      returnShippingFee: 5.99,
      waiveShippingOnCredit: true,
      autoApprove: true,
      autoApproveUnder: 75,
    },
  });

  for (const reason of DEFAULT_REASONS) {
    await prisma.returnReason.upsert({
      where: { merchantId_code: { merchantId: merchant.id, code: reason.code } },
      update: { label: reason.label, sortOrder: reason.sortOrder },
      create: { merchantId: merchant.id, ...reason },
    });
  }

  await prisma.order.upsert({
    where: { merchantId_orderNumber: { merchantId: merchant.id, orderNumber: "1001" } },
    update: {},
    create: {
      merchantId: merchant.id,
      policyId: policy.id,
      orderNumber: "1001",
      email: "shopper@example.com",
      customerName: "Alex Shopper",
      currency: "USD",
      subtotal: 184.0,
      total: 199.0,
      placedAt: daysAgo(12),
      fulfilledAt: daysAgo(10),
      deliveredAt: daysAgo(7),
      lineItems: {
        create: [
          {
            sku: "TEE-BLK-M",
            title: "Everyday Cotton Tee",
            variantTitle: "Black / M",
            quantity: 2,
            unitPrice: 32.0,
            currency: "USD",
          },
          {
            sku: "JEAN-IND-32",
            title: "Slim Fit Jeans",
            variantTitle: "Indigo / 32",
            quantity: 1,
            unitPrice: 89.0,
            currency: "USD",
          },
          {
            sku: "SOCK-3PK",
            title: "Merino Sock 3-Pack",
            variantTitle: "Grey / L",
            quantity: 1,
            unitPrice: 31.0,
            currency: "USD",
            finalSale: true,
          },
        ],
      },
    },
  });

  console.log(`Seeded merchant "${merchant.name}" (slug: ${merchant.slug})`);
  console.log("  Admin login: owner@demo-store.test / password123");
  console.log("  Portal test: order 1001 / shopper@example.com");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
