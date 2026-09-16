import { createHmac } from "node:crypto";
import type { Prisma, ReturnShipment, ReturnStatus, ShipmentProvider } from "@prisma/client";
import { env } from "../../config/env.js";
import { safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { toDecimal } from "../../lib/money.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../email/notifications.js";
import { changeStatus, markReceived } from "../returns/returns.service.js";
import { destinationParty, fullName, shopperParty, type Party, type PhoneRule } from "./addresses.js";
import { getSettings, type ShippingSettingsRow } from "./shipping.settings.js";
import {
  describeStatus,
  normaliseScans,
  outcomeOf,
  parseShiprocketDate as parseCourierDate,
  shipmentStatusFor,
  type Outcome,
} from "./shiprocket.status.js";

/**
 * What every carrier shares: loading the return, writing the shipment,
 * the timeline, moving the return along with the parcel, and the pretend
 * test mode. A carrier module supplies the calls; this supplies the rest.
 */

/** A carrier's refusal, with what it said. */
export class CarrierError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "CarrierError";
  }
}

/** A carrier's refusal, as the merchant should read it. */
export const friendly = (error: unknown, fallback: string): Error => {
  if (error instanceof CarrierError) return unprocessable(error.message);
  if (error instanceof Error && "status" in error) return error;
  return unprocessable(error instanceof Error ? error.message : fallback);
};

export const PROVIDER_NAMES: Record<ShipmentProvider, string> = {
  SHIPROCKET: "Shiprocket",
  DELHIVERY: "Delhivery",
  EASYPOST: "EasyPost",
  SHIPPO: "Shippo",
  SHIPSTATION: "ShipStation",
  SENDCLOUD: "Sendcloud",
};

/** Carriers whose label the shopper prints and drops off, rather than a courier collecting. */
export const DROP_OFF_PROVIDERS: ShipmentProvider[] = ["EASYPOST", "SHIPPO", "SHIPSTATION", "SENDCLOUD"];

/** What each carrier needs of a phone number; see `PhoneRule`. */
export const PHONE_RULES: Record<ShipmentProvider, PhoneRule> = {
  SHIPROCKET: "INDIAN_MOBILE",
  DELHIVERY: "INDIAN_MOBILE",
  EASYPOST: "ANY",
  SHIPPO: "ANY",
  SHIPSTATION: "ANY",
  SENDCLOUD: "ANY",
};

// ---------------------------------------------------------------------------
// The return, as a booking sees it
// ---------------------------------------------------------------------------

export const labelInclude = {
  order: true,
  lineItems: { include: { orderLineItem: true } },
  shipment: true,
  regionalPolicy: { select: { destination: true } },
  merchant: { select: { name: true, email: true } },
} satisfies Prisma.ReturnRequestInclude;

export type LabelRequest = Prisma.ReturnRequestGetPayload<{ include: typeof labelInclude }>;

export const loadForLabel = async (merchantId: string, returnId: string): Promise<LabelRequest> => {
  const request = await prisma.returnRequest.findFirst({
    where: { id: returnId, merchantId },
    include: labelInclude,
  });
  if (!request) throw notFound("Return request not found.");
  return request;
};

export const OPEN_FOR_LABEL: ReturnStatus[] = ["APPROVED", "IN_TRANSIT"];

/** Both ends of the parcel, and what's in it, checked the way every carrier needs. */
export interface Parcel {
  from: Party;
  to: Party;
  items: Array<{ name: string; sku: string; units: number; unitPrice: number; imageUrl: string | null }>;
  /** Shop-currency value of what's coming back. */
  value: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  weightKg: number;
}

/**
 * The parcel for a return: the shopper it's collected from, the destination
 * — the region's own first, then the one chosen under Shipping, then the
 * store default — and the items.
 */
export const parcelFor = async (
  request: LabelRequest,
  settings: ShippingSettingsRow,
  rule: PhoneRule = "INDIAN_MOBILE",
): Promise<Parcel> => {
  const from = await shopperParty(request.merchantId, request.order, request.reference, rule);
  const to = await destinationParty(
    request.merchantId,
    request.regionalPolicy?.destination ?? settings.destination ?? null,
    // The shipping email, when the store gave one: it's what goes on the label.
    settings.shippingEmail ?? request.merchant.email,
    rule,
  );
  const items = request.lineItems
    .filter((line) => !line.keepItem)
    .map((line) => {
      const title = line.orderLineItem?.title ?? "Item";
      const name = line.orderLineItem?.variantTitle ? `${title} - ${line.orderLineItem.variantTitle}` : title;
      return {
        name: name.slice(0, 150),
        sku: (line.orderLineItem?.sku || `line-${line.id}`).slice(0, 50),
        units: line.quantity,
        unitPrice: toDecimal(line.unitPrice).toNumber(),
        imageUrl: line.orderLineItem?.imageUrl ?? null,
      };
    });
  if (items.length === 0) throw unprocessable("Nothing on this return is being sent back.");
  return {
    from,
    to,
    items,
    value: toDecimal(request.itemsSubtotal).toNumber(),
    lengthCm: Number(settings.lengthCm),
    breadthCm: Number(settings.breadthCm),
    heightCm: Number(settings.heightCm),
    weightKg: Number(settings.weightKg),
  };
};

/**
 * Whether a label can be made for this return now, and what a fresh
 * booking should be called at the carrier. Throws in the merchant's words.
 */
export const bookable = (request: LabelRequest) => {
  if (!OPEN_FOR_LABEL.includes(request.status)) {
    throw unprocessable(
      request.status === "SUBMITTED"
        ? "Approve the return first; the label is made for an approved return."
        : "This return is no longer waiting for a parcel.",
    );
  }
  if (request.returnMethod === "KEEP") throw unprocessable("A green return has nothing to ship.");
  const existing = request.shipment;
  const madeBefore = Boolean(existing?.labelUrl);
  if (existing && madeBefore && !["FAILED", "CANCELLED"].includes(existing.status)) {
    throw unprocessable("This return already has a label.");
  }
  return {
    existing,
    madeBefore,
    /** Carriers won't reuse a reference once it failed or was cancelled. */
    orderId: madeBefore
      ? `${request.reference}-${Date.now().toString(36).slice(-4).toUpperCase()}`
      : request.reference,
  };
};

export const saveShipment = (
  returnId: string,
  provider: ShipmentProvider,
  data: Prisma.ReturnShipmentUncheckedUpdateInput,
) =>
  prisma.returnShipment.upsert({
    where: { returnRequestId: returnId },
    create: {
      ...(data as Omit<Prisma.ReturnShipmentUncheckedCreateInput, "returnRequestId">),
      returnRequestId: returnId,
      provider,
    },
    update: data,
  });

export const event = (
  returnId: string,
  actorId: string | null,
  type: "LABEL_GENERATED" | "STATUS_CHANGED",
  message: string,
  metadata?: Prisma.InputJsonValue,
) =>
  prisma.returnEvent.create({
    data: { returnRequestId: returnId, actorId, type, message, metadata },
  });

/** Records a failed step on the shipment and the timeline, then throws it. */
export const failStep = async (
  provider: ShipmentProvider,
  returnId: string,
  actorId: string | null,
  step: string,
  error: unknown,
): Promise<never> => {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn({ provider, returnId, step, message }, "Return label step failed");
  await saveShipment(returnId, provider, { status: "FAILED", lastError: `${step}: ${message}` });
  await event(returnId, actorId, "LABEL_GENERATED", `Couldn't make a return label — ${step}: ${message}`, {
    ok: false,
    step,
    provider,
  });
  throw friendly(error, message);
};

/** Wraps up a booking: the timeline entry and, unless told not to, the email. */
export const finishBooking = async (
  returnId: string,
  actorId: string | null,
  message: string,
  metadata: Prisma.InputJsonValue,
  email: boolean,
): Promise<ReturnShipment> => {
  await event(returnId, actorId, "LABEL_GENERATED", message, metadata);
  if (email) await notify(returnId, "LABEL_READY");
  return prisma.returnShipment.findUniqueOrThrow({ where: { returnRequestId: returnId } });
};

// ---------------------------------------------------------------------------
// Courier quotes
// ---------------------------------------------------------------------------

/** One courier service the merchant can book, priced when the carrier prices it. */
export interface CourierQuote {
  courierId: number;
  name: string;
  /** In `currency`. Null when the carrier bills at contract rates it doesn't quote. */
  rate: number | null;
  /** ISO code of `rate`; rupees when absent, which is what Indian carriers quote in. */
  currency?: string;
  /** The same in the store's currency, when the order's rate makes that possible. */
  shopRate: number | null;
  etd: string | null;
  days: number | null;
  surface: boolean;
  rating: number | null;
  /** The carrier's own pick, which is what a booking without a choice gets. */
  recommended: boolean;
}

/**
 * Rupees into the store's currency, using the order's own exchange rate: an
 * order billed in rupees knows what its shop-currency total was worth. Null
 * when there's no such rate to lean on.
 */
export const rupeesToShop = (order: {
  currency: string;
  total: Prisma.Decimal;
  presentmentCurrency: string | null;
  presentmentTotal: Prisma.Decimal | null;
}): number | null => {
  if (order.currency === "INR") return 1;
  if (order.presentmentCurrency !== "INR" || !order.presentmentTotal) return null;
  const inr = toDecimal(order.presentmentTotal).toNumber();
  const shop = toDecimal(order.total).toNumber();
  return inr > 0 && shop > 0 ? shop / inr : null;
};

export const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Cheapest first; unpriced services last. */
export const byRate = (a: CourierQuote, b: CourierQuote) =>
  (a.rate ?? Number.POSITIVE_INFINITY) - (b.rate ?? Number.POSITIVE_INFINITY);

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export interface TrackingUpdate {
  /** The carrier's own idea of where the parcel is. */
  outcome: Outcome;
  statusId?: number | null;
  statusLabel?: string | null;
  courier?: string | null;
  scans?: unknown;
  etd?: unknown;
  pickedUpAt?: unknown;
  deliveredAt?: unknown;
}

/** Later states never go back to earlier ones on an out-of-order scan. */
const RANK: Record<string, number> = {
  PENDING: 0,
  LABEL_CREATED: 1,
  IN_TRANSIT: 2,
  DELIVERED: 3,
  FAILED: 3,
  CANCELLED: 3,
};

export type TrackedShipment = ReturnShipment & {
  returnRequest: { id: string; merchantId: string; status: ReturnStatus };
};

export const trackedInclude = {
  returnRequest: { select: { id: true, merchantId: true, status: true } },
} as const;

/** Shiprocket's status numbers and labels, for callers that have them. */
export const shiprocketOutcome = outcomeOf;

/**
 * Applies what the courier said to the parcel, and to the return behind it:
 * collected means the return is in transit; delivered means received, where
 * the store has asked for that.
 */
export const applyTracking = async (
  shipment: TrackedShipment,
  update: TrackingUpdate,
  source: "webhook" | "poll",
): Promise<void> => {
  const { returnRequest: request } = shipment;
  const proposed = shipmentStatusFor(update.outcome);
  const next =
    proposed && proposed !== shipment.status && RANK[proposed] >= RANK[shipment.status]
      ? proposed
      : null;
  const label = describeStatus(update.statusLabel);
  const labelChanged = Boolean(label && label !== describeStatus(shipment.externalStatus));

  const data: Prisma.ReturnShipmentUncheckedUpdateInput = {
    lastTrackedAt: new Date(),
    lastError: null,
    ...(update.statusLabel ? { externalStatus: update.statusLabel } : {}),
    ...(typeof update.statusId === "number" ? { externalStatusId: update.statusId } : {}),
    ...(update.courier ? { carrier: update.courier } : {}),
    ...(Array.isArray(update.scans) && update.scans.length
      ? { scans: normaliseScans(update.scans) as unknown as Prisma.InputJsonValue }
      : {}),
    ...(parseCourierDate(update.etd) ? { etd: parseCourierDate(update.etd) } : {}),
  };
  if (next) {
    data.status = next;
    if (next === "IN_TRANSIT" && !shipment.shippedAt) {
      data.shippedAt = parseCourierDate(update.pickedUpAt) ?? new Date();
    }
    if (next === "DELIVERED") {
      data.deliveredAt = parseCourierDate(update.deliveredAt) ?? new Date();
    }
  }
  await prisma.returnShipment.update({ where: { id: shipment.id }, data });

  if (labelChanged || next) {
    await event(
      request.id,
      null,
      "STATUS_CHANGED",
      `Parcel update from ${shipment.carrier ?? update.courier ?? "the courier"}: ${label ?? next}`,
      { shipment: true, source, status: next, externalStatus: update.statusLabel ?? null },
    );
  }

  // The return follows the parcel.
  if (next === "IN_TRANSIT" && request.status === "APPROVED") {
    await changeStatus({
      merchantId: request.merchantId,
      id: request.id,
      to: "IN_TRANSIT",
      message: `Picked up by ${update.courier ?? shipment.carrier ?? "the courier"}`,
    });
  } else if (next === "DELIVERED" && ["APPROVED", "IN_TRANSIT"].includes(request.status)) {
    const settings = await getSettings(request.merchantId);
    if (settings.receiveOnDelivery) {
      await markReceived(request.merchantId, request.id, null);
    }
  }
};

// ---------------------------------------------------------------------------
// Test mode — pretend pickups, for a carrier with no sandbox
// ---------------------------------------------------------------------------

/** The couriers test mode offers, so the choosing can be tried too. */
export const TEST_COURIERS: Array<Omit<CourierQuote, "shopRate" | "recommended">> = [
  { courierId: 900001, name: "Test courier Surface", rate: 120, etd: null, days: 4, surface: true, rating: 4.5 },
  { courierId: 900002, name: "Test courier Express", rate: 260, etd: null, days: 2, surface: false, rating: 4.8 },
];

/** Signs a test label's address, so the page can't be guessed. */
export const testLabelSignature = (shipmentId: string): string =>
  createHmac("sha256", env.JWT_SECRET).update(`test-label:${shipmentId}`).digest("hex").slice(0, 32);

export const testLabelUrl = (shipmentId: string) =>
  `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/test-label/${shipmentId}?sig=${testLabelSignature(shipmentId)}`;

/**
 * A label PDF a carrier handed over rather than hosted, served by this app
 * under a signed link — the same guard as the test label, since the link
 * goes out by email.
 */
export const hostedLabelSignature = (shipmentId: string): string =>
  createHmac("sha256", env.JWT_SECRET).update(`label:${shipmentId}`).digest("hex").slice(0, 32);

export const hostedLabelUrl = (shipmentId: string) =>
  `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/label/${shipmentId}?sig=${hostedLabelSignature(shipmentId)}`;

export const hostedLabelPdf = async (shipmentId: string, sig: string | undefined): Promise<Buffer | null> => {
  if (!sig || !safeEqual(sig, hostedLabelSignature(shipmentId))) return null;
  const shipment = await prisma.returnShipment.findUnique({ where: { id: shipmentId }, select: { labelData: true, status: true } });
  if (!shipment?.labelData || shipment.status === "CANCELLED") return null;
  return Buffer.from(shipment.labelData, "base64");
};

/** "2026-09-13 14:05:00", Indian time, as the couriers' own scans read. */
export const istStamp = (at: Date): string =>
  at.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata", hour12: false }).replace("T", " ");

/**
 * A pretend booking. The addresses and phone numbers were checked the same
 * way a real one checks them — that is most of what test mode is for — and
 * then a made-up courier, AWB and label stand in for the carrier's. The
 * emails and the shopper's page can't tell the difference; the return page
 * can, and offers to simulate the pickup and the delivery.
 */
export const bookTestLabel = async (
  provider: ShipmentProvider,
  request: LabelRequest,
  orderId: string,
  actorId: string | null,
  options: { email?: boolean; courierId?: number | null },
): Promise<ReturnShipment> => {
  const awb = `TEST${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
  const courier =
    TEST_COURIERS.find((c) => c.courierId === options.courierId)?.name ?? TEST_COURIERS[0].name;
  const pickup = new Date();
  pickup.setDate(pickup.getDate() + 1);
  pickup.setHours(14, 0, 0, 0);
  const saved = await saveShipment(request.id, provider, {
    provider,
    isTest: true,
    status: "LABEL_CREATED",
    externalOrderId: `TEST-${orderId}`,
    externalShipmentId: `TEST-${orderId}`,
    externalStatus: "PICKUP SCHEDULED",
    externalStatusId: 4,
    courierId: options.courierId ?? null,
    carrier: courier,
    trackingNumber: awb,
    trackingUrl: null,
    labelUrl: null,
    pickupScheduledAt: pickup,
    pickupToken: "Test booking — no courier is coming",
    scans: [
      {
        date: istStamp(new Date()),
        activity: "Pickup scheduled (test mode)",
        location: "Test mode",
        status: "PICKUP SCHEDULED",
      },
    ],
    shippedAt: null,
    deliveredAt: null,
    lastError: null,
    lastTrackedAt: new Date(),
  });
  await prisma.returnShipment.update({
    where: { id: saved.id },
    data: { labelUrl: testLabelUrl(saved.id) },
  });
  return finishBooking(
    request.id,
    actorId,
    `Test label made with ${courier} — test mode, nothing sent to ${PROVIDER_NAMES[provider]} — AWB ${awb}`,
    { ok: true, test: true, awb, courier, provider },
    options.email !== false,
  );
};

/**
 * Moves a test parcel along by hand: collected, then delivered. Goes through
 * the same tracking path a real scan does, so the return follows.
 */
export const simulateTracking = async (
  merchantId: string,
  returnId: string,
  step: "PICKED_UP" | "DELIVERED",
): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
    include: trackedInclude,
  });
  if (!shipment) throw notFound("This return has no shipment.");
  if (!shipment.isTest) {
    throw unprocessable("Only a test-mode booking can be simulated; a real parcel reports through the carrier.");
  }
  if (["CANCELLED", "DELIVERED", "FAILED"].includes(shipment.status)) {
    throw unprocessable("That parcel is finished.");
  }
  const stamp = istStamp(new Date());
  const scan =
    step === "PICKED_UP"
      ? { outcome: "IN_TRANSIT" as const, statusId: 42, statusLabel: "PICKED UP", activity: "In Transit - Shipment picked up (simulated)" }
      : { outcome: "DELIVERED" as const, statusId: 7, statusLabel: "DELIVERED", activity: "Delivered (simulated)" };
  await applyTracking(
    shipment,
    {
      outcome: scan.outcome,
      statusId: scan.statusId,
      statusLabel: scan.statusLabel,
      courier: shipment.carrier ?? "Test courier",
      scans: [
        { date: stamp, activity: scan.activity, location: "Test mode", status: scan.statusLabel },
        ...normaliseScans(shipment.scans),
      ],
      pickedUpAt: step === "PICKED_UP" ? stamp : undefined,
      deliveredAt: step === "DELIVERED" ? stamp : undefined,
    },
    "poll",
  );
  return prisma.returnShipment.findUniqueOrThrow({ where: { id: shipment.id } });
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The test label, as a printable page. Null when the signature is wrong or
 * the shipment isn't a test one — a real label is the carrier's PDF.
 */
export const testLabelHtml = async (shipmentId: string, sig: string | undefined): Promise<string | null> => {
  if (!sig || !safeEqual(sig, testLabelSignature(shipmentId))) return null;
  const shipment = await prisma.returnShipment.findUnique({
    where: { id: shipmentId },
    include: { returnRequest: { include: labelInclude } },
  });
  if (!shipment?.isTest || !shipment.provider) return null;
  const request = shipment.returnRequest;
  const settings = await getSettings(request.merchantId);
  const parcel = await parcelFor(request, settings);
  const party = (p: Party) =>
    [
      fullName(p),
      p.address1,
      p.address2,
      `${p.city} ${p.state} ${p.pincode}`.replace(/\s+/g, " ").trim(),
      p.country,
      `Phone ${p.phone}`,
    ]
      .filter(Boolean)
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join("");
  const items = parcel.items
    .map((item) => `<li>${escapeHtml(`${item.units} × ${item.name}`)}</li>`)
    .join("");
  const awb = shipment.trackingNumber ?? "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test return label ${escapeHtml(request.reference)}</title>
<style>
  body{margin:0;padding:24px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#111;background:#f4f4f5}
  .label{max-width:640px;margin:0 auto;background:#fff;border:2px solid #111;padding:24px}
  .banner{background:#fff3cd;border:1px solid #e0b33c;padding:10px 14px;font-weight:700;margin-bottom:20px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:20px}
  h2{margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#666}
  .awb{margin:20px 0 8px;font-size:22px;font-weight:700;letter-spacing:.06em}
  .bars{height:56px;background:repeating-linear-gradient(90deg,#111 0 2px,#fff 2px 4px,#111 4px 5px,#fff 5px 9px,#111 9px 12px,#fff 12px 14px);margin-bottom:20px}
  ul{margin:6px 0 0;padding-left:18px}
  .meta{color:#555;font-size:13px;margin-top:16px}
  @media print{body{background:#fff;padding:0}.label{border-width:1px}}
</style></head><body>
<div class="label">
  <div class="banner">TEST LABEL — not valid for shipping. Made in test mode; no courier is coming.</div>
  <div class="row">
    <div><h2>Pickup from</h2>${party(parcel.from)}</div>
    <div><h2>Deliver to</h2>${party(parcel.to)}</div>
  </div>
  <h2>AWB · ${escapeHtml(shipment.carrier ?? "Test courier")}</h2>
  <div class="awb">${escapeHtml(awb)}</div>
  <div class="bars" aria-hidden="true"></div>
  <h2>Return ${escapeHtml(request.reference)} · Order #${escapeHtml(request.order.orderNumber)}</h2>
  <ul>${items}</ul>
  <div class="meta">Parcel ${parcel.lengthCm} × ${parcel.breadthCm} × ${parcel.heightCm} cm, ${parcel.weightKg} kg · ${escapeHtml(request.merchant.name)}</div>
</div>
</body></html>`;
};
