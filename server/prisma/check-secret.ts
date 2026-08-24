/**
 * Compares the Shopify client secret in .env against one you paste in, without
 * printing either. Use it when OAuth fails with "Could not verify this request
 * came from Shopify" and you want to know whether the secret is actually wrong
 * before changing anything.
 *
 *   npx tsx prisma/check-secret.ts
 *
 * Paste the secret from Partner Dashboard -> your app -> Client credentials.
 * Input is read from stdin and never echoed, logged, or stored.
 */
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), ".env") });

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const fromEnv = process.env.SHOPIFY_API_SECRET ?? "";

if (!fromEnv) {
  console.error("SHOPIFY_API_SECRET is not set in .env");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question("Paste the secret from the Partner Dashboard: ", (answer) => {
  rl.close();
  const pasted = answer.trim();

  console.log("");
  console.log(`  .env      length=${fromEnv.length}  fingerprint=${fingerprint(fromEnv)}`);
  console.log(`  pasted    length=${pasted.length}  fingerprint=${fingerprint(pasted)}`);
  console.log("");

  if (pasted === fromEnv) {
    console.log("  MATCH — .env holds exactly what you pasted.");
    console.log("  If OAuth still fails, the running server has a stale copy:");
    console.log("  stop it fully and start again (env is read once at boot).");
  } else if (pasted.length !== fromEnv.length) {
    console.log("  MISMATCH — different lengths, so something was truncated");
    console.log("  or extra characters (a quote, a space, a newline) crept in.");
  } else {
    console.log("  MISMATCH — same length, different value.");
    console.log("  Likely a secret from a different app, or a pre-rotation one.");
  }
});
