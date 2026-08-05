import type { ReturnStatus } from "@prisma/client";
import { conflict } from "../../lib/errors.js";

/**
 * Legal status transitions. Everything that changes a return's status goes
 * through assertTransition so an invalid jump fails loudly instead of
 * silently corrupting the timeline.
 */
const TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["IN_TRANSIT", "RECEIVED", "CANCELLED", "EXPIRED"],
  REJECTED: [],
  IN_TRANSIT: ["RECEIVED", "EXPIRED"],
  RECEIVED: ["RESOLVED"],
  RESOLVED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canTransition = (
  from: ReturnStatus,
  to: ReturnStatus,
): boolean => TRANSITIONS[from].includes(to);

export const assertTransition = (from: ReturnStatus, to: ReturnStatus) => {
  if (!canTransition(from, to)) {
    throw conflict(
      `A return that is ${from.toLowerCase()} can't be moved to ${to.toLowerCase()}.`,
    );
  }
};

/** Statuses the shopper can no longer act on. */
export const TERMINAL_STATUSES: ReturnStatus[] = [
  "REJECTED",
  "RESOLVED",
  "CANCELLED",
  "EXPIRED",
];

export const isTerminal = (status: ReturnStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

/** Human-readable label for the portal timeline and admin badges. */
export const STATUS_LABELS: Record<ReturnStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Declined",
  IN_TRANSIT: "On its way back",
  RECEIVED: "Received",
  RESOLVED: "Resolved",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};
