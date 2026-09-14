import { randomBytes } from "node:crypto";
import type { ReturnShipment, ShiprocketAccount } from "@prisma/client";
import { env } from "../../config/env.js";
import { encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { fullName } from "./addresses.js";
import * as api from "./shiprocket.client.js";
import { ShiprocketError } from "./shiprocket.client.js";
import { outcomeOf, parseShiprocketDate } from "./shiprocket.status.js";
import {
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  num,
  saveShipment,
  trackedInclude,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
  type TrackedShipment,
} from "./shipments.js";

/**
 * Shiprocket as a return-label carrier.
 *
 * A reverse pickup takes four calls — create the return order, assign a
 * courier and AWB, print the label, book the pickup — and each is
 * resumable, so a failure halfway is retried from where it stopped rather
 * than booking a second parcel. Tracking comes back through Shiprocket's
 * webhook, or by asking.
 */

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/** Tokens last 240 hours; refresh with a day to spare. */
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;

const newSecret = () => randomBytes(24).toString("hex");

/** Where Shiprocket posts tracking events. Must not contain "shiprocket". */
export const webhookUrl = () => `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/events`;

export const getAccount = (merchantId: string) =>
  prisma.shiprocketAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: ShiprocketAccount) => ({
  email: account.email,
  connectedAt: account.createdAt,
  tokenExpiresAt: account.tokenExpiresAt,
  webhookUrl: webhookUrl(),
  webhookSecret: account.webhookSecret,
  testMode: account.testMode,
  qcEnabled: account.qcEnabled,
});

/** Proves the API user works, then keeps it. */
export const connectAccount = async (merchantId: string, email: string, password: string) => {
  if (!env.ENCRYPTION_KEY) {
    throw unprocessable("This server has no ENCRYPTION_KEY, so it can't keep a Shiprocket password.");
  }
  let token: string;
  try {
    token = await api.login(email, password);
  } catch (error) {
    throw friendly(error, "Shiprocket didn't accept those details.");
  }
  const tokenExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  return prisma.shiprocketAccount.upsert({
    where: { merchantId },
    create: { merchantId, email, password: encrypt(password), token, tokenExpiresAt, webhookSecret: newSecret() },
    update: { email, password: encrypt(password), token, tokenExpiresAt },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.shiprocketAccount.deleteMany({ where: { merchantId } });
};

export interface AccountInput {
  testMode?: boolean;
  qcEnabled?: boolean;
}

export const updateAccount = async (merchantId: string, input: AccountInput) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  return prisma.shiprocketAccount.update({ where: { merchantId }, data: input });
};

export const rotateWebhookSecret = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  return prisma.shiprocketAccount.update({ where: { merchantId }, data: { webhookSecret: newSecret() } });
};

/** Logs in afresh, so "Test connection" says something true. */
export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  await prisma.shiprocketAccount.update({ where: { merchantId }, data: { token: null } });
  try {
    await api.call(merchantId, "GET", "/settings/company/pickup");
  } catch (error) {
    throw friendly(error, "Couldn't reach Shiprocket.");
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

export const trackingUrlFor = (awb: string) => `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;

/** "2024-03-08 14:05", Shiprocket's order date. */
const orderDate = (at: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
};

const returnOrderInput = (
  request: LabelRequest,
  account: ShiprocketAccount,
  parcel: Parcel,
  orderId: string,
): api.ReturnOrderInput => ({
  order_id: orderId,
  order_date: orderDate(request.submittedAt),
  pickup_customer_name: parcel.from.firstName,
  pickup_last_name: parcel.from.lastName,
  pickup_address: parcel.from.address1,
  pickup_address_2: parcel.from.address2,
  pickup_city: parcel.from.city,
  pickup_state: parcel.from.state,
  pickup_country: parcel.from.country,
  pickup_pincode: parcel.from.pincode,
  pickup_email: parcel.from.email,
  pickup_phone: parcel.from.phone,
  pickup_isd_code: "91",
  shipping_customer_name: parcel.to.firstName,
  shipping_last_name: parcel.to.lastName,
  shipping_address: parcel.to.address1,
  shipping_address_2: parcel.to.address2,
  shipping_city: parcel.to.city,
  shipping_country: parcel.to.country,
  shipping_pincode: parcel.to.pincode,
  shipping_state: parcel.to.state,
  shipping_email: parcel.to.email,
  shipping_isd_code: "91",
  shipping_phone: parcel.to.phone,
  order_items: parcel.items.map((item) => ({
    name: item.name,
    sku: item.sku,
    units: item.units,
    selling_price: item.unitPrice,
    discount: 0,
    qc_enable: account.qcEnabled,
    ...(account.qcEnabled
      ? { qc_product_name: item.name, ...(item.imageUrl ? { qc_product_image: item.imageUrl } : {}) }
      : {}),
  })),
  payment_method: "PREPAID",
  total_discount: 0,
  sub_total: parcel.value,
  length: parcel.lengthCm,
  breadth: parcel.breadthCm,
  height: parcel.heightCm,
  weight: parcel.weightKg,
});

/** The couriers Shiprocket offers for this pickup, cheapest first. */
export const quote = async (merchantId: string, parcel: Parcel): Promise<CourierQuote[]> => {
  let reply: api.ServiceabilityReply;
  try {
    reply = await api.checkServiceability(merchantId, {
      pickupPostcode: parcel.from.pincode,
      deliveryPostcode: parcel.to.pincode,
      weightKg: parcel.weightKg,
      declaredValue: parcel.value,
      lengthCm: parcel.lengthCm,
      breadthCm: parcel.breadthCm,
      heightCm: parcel.heightCm,
    });
  } catch (error) {
    throw friendly(error, "Shiprocket couldn't quote this pickup.");
  }
  const recommended =
    reply.data?.recommended_courier_company_id ?? reply.data?.shiprocket_recommended_courier_id ?? null;
  return (reply.data?.available_courier_companies ?? []).flatMap((c): CourierQuote[] => {
    const rate = num(c.rate) ?? num(c.freight_charge);
    if (rate === null || !c.courier_company_id) return [];
    return [
      {
        courierId: c.courier_company_id,
        name: c.courier_name,
        rate,
        shopRate: null,
        etd: c.etd || null,
        days: num(c.estimated_delivery_days),
        surface: c.is_surface ?? true,
        rating: num(c.rating),
        recommended: c.courier_company_id === recommended,
      },
    ];
  });
};

/**
 * Books the pickup, resuming a half-made one: a shipment that stopped
 * partway — order made, no courier yet — carries on from there.
 */
export const book = async (
  merchantId: string,
  request: LabelRequest,
  account: ShiprocketAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const existing = request.shipment;
  const resume = existing && !existing.labelUrl && existing.externalShipmentId ? existing : null;
  const fail = (step: string, error: unknown) => failStep("SHIPROCKET", returnId, actorId, step, error);

  let shipmentId = resume?.externalShipmentId ?? null;
  let awb = resume?.trackingNumber ?? null;
  let courier = resume?.carrier ?? null;
  await saveShipment(returnId, "SHIPROCKET", { courierId: options.courierId });

  if (!shipmentId) {
    try {
      const reply = await api.createReturnOrder(merchantId, returnOrderInput(request, account, parcel, orderId));
      if (!reply?.shipment_id) throw new ShiprocketError("Shiprocket made no shipment for the return.", 200, reply);
      shipmentId = String(reply.shipment_id);
      await saveShipment(returnId, "SHIPROCKET", {
        provider: "SHIPROCKET",
        isTest: false,
        status: "PENDING",
        externalOrderId: String(reply.order_id),
        externalShipmentId: shipmentId,
        externalStatus: reply.status ?? null,
        externalStatusId: reply.status_code ?? null,
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        labelUrl: null,
        pickupScheduledAt: null,
        pickupToken: null,
        scans: [],
        shippedAt: null,
        deliveredAt: null,
        lastError: null,
      });
    } catch (error) {
      return fail("creating the return order", error);
    }
  }

  if (!awb) {
    try {
      const reply = await api.assignAwb(merchantId, shipmentId, options.courierId);
      const data = reply?.response?.data;
      if (reply?.awb_assign_status !== 1 || !data?.awb_code) {
        throw new ShiprocketError(
          data?.awb_assign_error ?? "Shiprocket couldn't assign a courier to the pickup.",
          200,
          reply,
        );
      }
      awb = data.awb_code;
      courier = data.courier_name ?? null;
      await saveShipment(returnId, "SHIPROCKET", {
        carrier: courier,
        trackingNumber: awb,
        trackingUrl: trackingUrlFor(awb),
        pickupScheduledAt: parseShiprocketDate(data.pickup_scheduled_date),
        lastError: null,
      });
    } catch (error) {
      return fail("assigning a courier", error);
    }
  }

  try {
    const reply = await api.generateLabel(merchantId, shipmentId);
    if (!reply?.label_url) throw new ShiprocketError(reply?.response || "Shiprocket made no label.", 200, reply);
    await saveShipment(returnId, "SHIPROCKET", { labelUrl: reply.label_url, status: "LABEL_CREATED", lastError: null });
  } catch (error) {
    return fail("printing the label", error);
  }

  // The pickup is asked for last, and a refusal here doesn't undo the label:
  // the parcel exists and can be booked again from the return.
  let pickupNote = "";
  try {
    const reply = await api.requestPickup(merchantId, shipmentId);
    const scheduled = reply?.response?.pickup_scheduled_date ?? reply?.pickup_scheduled_date;
    const token = reply?.response?.pickup_token_number ?? reply?.pickup_token_number;
    await saveShipment(returnId, "SHIPROCKET", {
      pickupScheduledAt: parseShiprocketDate(scheduled) ?? undefined,
      pickupToken: token ?? undefined,
    });
    if (scheduled) pickupNote = `, pickup ${scheduled}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate/i.test(message)) {
      await saveShipment(returnId, "SHIPROCKET", { lastError: `booking the pickup: ${message}` });
      pickupNote = ` — pickup not booked yet: ${message}`;
    }
  }

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${courier ?? "Shiprocket"}, AWB ${awb}${pickupNote}`,
    { ok: true, awb, courier, shipmentId, provider: "SHIPROCKET", collectFrom: fullName(parcel.from) },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

/** Asks Shiprocket about one parcel and applies the answer. */
export const refresh = async (merchantId: string, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.externalShipmentId) throw notFound("This return has no Shiprocket shipment.");
  let reply: api.TrackingReply;
  try {
    reply = await api.trackShipment(merchantId, shipment.externalShipmentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` },
    });
    throw friendly(error, message);
  }
  const t = reply?.tracking_data;
  const track = t?.shipment_track?.[0];
  if (!t || t.track_status === 0 || !track) {
    // Nothing scanned yet, which is normal right after booking.
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: null },
    });
    return;
  }
  await applyTracking(
    shipment,
    {
      outcome: outcomeOf(t.shipment_status ?? null, track.current_status ?? null),
      statusId: t.shipment_status ?? null,
      statusLabel: track.current_status ?? null,
      courier: track.courier_name ?? null,
      scans: t.shipment_track_activities,
      etd: t.etd ?? track.edd,
      pickedUpAt: track.pickup_date,
      deliveredAt: track.delivered_date,
    },
    "poll",
  );
};

/** Calls the courier off at Shiprocket; returns what it refused, if anything. */
export const cancelCalls = async (merchantId: string, shipment: ReturnShipment): Promise<string[]> => {
  const problems: string[] = [];
  if (shipment.trackingNumber) {
    try {
      await api.cancelShipment(merchantId, shipment.trackingNumber);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (shipment.externalOrderId) {
    try {
      await api.cancelOrder(merchantId, shipment.externalOrderId);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
};

/**
 * A tracking event from Shiprocket's webhook. The `x-api-key` header names
 * the store; the AWB (or Shiprocket's order id) names the parcel. Events for
 * parcels we didn't make — the store's forward shipments — are ignored.
 */
export const handleWebhook = async (
  apiKey: string | undefined,
  payload: unknown,
): Promise<"unauthorized" | "ignored" | "applied"> => {
  if (!apiKey) return "unauthorized";
  const account = await prisma.shiprocketAccount.findUnique({ where: { webhookSecret: apiKey } });
  if (!account) return "unauthorized";
  if (!payload || typeof payload !== "object") return "ignored";
  const p = payload as Record<string, unknown>;
  const awb = typeof p.awb === "string" || typeof p.awb === "number" ? String(p.awb) : "";
  const srOrderId = p.sr_order_id !== undefined && p.sr_order_id !== null ? String(p.sr_order_id) : "";
  if (!awb && !srOrderId) return "ignored";

  const shipment = await prisma.returnShipment.findFirst({
    where: {
      provider: "SHIPROCKET",
      returnRequest: { merchantId: account.merchantId },
      OR: [...(awb ? [{ trackingNumber: awb }] : []), ...(srOrderId ? [{ externalOrderId: srOrderId }] : [])],
    },
    include: trackedInclude,
  });
  if (!shipment) return "ignored";

  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const statusId = num(p.shipment_status_id) ?? num(p.current_status_id);
  const statusLabel = text(p.shipment_status) ?? text(p.current_status);
  await applyTracking(
    shipment,
    {
      outcome: outcomeOf(statusId, statusLabel),
      statusId,
      statusLabel,
      courier: text(p.courier_name),
      scans: p.scans,
      etd: p.etd,
    },
    "webhook",
  );
  logger.debug({ awb, statusLabel }, "Shiprocket webhook applied");
  return "applied";
};
