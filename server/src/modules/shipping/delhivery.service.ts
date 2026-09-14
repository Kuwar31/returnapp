import type { DelhiveryAccount, ReturnShipment } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName } from "./addresses.js";
import * as api from "./delhivery.client.js";
import { delhiveryOutcome, delhiveryScans } from "./delhivery.status.js";
import {
  CarrierError,
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  saveShipment,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
  type TrackedShipment,
} from "./shipments.js";

/**
 * Delhivery as a return-label carrier, used directly.
 *
 * A reverse pickup is one manifest call: Delhivery hands back the waybill,
 * schedules the collection from the shopper itself, and prints the label
 * on request. There's no rate to quote — a direct account bills at its
 * contract rates — only whether the two postcodes are served. Its staging
 * environment is the test mode: the same calls, nothing charged.
 */

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) =>
  prisma.delhiveryAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: DelhiveryAccount) => ({
  connectedAt: account.createdAt,
  staging: account.staging,
  warehouseName: account.warehouseName,
});

const envFor = (account: DelhiveryAccount): api.Env => {
  let token: string;
  try {
    token = decrypt(account.token);
  } catch {
    throw unprocessable("The saved Delhivery token can't be read — reconnect Delhivery in settings.");
  }
  return { token, staging: account.staging };
};

/** A postcode Delhivery is bound to know, to prove a token works. */
const PROBE_PIN = "110001";

/** Proves the token works against the chosen environment, then keeps it. */
export const connectAccount = async (
  merchantId: string,
  token: string,
  staging: boolean,
  warehouseName: string,
) => {
  if (!env.ENCRYPTION_KEY) {
    throw unprocessable("This server has no ENCRYPTION_KEY, so it can't keep a Delhivery token.");
  }
  try {
    await api.pincode({ token, staging }, PROBE_PIN);
  } catch (error) {
    throw friendly(error, "Delhivery didn't accept that token.");
  }
  return prisma.delhiveryAccount.upsert({
    where: { merchantId },
    create: { merchantId, token: encrypt(token), staging, warehouseName },
    update: { token: encrypt(token), staging, warehouseName },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.delhiveryAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (
  merchantId: string,
  input: { staging?: boolean; warehouseName?: string },
) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Delhivery isn't connected.");
  return prisma.delhiveryAccount.update({ where: { merchantId }, data: input });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Delhivery isn't connected.");
  try {
    await api.pincode(envFor(account), PROBE_PIN);
  } catch (error) {
    throw friendly(error, "Couldn't reach Delhivery.");
  }
  return { ok: true, staging: account.staging };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

export const trackingUrlFor = (waybill: string) =>
  `https://www.delhivery.com/track/package/${encodeURIComponent(waybill)}`;

/** Delhivery's one service, once both postcodes are known to be served. */
export const quote = async (account: DelhiveryAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  const e = envFor(account);
  const served = async (pin: string, field: "pickup" | "pre_paid") => {
    const reply = await api.pincode(e, pin);
    const code = reply.delivery_codes?.[0]?.postal_code;
    return Boolean(code && (code[field] ?? "Y").toString().toUpperCase() === "Y");
  };
  try {
    if (!(await served(parcel.from.pincode, "pickup"))) {
      throw unprocessable(`Delhivery doesn't collect from postcode ${parcel.from.pincode}.`);
    }
    if (!(await served(parcel.to.pincode, "pre_paid"))) {
      throw unprocessable(`Delhivery doesn't deliver to postcode ${parcel.to.pincode}.`);
    }
  } catch (error) {
    throw friendly(error, "Delhivery couldn't check those postcodes.");
  }
  return [
    {
      courierId: 1,
      name: account.staging ? "Delhivery Surface (staging)" : "Delhivery Surface",
      rate: null,
      shopRate: null,
      etd: null,
      days: null,
      surface: true,
      rating: null,
      recommended: true,
    },
  ];
};

/** Delhivery's manifest for a reverse pickup. Weight is in grams there. */
const shipmentInput = (
  request: LabelRequest,
  parcel: Parcel,
  orderId: string,
): api.ReverseShipmentInput => ({
  name: fullName(parcel.from),
  add: [parcel.from.address1, parcel.from.address2].filter(Boolean).join(", "),
  pin: parcel.from.pincode,
  city: parcel.from.city,
  state: parcel.from.state,
  country: parcel.from.country,
  phone: parcel.from.phone,
  order: orderId,
  payment_mode: "Pickup",
  return_pin: parcel.to.pincode,
  return_city: parcel.to.city,
  return_phone: parcel.to.phone,
  return_add: [parcel.to.address1, parcel.to.address2].filter(Boolean).join(", "),
  return_state: parcel.to.state,
  return_country: parcel.to.country,
  products_desc: parcel.items.map((i) => `${i.units} x ${i.name}`).join("; ").slice(0, 200),
  hsn_code: "",
  cod_amount: "0",
  order_date: null,
  total_amount: String(parcel.value),
  seller_add: [parcel.to.address1, parcel.to.city].join(", "),
  seller_name: request.merchant.name,
  seller_inv: request.reference,
  quantity: String(parcel.items.reduce((sum, i) => sum + i.units, 0)),
  waybill: "",
  shipment_width: String(parcel.breadthCm),
  shipment_height: String(parcel.heightCm),
  shipment_length: String(parcel.lengthCm),
  weight: String(Math.round(parcel.weightKg * 1000)),
  shipping_mode: "Surface",
  address_type: "home",
});

/**
 * Manifests the reverse pickup and fetches the label. Delhivery books the
 * collection from the shopper itself, so there's no pickup call to make.
 */
export const book = async (
  request: LabelRequest,
  account: DelhiveryAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("DELHIVERY", returnId, actorId, step, error);
  const courier = account.staging ? "Delhivery Surface (staging)" : "Delhivery Surface";

  let waybill: string;
  try {
    const reply = await api.createShipment(e, account.warehouseName, shipmentInput(request, parcel, orderId));
    const pkg = reply?.packages?.[0];
    const remarks = Array.isArray(pkg?.remarks) ? pkg.remarks.join(" ") : (pkg?.remarks ?? reply?.rmk ?? "");
    if (!pkg || pkg.status !== "Success" || !pkg.waybill) {
      throw new CarrierError(remarks || "Delhivery didn't accept the shipment.", 200, reply);
    }
    waybill = pkg.waybill;
    await saveShipment(returnId, "DELHIVERY", {
      provider: "DELHIVERY",
      isTest: account.staging,
      status: "PENDING",
      courierId: 1,
      externalOrderId: orderId,
      externalShipmentId: waybill,
      externalStatus: "Manifested",
      externalStatusId: null,
      carrier: courier,
      trackingNumber: waybill,
      trackingUrl: trackingUrlFor(waybill),
      labelUrl: null,
      pickupScheduledAt: null,
      pickupToken: null,
      scans: [],
      shippedAt: null,
      deliveredAt: null,
      lastError: null,
    });
  } catch (error) {
    return fail("manifesting the shipment", error);
  }

  try {
    const reply = await api.packingSlip(e, waybill);
    const link = reply?.packages?.[0]?.pdf_download_link;
    if (!link) throw new CarrierError("Delhivery made no label for the waybill.", 200, reply);
    await saveShipment(returnId, "DELHIVERY", { labelUrl: link, status: "LABEL_CREATED", lastError: null });
  } catch (error) {
    return fail("printing the label", error);
  }

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${courier}, waybill ${waybill}${account.staging ? " — staging, nothing charged" : ""}`,
    { ok: true, awb: waybill, courier, provider: "DELHIVERY", staging: account.staging },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

/** Asks Delhivery about one parcel and applies the answer. */
export const refresh = async (account: DelhiveryAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber) throw notFound("This return has no Delhivery waybill.");
  let reply: api.TrackReply;
  try {
    reply = await api.track(envFor(account), shipment.trackingNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` },
    });
    throw friendly(error, message);
  }
  const s = reply?.ShipmentData?.[0]?.Shipment;
  if (!s?.Status?.Status) {
    // Nothing scanned yet — the usual state on staging, and right after booking.
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: null },
    });
    return;
  }
  await applyTracking(
    shipment,
    {
      outcome: delhiveryOutcome(s.Status.Status, s.Status.StatusType),
      statusLabel: s.Status.Status,
      courier: shipment.carrier,
      scans: delhiveryScans(s.Scans),
      etd: s.ExpectedDeliveryDate,
      pickedUpAt: s.PickUpDate,
      deliveredAt: s.DeliveryDate,
    },
    "poll",
  );
};

/** Calls the collection off at Delhivery; returns what it refused, if anything. */
export const cancelCalls = async (account: DelhiveryAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.trackingNumber) return [];
  try {
    await api.cancel(envFor(account), shipment.trackingNumber);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};
