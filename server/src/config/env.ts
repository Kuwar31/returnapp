import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

// Both workspaces share the root .env so DATABASE_URL isn't duplicated.
config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  PORTAL_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  // Public HTTPS origin Shopify redirects back to and posts webhooks at.
  // In development this is your tunnel URL, not localhost.
  APP_URL: z.string().url().default("http://localhost:4000"),

  // Shopify app credentials from the Partner Dashboard. Optional so the app
  // still boots (and the seeded demo store works) before a store is connected.
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_SCOPES: z
    .string()
    .default("read_orders,read_fulfillments,read_products,read_customers"),
  SHOPIFY_API_VERSION: z.string().default("2026-04"),

  // 32-byte hex key encrypting Shopify access tokens at rest.
  // Generate with: openssl rand -hex 32
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex characters")
    .optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}\n`);
  console.error("Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

const raw = parsed.data;

const shopifyConfigured = Boolean(
  raw.SHOPIFY_API_KEY && raw.SHOPIFY_API_SECRET && raw.ENCRYPTION_KEY,
);

if (!shopifyConfigured) {
  console.warn(
    "[config] Shopify is not configured — set SHOPIFY_API_KEY, " +
      "SHOPIFY_API_SECRET and ENCRYPTION_KEY to connect a store. " +
      "The app runs on seeded data until then.",
  );
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isDevelopment: raw.NODE_ENV === "development",
  corsOrigins: raw.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  shopifyConfigured,
};

export type Env = typeof env;
