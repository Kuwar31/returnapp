/**
 * Creates the first admin user for a merchant.
 *
 * Installing the Shopify app creates the merchant, its policy, reasons and
 * branding — but no staff account, because Shopify never tells us a password.
 * Without this there is no way to sign into the dashboard on a fresh
 * deployment.
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

const merchants = await prisma.merchant.findMany({
  select: { id: true, slug: true, name: true },
  orderBy: { createdAt: "asc" },
});

if (merchants.length === 0) {
  fail(
    "No merchant exists yet. Install the app on your Shopify store first — that's what creates it.",
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
