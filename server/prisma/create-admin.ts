/**
 * Creates the first admin user for a merchant.
 *
 * On a fresh deployment this creates the merchant too, not just the user.
 * It has to: the Shopify install URL is minted behind the admin login and the
 * OAuth callback rejects a request without that signed state, so an install
 * needs an account that only an install could have created. This breaks the
 * cycle from outside; the store attaches to this merchant when you install.
 *
 * Run it once from the host's shell after the app is installed:
 *
 *   ADMIN_EMAIL=you@store.com ADMIN_PASSWORD='…' npm run create-admin --workspace server
 *
 * Re-running with the same email resets that user's password, which is also
 * how you recover from a lost one.
 */
import bcrypt from "bcryptjs";
// The shared client, so this picks up DATABASE_URL exactly the way the API
// does — through config/env, which loads .env locally and reads the real
// environment on the host.
import { prisma } from "../src/lib/prisma.js";
import { seedDefaultReasonGroup } from "../src/modules/settings/reason-defaults.js";

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const merchantSlug = process.env.MERCHANT_SLUG?.trim();

const fail = (message: string): never => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

if (!email) fail("Set ADMIN_EMAIL to the address you'll sign in with.");
if (!password) fail("Set ADMIN_PASSWORD. Nothing is defaulted — pick your own.");
// Deliberately strict: this account approves refunds and issues gift cards.
if (password!.length < 12) {
  fail("ADMIN_PASSWORD must be at least 12 characters.");
}

let merchants = await prisma.merchant.findMany({
  select: { id: true, slug: true, name: true },
  orderBy: { createdAt: "asc" },
});

/**
 * Bootstrap the first merchant.
 *
 * Installing the Shopify app can't do this on a fresh database: the install
 * URL is minted by an endpoint behind the admin login, and the OAuth callback
 * rejects a request without that signed state. So an install needs an account,
 * an account needs a merchant, and a merchant needed the install — a cycle
 * that has to be broken from outside.
 *
 * The store connects to this merchant later, at install: provisionMerchant
 * prefers the signed-in account over creating one.
 */
if (merchants.length === 0) {
  const slug = (merchantSlug || "store").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const created = await prisma.merchant.create({
    data: {
      slug,
      name: process.env.MERCHANT_NAME?.trim() || "My Store",
      email,
      branding: { create: { supportEmail: email } },
      policies: {
        create: {
          name: "Standard policy",
          isDefault: true,
          returnWindowDays: 30,
          windowStartsFrom: "DELIVERY",
        },
      },
    },
    select: { id: true, slug: true, name: true },
  });
  await seedDefaultReasonGroup(prisma, created.id);
  merchants = [created];
  console.log(
    `\n  Created merchant "${created.name}" (portal at /r/${created.slug})` +
      `\n  with a standard 30-day policy and the default reason group.`,
  );
}

const merchant = merchantSlug
  ? merchants.find((m) => m.slug === merchantSlug)
  : merchants.length === 1
    ? merchants[0]
    : undefined;

if (!merchant) {
  fail(
    merchantSlug
      ? `No merchant with slug "${merchantSlug}". Found: ${merchants.map((m) => m.slug).join(", ")}`
      : `Several merchants exist — set MERCHANT_SLUG to one of: ${merchants.map((m) => m.slug).join(", ")}`,
  );
}

const passwordHash = await bcrypt.hash(password!, 12);

const user = await prisma.user.upsert({
  where: { merchantId_email: { merchantId: merchant!.id, email: email! } },
  update: { passwordHash, role: "OWNER" },
  create: {
    merchantId: merchant!.id,
    email: email!,
    passwordHash,
    role: "OWNER",
    name: "Owner",
  },
});

console.log(
  `\n  Owner account ready for ${merchant!.name} (${merchant!.slug})\n` +
    `  Sign in at /admin/login as ${user.email}\n`,
);

await prisma.$disconnect();
