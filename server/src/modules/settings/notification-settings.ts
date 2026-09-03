import type { NotificationKind } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { mailAddress } from "../email/mailer.js";

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
}

export const NOTIFICATIONS: NotificationDefinition[] = [
  {
    kind: "SUBMITTED",
    label: "Return request received",
    description: "Sent when a customer submits a return request.",
  },
  {
    kind: "APPROVED",
    label: "Return request approved",
    description:
      "Sent when you approve a request, with what to send back and a payment link if they owe a difference.",
  },
  {
    kind: "DECLINED",
    label: "Return request declined",
    description: "Sent when you decline a request, with the reason you gave.",
  },
  {
    kind: "RECEIVED",
    label: "Items received",
    description: "Sent when you mark the returned items as received.",
  },
  {
    kind: "RESOLVED",
    label: "Return resolved",
    description:
      "Sent when a return is resolved, carrying the refund, the store credit code or the gift card.",
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
    enabled: byKind.get(definition.kind) ?? true,
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
  return row?.enabled ?? true;
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
