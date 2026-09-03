import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { runReminderSweepSafely } from "./modules/returns/reminders.service.js";

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(
    `API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`,
  );
});

/**
 * The reminder sweep, on a timer in this process.
 *
 * In-process rather than a separate worker because the app runs as a single
 * web service: a second dyno to send at most a handful of emails an hour would
 * cost more to run and more to reason about than the loop it replaces. The
 * interval is unref'd so it can't hold a shutdown open, and the whole thing is
 * off when REMINDER_SWEEP_MINUTES is zero — which is what a second instance
 * needs, since two of them sweeping one database would send every nudge twice.
 */
if (env.REMINDER_SWEEP_MINUTES > 0) {
  const period = env.REMINDER_SWEEP_MINUTES * 60_000;
  logger.info(
    `Reminder sweep every ${env.REMINDER_SWEEP_MINUTES} minutes`,
  );
  // Not on boot: a restart loop would otherwise sweep on every crash.
  setInterval(() => void runReminderSweepSafely(), period).unref();
}

/** Finish in-flight requests and close the pool before exiting. */
const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
