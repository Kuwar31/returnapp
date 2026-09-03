import { logger } from "../../lib/logger.js";
import {
  EXPIRE_DAYS,
  EXPIRING_DAYS,
  REMINDER_DAYS,
} from "./reminder-windows.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../email/notifications.js";
import { isNotificationEnabled } from "../settings/notification-settings.js";

/**
 * The nudges a return gets when it was approved and nothing came back.
 *
 * Three moments, measured from approval: a reminder, a warning that the
 * request is about to close, and the closing itself. The thresholds are fixed
 * rather than per-store for now, and are stated in the settings copy so a
 * merchant reads the same numbers this file applies.
 */
export { EXPIRE_DAYS, EXPIRING_DAYS, REMINDER_DAYS };

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Nothing has come back yet: approved or posted, but never received. */
const OPEN_STATUSES = ["APPROVED", "IN_TRANSIT"] as const;

export interface SweepResult {
  reminded: number;
  expiring: number;
  expired: number;
}

/**
 * One pass over every store's open returns.
 *
 * Each of the three steps is governed by its own notification switch, and the
 * expiry step does two things — it closes the request and it tells the
 * customer — which is why the switch reads as one decision in the settings
 * copy rather than two. A merchant who leaves it off keeps the behaviour this
 * app had before any of this existed: returns stay open indefinitely and
 * nobody is chased.
 *
 * Ordered from gentlest to most final, and each shopper gets at most one of
 * the three in a pass: the marks below mean a return that has already been
 * reminded moves on to the next step rather than being reminded again.
 */
export const runReminderSweep = async (): Promise<SweepResult> => {
  const result: SweepResult = { reminded: 0, expiring: 0, expired: 0 };

  /**
   * Candidates are found per store, because the switches are per store and a
   * single query across all of them would fetch returns that are none of this
   * sweep's business.
   */
  const merchants = await prisma.merchant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });

  for (const { id: merchantId } of merchants) {
    const [remindOn, expiringOn, expireOn] = await Promise.all([
      isNotificationEnabled(merchantId, "REMINDER"),
      isNotificationEnabled(merchantId, "EXPIRING"),
      isNotificationEnabled(merchantId, "EXPIRED"),
    ]);
    if (!remindOn && !expiringOn && !expireOn) continue;

    if (expireOn) {
      const due = await prisma.returnRequest.findMany({
        where: {
          merchantId,
          status: { in: [...OPEN_STATUSES] },
          reviewedAt: { lte: daysAgo(EXPIRE_DAYS) },
        },
        select: { id: true },
      });
      for (const request of due) {
        /**
         * Status first, mail second. If the mail fails the request is still
         * closed, which is the state the merchant asked for; the reverse would
         * tell a customer their return had closed when it hadn't.
         */
        await prisma.returnRequest.update({
          where: { id: request.id },
          data: { status: "EXPIRED" },
        });
        await prisma.returnEvent.create({
          data: {
            returnRequestId: request.id,
            type: "STATUS_CHANGED",
            message: `Closed automatically — approved ${EXPIRE_DAYS} days ago and never received`,
          },
        });
        await notify(request.id, "EXPIRED");
        result.expired += 1;
      }
    }

    if (expiringOn) {
      const due = await prisma.returnRequest.findMany({
        where: {
          merchantId,
          status: { in: [...OPEN_STATUSES] },
          reviewedAt: { lte: daysAgo(EXPIRING_DAYS) },
          expiringSentAt: null,
        },
        select: { id: true },
      });
      for (const request of due) {
        await prisma.returnRequest.update({
          where: { id: request.id },
          data: { expiringSentAt: new Date() },
        });
        await notify(request.id, "EXPIRING", {
          days: EXPIRE_DAYS - EXPIRING_DAYS,
        });
        result.expiring += 1;
      }
    }

    if (remindOn) {
      const due = await prisma.returnRequest.findMany({
        where: {
          merchantId,
          status: { in: [...OPEN_STATUSES] },
          reviewedAt: { lte: daysAgo(REMINDER_DAYS) },
          reminderSentAt: null,
        },
        select: { id: true },
      });
      for (const request of due) {
        /**
         * Marked before the send, not after. A mail that fails is a customer
         * who missed one reminder; a mark that fails is a customer reminded
         * again on every pass for the rest of the month.
         */
        await prisma.returnRequest.update({
          where: { id: request.id },
          data: { reminderSentAt: new Date() },
        });
        await notify(request.id, "REMINDER", { days: REMINDER_DAYS });
        result.reminded += 1;
      }
    }
  }

  return result;
};

/** Stops two passes overlapping when one runs long. */
let running = false;

export const runReminderSweepSafely = async (): Promise<void> => {
  if (running) {
    logger.warn("Reminder sweep skipped — the previous pass is still running");
    return;
  }
  running = true;
  try {
    const result = await runReminderSweep();
    if (result.reminded || result.expiring || result.expired) {
      logger.info(result, "Reminder sweep sent notifications");
    }
  } catch (error) {
    // A failed sweep must never take the server with it; the next pass tries
    // again from the same marks.
    logger.error({ err: error }, "Reminder sweep failed");
  } finally {
    running = false;
  }
};
