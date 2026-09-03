import type { NotificationKind } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { mailAddress } from "../email/mailer.js";
import {
  EXPIRE_DAYS,
  EXPIRING_DAYS,
  REMINDER_DAYS,
} from "../returns/reminder-windows.js";

/**
 * The emails this app sends a customer, and whether a store sends them.
 *
 * The catalogue lives here rather than in the admin so the two can't drift: a
 * notification added to the code appears on the settings page by existing, and
 * one described here that nothing sends would be a promise to a merchant that
 * the app doesn't keep. Every entry below maps to a real call to `notify`.
 */
export interface NotificationDefinition {
  kind: NotificationKind;
  label: string;
  description: string;
  /**
   * What a store that has never touched this page does.
   *
   * The five that existed before this page did are on, because turning them
   * off by migration would be a behaviour change nobody asked for. The ones
   * that chase a customer, or close their request, are off: those are a
   * decision about how a store talks to people, and it should be made rather
   * than inherited.
   */
  defaultEnabled: boolean;
}

export const NOTIFICATIONS: NotificationDefinition[] = [
  {
    kind: "SUBMITTED",
    label: "Return request received",
    description: "Sent when a customer submits a return request.",
    defaultEnabled: true,
  },
  {
    kind: "APPROVED",
    label: "Return request approved",
    description:
      "Sent when you approve a request, with what to send back and a payment link if they owe a difference.",
    defaultEnabled: true,
  },
  {
    kind: "EDITED",
    label: "Return request edited",
    description:
      "Sent when inspecting the items changes what the customer gets — accepting fewer than they sent, or letting them keep one.",
    defaultEnabled: false,
  },
  {
    kind: "DECLINED",
    label: "Return request declined",
    description: "Sent when you decline a request, with the reason you gave.",
    defaultEnabled: true,
  },
  {
    kind: "REMINDER",
    label: "Return reminder",
    description: `Sent when a return still hasn't reached you ${REMINDER_DAYS} days after you approved it.`,
    defaultEnabled: false,
  },
  {
    kind: "EXPIRING",
    label: "Request expiration reminder",
    description: `Sent ${EXPIRING_DAYS} days after approval, warning that the request closes in ${EXPIRE_DAYS - EXPIRING_DAYS} days.`,
    defaultEnabled: false,
  },
  {
    kind: "EXPIRED",
    label: "Return request expired",
    description: `Closes a request approved ${EXPIRE_DAYS} days ago that never arrived, and tells the customer they can start a new one. Off means requests stay open indefinitely.`,
    defaultEnabled: false,
  },
  {
    kind: "RECEIVED",
    label: "Items received",
    description: "Sent when you mark the returned items as received.",
    defaultEnabled: true,
  },
  {
    kind: "RESOLVED",
    label: "Return resolved",
    description:
      "Sent when a return is resolved, carrying the refund, the store credit code or the gift card.",
    defaultEnabled: true,
  },
];

/**
 * What the settings page shows: every notification, with the store's answer.
 *
 * A missing row reads as enabled, so a store that has never opened this page
 * is described exactly as it behaves.
 */
export const listNotificationSettings = async (merchantId: string) => {
  const rows = await prisma.notificationSetting.findMany({
    where: { merchantId },
    select: { kind: true, enabled: true },
  });
  const byKind = new Map(rows.map((r) => [r.kind, r.enabled]));

  return NOTIFICATIONS.map((definition) => ({
    ...definition,
    enabled: byKind.get(definition.kind) ?? definition.defaultEnabled,
  }));
};

export const setNotificationEnabled = (
  merchantId: string,
  kind: NotificationKind,
  enabled: boolean,
) =>
  prisma.notificationSetting.upsert({
    where: { merchantId_kind: { merchantId, kind } },
    create: { merchantId, kind, enabled },
    update: { enabled },
  });

/**
 * Whether one notification should go out.
 *
 * Consulted by the sender rather than by each of the five call sites: a switch
 * that only works where somebody remembered to check it isn't a switch. Reads
 * as enabled if the lookup itself fails — a database hiccup shouldn't silently
 * stop a store's customer mail.
 */
export const isNotificationEnabled = async (
  merchantId: string,
  kind: NotificationKind,
): Promise<boolean> => {
  const row = await prisma.notificationSetting.findUnique({
    where: { merchantId_kind: { merchantId, kind } },
    select: { enabled: true },
  });
  if (row) return row.enabled;
  return (
    NOTIFICATIONS.find((n) => n.kind === kind)?.defaultEnabled ?? true
  );
};

export interface Sender {
  /** The display name customers see in their inbox. */
  name: string;
  /** The address mail actually leaves from — the platform's, not the store's. */
  address: string;
  /** Where a reply lands, when the store has given a support address. */
  replyTo: string | null;
}

/**
 * Who a store's mail comes from.
 *
 * The address is the platform's own and is not the merchant's to change. Mail
 * claiming to be from a domain we hold no DKIM key for is either rejected
 * outright or filed as spam, so offering that field would be offering a way to
 * stop reaching customers. What a merchant can set is the name beside it, and
 * a support address for replies — which together is what a customer reads.
 */
export const resolveSender = async (merchantId: string): Promise<Sender> => {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { name: true, senderName: true, branding: { select: { supportEmail: true } } },
  });

  return {
    name: merchant?.senderName?.trim() || merchant?.name || "Returns",
    address: mailAddress(env.MAIL_FROM),
    replyTo: merchant?.branding?.supportEmail ?? null,
  };
};
