import type { ReturnShipment, ShippoAccount } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { decrypt, encrypt, safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import * as api from "./shippo.client.js";
import { serviceId } from "./easypost.service.js";
import type { Outcome, Scan } from "./shiprocket.status.js";
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
 * Shippo as a return-label carrier.
 *
 * Much like EasyPost: one token fronts every carrier the store has set up
 * in Shippo, a shipment returns each of their rates, and buying one gives
 * a drop-off label the shopper prints. A test token is the test mode.
 * Shippo doesn't sign its webhooks, so the webhook URL carries a secret
 * of its own that names the store.
 */

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const webhookUrl = (secret: string) =>
  `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/shippo/events?token=${encodeURIComponent(secret)}`;

export const getAccount = (merchantId: string) => prisma.shippoAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: ShippoAccount) => ({
  connectedAt: account.createdAt,
  testMode: account.testMode,
  webhookUrl: webhookUrl(account.webhookSecret),
});

const envFor = (account: ShippoAccount): api.Env => {
  try {
    return { token: decrypt(account.token) };
  } catch {
    throw unprocessable("The saved Shippo token can't be read — reconnect Shippo in settings.");
  }
};

const isTestToken = (token: string) => /^shippo_test_/i.test(token.trim());

export const connectAccount = async (merchantId: string, token: string) => {
  const key = token.trim();
  if (!/^shippo_(test|live)_/i.test(key)) {
    throw unprocessable("That doesn't look like a Shippo API token: they start with shippo_test_ or shippo_live_.");
  }
  try {
    await api.probe({ token: key });
  } catch (error) {
    throw friendly(error, "Shippo didn't accept that token.");
  }
  const existing = await getAccount(merchantId);
  return prisma.shippoAccount.upsert({
    where: { merchantId },
    create: { merchantId, token: encrypt(key), testMode: isTestToken(key), webhookSecret: randomBytes(24).toString("hex") },
    update: { token: encrypt(key), testMode: isTestToken(key), webhookSecret: existing?.webhookSecret ?? randomBytes(24).toString("hex") },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.shippoAccount.deleteMany({ where: { merchantId } });
};

export const rotateWebhookSecret = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shippo isn't connected.");
  return prisma.shippoAccount.update({ where: { merchantId }, data: { webhookSecret: randomBytes(24).toString("hex") } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shippo isn't connected.");
  try {
    await api.probe(envFor(account));
  } catch (error) {
    throw friendly(error, "Shippo didn't answer.");
  }
  return { ok: true, testMode: account.testMode };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const address = (p: Party): api.AddressInput => ({
  name: fullName(p) || p.firstName,
  ...(p.company ? { company: p.company } : {}),
  street1: p.address1,
  street2: p.address2 || undefined,
  city: p.city,
  state: p.stateCode || p.state,
  zip: p.pincode,
  country: p.countryCode,
  phone: p.phone || undefined,
  email: p.email || undefined,
});

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const serviceName = (r: api.Rate) => `${r.provider} ${r.servicelevel?.name ?? r.servicelevel?.token ?? ""}`.trim();
const idOf = (r: api.Rate) => serviceId(r.provider, r.servicelevel?.token ?? r.servicelevel?.name ?? "");

const quotesOf = (rates: api.Rate[]): CourierQuote[] =>
  [...rates]
    .sort((a, b) => (num(a.amount) ?? Infinity) - (num(b.amount) ?? Infinity))
    .map((r, i) => ({
      courierId: idOf(r),
      name: serviceName(r),
      rate: num(r.amount),
      currency: r.currency || "USD",
      shopRate: null,
      etd: null,
      days: r.estimated_days ?? null,
      surface: !/express|priority|overnight|next|air/i.test(serviceName(r)),
      rating: null,
      recommended: i === 0,
    }));

const noRates = (shipment: api.Shipment) => {
  const why = (shipment.messages ?? []).map((m) => m.text).filter(Boolean).join("; ");
  return new CarrierError(
    why ? `No carrier on the Shippo account rated this parcel: ${why}` : "No carrier on the Shippo account rated this parcel. Check the addresses and the carriers enabled in Shippo.",
    200,
    shipment,
  );
};

const makeShipment = async (e: api.Env, parcel: Parcel, reference: string) => {
  const shipment = await api.createShipment(e, {
    to: address(parcel.to),
    from: address(parcel.from),
    parcel: { length: parcel.lengthCm, width: parcel.breadthCm, height: parcel.heightCm, weight: parcel.weightKg },
    reference,
    references: parcel.references,
  });
  if (!shipment.rates?.length) throw noRates(shipment);
  return shipment;
};

export const quote = async (account: ShippoAccount, parcel: Parcel, reference: string): Promise<CourierQuote[]> => {
  try {
    return quotesOf((await makeShipment(envFor(account), parcel, reference)).rates!);
  } catch (error) {
    throw friendly(error, "Shippo couldn't rate the parcel.");
  }
};

/** Makes the shipment and buys the chosen rate, else the cheapest. */
export const book = async (
  request: LabelRequest,
  account: ShippoAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("SHIPPO", returnId, actorId, step, error);

  let rates: api.Rate[];
  try {
    const shipment = await makeShipment(e, parcel, orderId);
    rates = shipment.rates!;
    await saveShipment(returnId, "SHIPPO", {
      provider: "SHIPPO",
      isTest: account.testMode,
      status: "PENDING",
      courierId: options.courierId,
      externalOrderId: orderId,
      externalShipmentId: shipment.object_id,
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

  const chosen =
    (options.courierId !== null ? rates.find((r) => idOf(r) === options.courierId) : undefined) ??
    [...rates].sort((a, b) => (num(a.amount) ?? Infinity) - (num(b.amount) ?? Infinity))[0];

  let bought: api.Transaction;
  try {
    bought = await api.buyRate(e, chosen.object_id);
    if (bought.status !== "SUCCESS" || !bought.label_url || !bought.tracking_number) {
      const why = (bought.messages ?? []).map((m) => m.text).filter(Boolean).join("; ");
      throw new CarrierError(why || "Shippo didn't produce a label.", 200, bought);
    }
    await saveShipment(returnId, "SHIPPO", {
      status: "LABEL_CREATED",
      courierId: idOf(chosen),
      carrier: serviceName(chosen),
      trackingNumber: bought.tracking_number,
      trackingUrl: bought.tracking_url_provider ?? null,
      labelUrl: bought.label_url,
      // The transaction is what tracking and refunds are keyed on.
      externalShipmentId: bought.object_id,
      // Shippo's carrier token, for the tracking call later.
      pickupToken: chosen.provider.toLowerCase().replace(/\s+/g, "_"),
      externalStatus: "Label created",
      lastError: null,
    });
  } catch (error) {
    return fail("buying the label", error);
  }

  const courier = serviceName(chosen);
  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${courier}, tracking ${bought.tracking_number}${account.testMode ? " — test token, nothing charged" : ""}`,
    { ok: true, awb: bought.tracking_number, courier, provider: "SHIPPO", test: account.testMode },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

export const shippoOutcome = (status: string | null | undefined): Outcome => {
  switch ((status ?? "").toUpperCase()) {
    case "PRE_TRANSIT":
      return "WAITING";
    case "TRANSIT":
      return "IN_TRANSIT";
    case "DELIVERED":
      return "DELIVERED";
    case "RETURNED":
    case "FAILURE":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
};

const label = (status: string | null | undefined) => {
  if (!status) return null;
  const words = status.toLowerCase().replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
};

export const shippoScans = (track: api.Track | null | undefined): Scan[] =>
  (track?.tracking_history ?? [])
    .map((h) => ({
      date: h.status_date ?? "",
      activity: h.status_details ?? label(h.status) ?? "",
      location: [h.location?.city, h.location?.state].filter(Boolean).join(", "),
      status: label(h.status) ?? "",
    }))
    .filter((s) => s.date || s.activity)
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

const applyTrack = (shipment: TrackedShipment, track: api.Track, source: "webhook" | "poll") => {
  const status = track.tracking_status?.status;
  const scans = shippoScans(track);
  return applyTracking(
    shipment,
    {
      outcome: shippoOutcome(status),
      statusLabel: label(status),
      courier: shipment.carrier,
      scans,
      etd: track.eta ?? null,
      pickedUpAt: scans.find((s) => /transit/i.test(s.status))?.date ?? null,
      deliveredAt: shippoOutcome(status) === "DELIVERED" ? (track.tracking_status?.status_date ?? scans[0]?.date ?? null) : null,
    },
    source,
  );
};

export const refresh = async (account: ShippoAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber || !shipment.pickupToken) throw notFound("This return has no Shippo label.");
  let track: api.Track;
  try {
    track = await api.track(envFor(account), shipment.pickupToken, shipment.trackingNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  if (shippoOutcome(track.tracking_status?.status) === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  await applyTrack(shipment, track, "poll");
};

export const cancelCalls = async (account: ShippoAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId || !shipment.labelUrl) return [];
  try {
    const result = await api.refund(envFor(account), shipment.externalShipmentId);
    return result.status === "ERROR" ? ["Shippo refused the refund; the label may already have been used."] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

/**
 * A `track_updated` event. Shippo doesn't sign these, so the URL's token
 * names the store and is checked against its secret; the parcel is found by
 * tracking number within that store.
 */
export const handleWebhook = async (token: string | undefined, payload: unknown): Promise<"applied" | "ignored" | "unauthorized"> => {
  if (!token) return "unauthorized";
  const account = await prisma.shippoAccount.findFirst({ where: { webhookSecret: token } });
  if (!account || !safeEqual(account.webhookSecret, token)) return "unauthorized";
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (body.event !== "track_updated") return "ignored";
  const track = (body.data ?? {}) as api.Track;
  if (!track.tracking_number) return "ignored";
  const shipment = await prisma.returnShipment.findFirst({
    where: { provider: "SHIPPO", trackingNumber: track.tracking_number, returnRequest: { merchantId: account.merchantId } },
    include: trackedInclude,
  });
  if (!shipment || shipment.status === "CANCELLED") return "ignored";
  try {
    await applyTrack(shipment, track, "webhook");
  } catch (error) {
    logger.warn({ shipmentId: shipment.id, err: error }, "Shippo webhook couldn't be applied");
    return "ignored";
  }
  return "applied";
};
