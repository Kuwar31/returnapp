import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// Reuse one client across tsx hot reloads so we don't exhaust the connection
// pool during development.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDevelopment ? ["warn", "error"] : ["error"],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}
