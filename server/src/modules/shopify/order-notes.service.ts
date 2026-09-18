import type { OrderNoteEvent, OrderNoteTarget, Prisma } from "@prisma/client";
import { logger } from "../../lib/logger.js";
import { toDecimal } from "../../lib/money.js";
import { prisma } from "../../lib/prisma.js";
import { queryShop } from "./shopify.client.js";

/**
 * Tags and notes on the shopper's Shopify orders — AfterShip's "Tags and
 * notes". As a return moves along, the original order (and the exchange
 * order the app raised, when there is one) gets a tag the merchant can
 * filter on and a note their staff can read on the order page, without
 * opening this app.
 *
 * Every write is best effort: the return has already moved on, and a
 * store whose token can't write orders shouldn't see approvals fail over
 * a tag. Failures land on the return's timeline instead.
 */

export interface OrderNoteRuleView {
  event: OrderNoteEvent;
  target: OrderNoteTarget;
  enabled: boolean;
  tags: string[];
  note: string;
}

/** The moments, in the order the settings page lists them, with what a fresh store writes. */
export const ORDER_NOTE_DEFAULTS: Array<OrderNoteRuleView & { label: string; description: string }> = [
  {
    event: "SUBMITTED",
    target: "ORIGINAL",
    label: "Return request submitted",
    description: "When a customer submits a return.",
    enabled: true,
    tags: ["Return requested"],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nReturn request submitted\nIncludes items: {SKUs}",
  },
  {
    event: "APPROVED",
    target: "ORIGINAL",
    label: "Return request approved",
    description: "When you approve a return, with the label's tracking number when one was made.",
    enabled: true,
    tags: [],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nReturn request approved\nTracking number: {Tracking no.}",
  },
  {
    event: "RECEIVED",
    target: "ORIGINAL",
    label: "Return items received",
    description: "When the items are marked received.",
    enabled: true,
    tags: [],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nReturn items received",
  },
  {
    event: "REFUNDED_CREDIT",
    target: "ORIGINAL",
    label: "Refunded to store credit",
    description: "When store credit or a gift card is issued for the return.",
    enabled: true,
    tags: [],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nStore credit issued: {Amount} {Currency code}\nGift card: {Gift card ID}\nBonus credit: {Bonus credit} {Currency code}",
  },
  {
    event: "REFUNDED_ORIGINAL",
    target: "ORIGINAL",
    label: "Refunded to original payment method",
    description: "When a refund is issued through Shopify.",
    enabled: true,
    tags: [],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nRefunded: {Amount} {Currency code}",
  },
  {
    event: "EXCHANGE_CREATED",
    target: "ORIGINAL",
    label: "Exchange order created",
    description: "When the exchange's order is created in Shopify.",
    enabled: true,
    tags: [],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nExchange order {Exchange order no.} created\nCredit applied: {Amount} {Currency code}\nBonus credit: {Bonus credit} {Currency code}",
  },
  {
    event: "EXPIRED",
    target: "ORIGINAL",
    label: "Return request expired",
    description: "When a return closes because nothing came back in time.",
    enabled: true,
    tags: ["Return request expired"],
    note: "",
  },
  {
    event: "EXCHANGE_CREATED",
    target: "EXCHANGE",
    label: "Exchange order created",
    description: "Written on the exchange order itself, so it can be traced back to the return.",
    enabled: true,
    tags: ["Exchange order", "{Original order number}"],
    note: "{Date and time}\n[Returns] RMA #{RMA no.}\nExchange for {Original order number}\nCredit applied: {Amount} {Currency code}\nBonus credit: {Bonus credit} {Currency code}",
  },
];

/** The placeholders a merchant can write, as the settings page lists them. */
export const ORDER_NOTE_PLACEHOLDERS = [
  "{Date and time}",
  "{RMA no.}",
  "{Order number}",
  "{Original order number}",
  "{SKUs}",
  "{Items}",
  "{Tracking no.}",
  "{Amount}",
  "{Currency code}",
  "{Bonus credit}",
  "{Gift card ID}",
  "{Exchange order no.}",
  "{Reason}",
  "{Resolution}",
];

const byKey = (event: OrderNoteEvent, target: OrderNoteTarget) => `${event}:${target}`;

/** Every rule, stored ones over defaults. */
export const listOrderNoteRules = async (merchantId: string): Promise<Array<OrderNoteRuleView & { label: string; description: string }>> => {
  const stored = await prisma.orderNoteRule.findMany({ where: { merchantId } });
  const found = new Map(stored.map((r) => [byKey(r.event, r.target), r]));
  return ORDER_NOTE_DEFAULTS.map((d) => {
    const row = found.get(byKey(d.event, d.target));
    return row ? { ...d, enabled: row.enabled, tags: row.tags, note: row.note } : d;
  });
};

export const setOrderNoteRule = async (
  merchantId: string,
  event: OrderNoteEvent,
  target: OrderNoteTarget,
  input: { enabled?: boolean; tags?: string[]; note?: string },
) => {
  const current = (await listOrderNoteRules(merchantId)).find((r) => r.event === event && r.target === target);
  if (!current) return;
  const next = {
    enabled: input.enabled ?? current.enabled,
    tags: (input.tags ?? current.tags).map((t) => t.trim()).filter(Boolean).slice(0, 10),
    note: (input.note ?? current.note).trim().slice(0, 2000),
  };
  await prisma.orderNoteRule.upsert({
    where: { merchantId_event_target: { merchantId, event, target } },
    create: { merchantId, event, target, ...next },
    update: next,
  });
};

/** Whether the store's token may write orders; a scope the earliest installs never asked for. */
export const canWriteOrders = async (merchantId: string): Promise<boolean | null> => {
  try {
    const data = await queryShop<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(
      merchantId,
      `#graphql
        query AppScopes { currentAppInstallation { accessScopes { handle } } }`,
    );
    return data.currentAppInstallation.accessScopes.some((s) => s.handle === "write_orders");
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Writing to Shopify
// ---------------------------------------------------------------------------

const noteInclude = {
  order: { select: { externalId: true, orderNumber: true } },
  lineItems: { include: { orderLineItem: { select: { sku: true, title: true } }, reason: { select: { label: true } } } },
  shipment: { select: { trackingNumber: true } },
  exchangeDraft: { select: { externalOrderId: true, name: true, creditApplied: true } },
  storeCredit: { select: { externalAccountId: true, kind: true, amount: true } },
} satisfies Prisma.ReturnRequestInclude;

type NoteRequest = Prisma.ReturnRequestGetPayload<{ include: typeof noteInclude }>;

/** Figures the caller knows better than the record does: what was just paid, and to where. */
export interface NoteExtras {
  amount?: number | null;
  currency?: string | null;
  giftCardId?: string | null;
  exchangeOrderName?: string | null;
  exchangeOrderId?: string | null;
}

const stamp = (d: Date) =>
  d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Fills a template's placeholders from the return; unknown ones are left as written. */
export const renderOrderNote = (template: string, request: NoteRequest, extras: NoteExtras = {}): string => {
  const sent = request.lineItems.filter((l) => !l.keepItem);
  const skus = [...new Set(sent.map((l) => l.orderLineItem?.sku).filter((s): s is string => Boolean(s)))];
  const titles = [...new Set(sent.map((l) => l.orderLineItem?.title ?? "Item"))];
  const credit = request.storeCredit;
  const values: Record<string, string> = {
    "{Date and time}": stamp(new Date()),
    "{RMA no.}": request.reference,
    "{Order number}": `#${request.order.orderNumber}`,
    "{Original order number}": `#${request.order.orderNumber}`,
    "{SKUs}": skus.length ? skus.join(", ") : titles.join(", "),
    "{Items}": sent.map((l) => `${l.quantity} × ${l.orderLineItem?.title ?? "Item"}`).join(", "),
    "{Tracking no.}": request.shipment?.trackingNumber ?? "—",
    "{Amount}": (extras.amount ?? toDecimal(request.settledTotal ?? request.estimatedTotal).toNumber()).toFixed(2),
    "{Currency code}": extras.currency ?? request.currency,
    "{Bonus credit}": toDecimal(request.bonusCredit).toNumber().toFixed(2),
    "{Gift card ID}": extras.giftCardId ?? credit?.externalAccountId ?? "—",
    "{Exchange order no.}": extras.exchangeOrderName ?? request.exchangeDraft?.name ?? "—",
    "{Reason}": [...new Set(request.lineItems.map((l) => l.reason?.label).filter(Boolean))].join(", ") || "—",
    "{Resolution}": request.resolution.toLowerCase().replace(/_/g, " "),
  };
  return template.replace(/\{[^{}]+\}/g, (m) => values[m] ?? m);
};

const TAGS_ADD = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

const ORDER_NOTE = `#graphql
  query OrderNote($id: ID!) { order(id: $id) { id note } }
`;

const ORDER_UPDATE_NOTE = `#graphql
  mutation OrderNoteUpdate($input: OrderInput!) {
    orderUpdate(input: $input) { userErrors { field message } }
  }
`;

const errorsOf = (errors: Array<{ message: string }>) => errors.map((e) => e.message).join("; ");

/**
 * Writes one moment's tags and note onto one order. Tags are added, never
 * replaced; the note is appended under whatever the merchant already wrote.
 */
const writeOrder = async (merchantId: string, orderGid: string, tags: string[], note: string): Promise<{ tags: string[]; note: boolean }> => {
  if (tags.length) {
    const data = await queryShop<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(merchantId, TAGS_ADD, { id: orderGid, tags });
    if (data.tagsAdd.userErrors.length) throw new Error(`tags: ${errorsOf(data.tagsAdd.userErrors)}`);
  }
  if (note) {
    const current = await queryShop<{ order: { note: string | null } | null }>(merchantId, ORDER_NOTE, { id: orderGid });
    const existing = current.order?.note?.trim() ?? "";
    const merged = (existing ? `${existing}\n\n${note}` : note).slice(0, 5000);
    const data = await queryShop<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(merchantId, ORDER_UPDATE_NOTE, {
      input: { id: orderGid, note: merged },
    });
    if (data.orderUpdate.userErrors.length) throw new Error(`note: ${errorsOf(data.orderUpdate.userErrors)}`);
  }
  return { tags, note: Boolean(note) };
};

/**
 * Applies the rules for one moment to the return's orders. Never throws:
 * the moment has already happened, so a refusal goes on the timeline.
 */
export const annotateOrders = async (merchantId: string, returnId: string, event: OrderNoteEvent, extras: NoteExtras = {}): Promise<void> => {
  const request = await prisma.returnRequest.findFirst({ where: { id: returnId, merchantId }, include: noteInclude });
  if (!request?.order.externalId) return;
  // A store with no Shopify connection has no order page to write on; say nothing rather than fail every return.
  const connected = await prisma.integration.findFirst({
    where: { merchantId, provider: "SHOPIFY", active: true, accessToken: { not: null } },
    select: { id: true },
  });
  if (!connected) return;
  const rules = (await listOrderNoteRules(merchantId)).filter((r) => r.event === event && r.enabled && (r.tags.length || r.note));
  for (const rule of rules) {
    const orderGid =
      rule.target === "ORIGINAL" ? request.order.externalId : (extras.exchangeOrderId ?? request.exchangeDraft?.externalOrderId ?? null);
    if (!orderGid) continue;
    const tags = rule.tags.map((t) => renderOrderNote(t, request, extras).slice(0, 40)).filter(Boolean);
    const note = renderOrderNote(rule.note, request, extras);
    const where = rule.target === "ORIGINAL" ? `order #${request.order.orderNumber}` : `exchange order ${extras.exchangeOrderName ?? request.exchangeDraft?.name ?? ""}`.trim();
    try {
      await writeOrder(merchantId, orderGid, tags, note);
      await prisma.returnEvent.create({
        data: {
          returnRequestId: returnId,
          type: "NOTE_ADDED",
          message: `${tags.length ? `Tagged ${where} "${tags.join('", "')}"` : `Noted ${where}`}${tags.length && note ? " and added a note" : ""} in Shopify`,
          metadata: { orderNote: true, event, target: rule.target, tags },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ merchantId, returnId, event, target: rule.target, message }, "Couldn't write order tags/notes to Shopify");
      await prisma.returnEvent.create({
        data: {
          returnRequestId: returnId,
          type: "NOTE_ADDED",
          message: `Couldn't ${tags.length ? "tag" : "note"} ${where} in Shopify: ${message}${/access|scope|permission/i.test(message) ? " — the app needs the write_orders permission; reconnect the store under Settings → General to grant it" : ""}`,
          metadata: { orderNote: true, event, target: rule.target, ok: false },
        },
      });
    }
  }
};

/** Fire and forget, for the moments where nothing should wait on Shopify. */
export const annotateOrdersInBackground = (merchantId: string, returnId: string, event: OrderNoteEvent, extras: NoteExtras = {}): void => {
  void annotateOrders(merchantId, returnId, event, extras).catch((error) => {
    logger.warn({ merchantId, returnId, event, err: error }, "Order tags/notes failed");
  });
};
