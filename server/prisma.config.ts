import { config } from "dotenv";
import { defineConfig } from "prisma/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Prisma CLI only looks for .env next to the schema, but the whole
// monorepo shares the root one — load it before the config is evaluated.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../.env") });
config({ path: resolve(here, ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
