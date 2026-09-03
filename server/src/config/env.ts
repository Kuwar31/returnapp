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
  /**
   * How often the reminder sweep runs, in minutes. Zero turns it off, which is
   * what a second instance or a local machine wants — two servers sweeping the
   * same database would each try to send the same nudge.
   */
  REMINDER_SWEEP_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
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

  // --- Email ---
  // Leave SMTP_HOST unset in development: mail is then written to
  // server/.mail/ for inspection instead of being sent.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // True for port 465 (implicit TLS); false for 587 (STARTTLS).
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MAIL_FROM: z.string().default("Returns <returns@example.com>"),
  // Where shopper-facing links point. Defaults to the first CORS origin.
  PORTAL_BASE_URL: z.string().url().optional(),
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

const corsOrigins = raw.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const smtpConfigured = Boolean(raw.SMTP_HOST);

if (!smtpConfigured) {
  console.warn(
    "[config] SMTP is not configured — emails will be written to " +
      "server/.mail/ instead of sent. Set SMTP_HOST to send for real.",
  );
} else if (raw.MAIL_FROM.includes("example.com")) {
  /**
   * The commonest way mail silently fails in production: SMTP credentials get
   * set but MAIL_FROM keeps its placeholder, and providers reject a sender on
   * a domain nobody has verified. Every notification then bounces while the
   * config looks complete.
   */
  console.warn(
    "[config] SMTP is configured but MAIL_FROM is still the placeholder " +
      `(${raw.MAIL_FROM}). Providers reject unverified senders, so every ` +
      "email will bounce. Set MAIL_FROM to an address on a domain you have " +
      "verified with your provider.",
  );
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isDevelopment: raw.NODE_ENV === "development",
  corsOrigins,
  shopifyConfigured,
  smtpConfigured,
  // Shopper links must resolve in a browser, so fall back to the client origin.
  portalBaseUrl:
    raw.PORTAL_BASE_URL ?? corsOrigins[0] ?? "http://localhost:5173",
};

export type Env = typeof env;
