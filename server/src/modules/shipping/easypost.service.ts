import type { EasyPostAccount, ReturnShipment } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { decrypt, encrypt, safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import * as api from "./easypost.client.js";
import { easypostLabel, easypostOutcome, easypostScans } from "./easypost.status.js";
import {
  CarrierError,
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  saveShipment,
  trackedInclude,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
  type TrackedShipment,
} from "./shipments.js";

/**
 * EasyPost as a return-label carrier.
 *
 * One API key fronts every carrier account the store has connected to
 * EasyPost — USPS, UPS, FedEx, DHL and the rest — so a quote is one call
 * that returns every carrier's rates, and a booking buys one of them. The
 * label is a drop-off label: the shopper prints it and hands the parcel
 * to the carrier, rather than a courier coming to the door. A test key
 * makes the same calls against test labels, which is the test mode.
 */

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const webhookUrl = () => `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/easypost/events`;

export const getAccount = (merchantId: string) => prisma.easyPostAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: EasyPostAccount) => ({
  connectedAt: account.createdAt,
  testMode: account.testMode,
  webhookUrl: webhookUrl(),
  webhookSecret: account.webhookSecret,
});

const envFor = (account: EasyPostAccount): api.Env => {
  try {
    return { apiKey: decrypt(account.apiKey) };
  } catch {
    throw unprocessable("The saved EasyPost key can't be read — reconnect EasyPost in settings.");
  }
};

/** Test keys are minted with one prefix and production keys another. */
const isTestKey = (apiKey: string) => /^EZTK/i.test(apiKey.trim());

/** Proves the key works, then keeps it — and whether it's a test key. */
export const connectAccount = async (merchantId: string, apiKey: string) => {
  const key = apiKey.trim();
  if (!/^EZ[AT]K/i.test(key)) {
    throw unprocessable("That doesn't look like an EasyPost API key: they start with EZAK (production) or EZTK (test).");
  }
  try {
    await api.probe({ apiKey: key });
  } catch (error) {
    throw friendly(error, "EasyPost didn't accept that key.");
  }
  const existing = await getAccount(merchantId);
  return prisma.easyPostAccount.upsert({
    where: { merchantId },
    create: {
      merchantId,
      apiKey: encrypt(key),
      testMode: isTestKey(key),
      webhookSecret: randomBytes(24).toString("hex"),
    },
    update: {
      apiKey: encrypt(key),
      testMode: isTestKey(key),
      webhookSecret: existing?.webhookSecret ?? randomBytes(24).toString("hex"),
    },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.easyPostAccount.deleteMany({ where: { merchantId } });
};

export const rotateWebhookSecret = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("EasyPost isn't connected.");
  return prisma.easyPostAccount.update({
    where: { merchantId },
    data: { webhookSecret: randomBytes(24).toString("hex") },
  });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("EasyPost isn't connected.");
  try {
    await api.probe(envFor(account));
  } catch (error) {
    throw friendly(error, "EasyPost didn't answer.");
  }
  return { ok: true, testMode: account.testMode };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const CM_PER_INCH = 2.54;
const OZ_PER_KG = 35.274;
const round1 = (n: number) => Math.round(n * 10) / 10;

const address = (p: Party): api.AddressInput => ({
  name: fullName(p) || p.firstName,
  street1: p.address1,
  street2: p.address2 || undefined,
  city: p.city,
  state: p.stateCode || p.state,
  zip: p.pincode,
  country: p.countryCode,
  phone: p.phone || undefined,
  email: p.email || undefined,
});

const parcelInput = (parcel: Parcel): api.ParcelInput => ({
  length: round1(parcel.lengthCm / CM_PER_INCH),
  width: round1(parcel.breadthCm / CM_PER_INCH),
  height: round1(parcel.heightCm / CM_PER_INCH),
  weight: round1(parcel.weightKg * OZ_PER_KG),
});

/**
 * A stable number for a carrier's service, so a chosen rate survives the
 * round trip through the app's integer courier id and can be bought again
 * on a fresh shipment. FNV-1a, folded into a positive 31-bit integer.
 */
export const serviceId = (carrier: string, service: string): number => {
  let h = 0x811c9dc5;
  for (const ch of `${carrier}|${service}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2147483647;
};

const serviceName = (r: api.Rate) => `${r.carrier} ${r.service.replace(/([a-z])([A-Z])/g, "$1 $2")}`;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The rates as the app's quotes; the cheapest is what a booking without a choice gets. */
const quotesOf = (rates: api.Rate[]): CourierQuote[] => {
  const priced = [...rates].sort((a, b) => (num(a.rate) ?? Infinity) - (num(b.rate) ?? Infinity));
  return priced.map((r, i) => ({
    courierId: serviceId(r.carrier, r.service),
    name: serviceName(r),
    rate: num(r.rate),
    currency: r.currency || "USD",
    shopRate: null,
    etd: r.delivery_date ?? null,
    days: r.delivery_days ?? r.est_delivery_days ?? null,
    surface: !/express|priority|overnight|next|air/i.test(r.service),
    rating: null,
    recommended: i === 0,
  }));
};

const noRates = (shipment: api.Shipment) => {
  const why = (shipment.messages ?? [])
    .map((m) => [m.carrier, m.message].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
  return new CarrierError(
    why
      ? `No carrier on the EasyPost account quoted this parcel: ${why}`
      : "No carrier on the EasyPost account quoted this parcel. Check the addresses and that a carrier is enabled in EasyPost.",
    200,
    shipment,
  );
};

/** Every carrier's rates for the parcel, cheapest first. */
export const quote = async (account: EasyPostAccount, parcel: Parcel, reference: string): Promise<CourierQuote[]> => {
  let shipment: api.Shipment;
  try {
    shipment = await api.createShipment(envFor(account), {
      to: address(parcel.to),
      from: address(parcel.from),
      parcel: parcelInput(parcel),
      reference,
    });
    if (!shipment.rates?.length) throw noRates(shipment);
  } catch (error) {
    throw friendly(error, "EasyPost couldn't rate the parcel.");
  }
  return quotesOf(shipment.rates!);
};

/**
 * Makes the shipment and buys the chosen rate — the one the merchant picked
 * from the quote, else the cheapest. Two steps, resumable: a shipment made
 * but not bought is bought on retry rather than made again.
 */
export const book = async (
  request: LabelRequest,
  account: EasyPostAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("EASYPOST", returnId, actorId, step, error);
  const existing = request.shipment;
  const resumable =
    existing?.provider === "EASYPOST" && existing.externalShipmentId && !existing.labelUrl && existing.externalOrderId === orderId;

  let shipment: api.Shipment;
  try {
    shipment = resumable
      ? await api.getShipment(e, existing!.externalShipmentId!)
      : await api.createShipment(e, {
          to: address(parcel.to),
          from: address(parcel.from),
          parcel: parcelInput(parcel),
          reference: orderId,
        });
    if (!shipment.rates?.length) throw noRates(shipment);
    await saveShipment(returnId, "EASYPOST", {
      provider: "EASYPOST",
      isTest: account.testMode,
      status: "PENDING",
      courierId: options.courierId,
      externalOrderId: orderId,
      externalShipmentId: shipment.id,
      externalStatus: "Created",
      externalStatusId: null,
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
    return fail("rating the parcel", error);
  }

  const rates = shipment.rates!;
  const chosen =
    (options.courierId !== null ? rates.find((r) => serviceId(r.carrier, r.service) === options.courierId) : undefined) ??
    [...rates].sort((a, b) => (num(a.rate) ?? Infinity) - (num(b.rate) ?? Infinity))[0];

  let bought: api.Shipment;
  try {
    bought = await api.buyShipment(e, shipment.id, chosen.id);
    const labelUrl = bought.postage_label?.label_url ?? bought.postage_label?.label_pdf_url;
    if (!labelUrl || !bought.tracking_code) throw new CarrierError("EasyPost bought the label but returned no label file.", 200, bought);
    await saveShipment(returnId, "EASYPOST", {
      status: "LABEL_CREATED",
      courierId: serviceId(chosen.carrier, chosen.service),
      carrier: serviceName(bought.selected_rate ?? chosen),
      trackingNumber: bought.tracking_code,
      trackingUrl: bought.tracker?.public_url ?? null,
      labelUrl,
      externalStatus: easypostLabel(bought.tracker?.status) ?? "Label created",
      lastError: null,
    });
  } catch (error) {
    return fail("buying the label", error);
  }

  const courier = serviceName(bought.selected_rate ?? chosen);
  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${courier}, tracking ${bought.tracking_code}${account.testMode ? " — test key, nothing charged" : ""}`,
    { ok: true, awb: bought.tracking_code, courier, provider: "EASYPOST", test: account.testMode },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

const applyTracker = (shipment: TrackedShipment, tracker: api.Tracker, source: "webhook" | "poll") =>
  applyTracking(
    shipment,
    {
      outcome: easypostOutcome(tracker.status),
      statusLabel: easypostLabel(tracker.status),
      courier: shipment.carrier,
      scans: easypostScans(tracker),
      etd: tracker.est_delivery_date ?? null,
      pickedUpAt: easypostScans(tracker).find((s) => /in transit|picked/i.test(s.status || s.activity))?.date ?? null,
      deliveredAt: easypostOutcome(tracker.status) === "DELIVERED" ? (easypostScans(tracker)[0]?.date ?? null) : null,
    },
    source,
  );

/** Asks EasyPost about one parcel and applies the answer. */
export const refresh = async (account: EasyPostAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.externalShipmentId) throw notFound("This return has no EasyPost shipment.");
  let found: api.Shipment;
  try {
    found = await api.getShipment(envFor(account), shipment.externalShipmentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` },
    });
    throw friendly(error, message);
  }
  if (!found.tracker?.status || easypostOutcome(found.tracker.status) === "UNKNOWN") {
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: null },
    });
    return;
  }
  await applyTracker(shipment, found.tracker, "poll");
};

/** Asks for the postage back; returns what EasyPost refused, if anything. */
export const cancelCalls = async (account: EasyPostAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId || !shipment.labelUrl) return [];
  try {
    const result = await api.refundShipment(envFor(account), shipment.externalShipmentId);
    return result.refund_status === "rejected" ? ["EasyPost rejected the refund; the label may already have been used."] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/** EasyPost signs the raw body with the webhook's secret: `hmac-sha256-hex=…`. */
const signatureMatches = (secret: string, rawBody: Buffer, header: string | undefined): boolean => {
  if (!header) return false;
  const given = header.replace(/^hmac-sha256-hex=/i, "").trim();
  const expected = createHmac("sha256", secret.normalize("NFKD")).update(rawBody).digest("hex");
  return safeEqual(given, expected);
};

/**
 * A tracker update from EasyPost. The parcel is found by its shipment or
 * tracking code, the signature checked against that store's secret, and
 * the update applied. Anything unknown is acknowledged and ignored, as
 * EasyPost expects: it retries anything it doesn't get a 2xx for.
 */
export const handleWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
  payload: unknown,
): Promise<"applied" | "ignored" | "unauthorized"> => {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (body.description !== "tracker.updated") return "ignored";
  const tracker = (body.result ?? {}) as api.Tracker & { shipment_id?: string };
  const shipment = await prisma.returnShipment.findFirst({
    where: {
      provider: "EASYPOST",
      OR: [
        ...(tracker.shipment_id ? [{ externalShipmentId: tracker.shipment_id }] : []),
        ...(tracker.tracking_code ? [{ trackingNumber: tracker.tracking_code }] : []),
      ],
    },
    include: trackedInclude,
  });
  if (!shipment) return "ignored";
  const account = await getAccount(shipment.returnRequest.merchantId);
  if (!account || !signatureMatches(account.webhookSecret, rawBody, signature)) {
    logger.warn({ shipmentId: shipment.id }, "EasyPost webhook signature didn't match");
    return "unauthorized";
  }
  if (["CANCELLED"].includes(shipment.status)) return "ignored";
  await applyTracker(shipment, tracker, "webhook");
  return "applied";
};
