import type { ReturnShipment, SendcloudAccount } from "@prisma/client";
import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { decrypt, encrypt, safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { fullName } from "./addresses.js";
import type { Outcome } from "./shiprocket.status.js";
import {
  CarrierError,
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  hostedLabelUrl,
  saveShipment,
  testLabelUrl,
  trackedInclude,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
  type TrackedShipment,
} from "./shipments.js";

/**
 * Sendcloud as a return-label carrier, for stores in Europe.
 *
 * A public and secret key front the carriers contracted through Sendcloud.
 * Return shipping methods are listed for the lane, priced per destination
 * country; a parcel announced as a return with a label requested comes
 * back with the tracking number, and the label PDF is fetched and hosted
 * here. Sendcloud has no sandbox, so the test mode announces the parcel
 * without requesting a label — nothing is charged — and hands the shopper
 * the app's own test label.
 */

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

interface Env {
  publicKey: string;
  secretKey: string;
}

const TIMEOUT_MS = 20_000;
const base = () => env.SENDCLOUD_API_URL.replace(/\/+$/, "");

const authHeader = (e: Env) => `Basic ${Buffer.from(`${e.publicKey}:${e.secretKey}`).toString("base64")}`;

const messageOf = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object") {
    const b = body as { error?: { message?: unknown }; message?: unknown };
    if (b.error && typeof b.error === "object" && typeof b.error.message === "string") return b.error.message;
    if (typeof b.message === "string") return b.message;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return fallback;
};

const request = async <T>(e: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        authorization: authHeader(e),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError" ? "Sendcloud didn't answer in time." : "Couldn't reach Sendcloud.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.status === 401 || res.status === 403) {
    throw new CarrierError("Sendcloud rejected the API keys. Check them under Settings → Shipping.", res.status, parsed);
  }
  if (!res.ok) throw new CarrierError(messageOf(parsed, `Sendcloud returned ${res.status}.`), res.status, parsed);
  return parsed as T;
};

/** The label PDF itself, which needs the same credentials to read. */
const fetchPdf = async (e: Env, url: string): Promise<Buffer> => {
  const res = await fetch(url, { headers: { authorization: authHeader(e) } });
  if (!res.ok) throw new CarrierError(`Sendcloud wouldn't hand over the label (${res.status}).`, res.status);
  return Buffer.from(await res.arrayBuffer());
};

interface SenderAddress {
  id: number;
  company_name?: string;
  country?: string;
  postal_code?: string;
  city?: string;
}

interface ShippingMethod {
  id: number;
  name: string;
  carrier: string;
  min_weight?: string;
  max_weight?: string;
  countries?: Array<{ iso_2: string; price?: number | string | null; name?: string }>;
}

interface ParcelReply {
  parcel: {
    id: number;
    tracking_number?: string | null;
    tracking_url?: string | null;
    status?: { id?: number; message?: string } | null;
    label?: { normal_printer?: string[]; label_printer?: string } | null;
    carrier?: { code?: string } | null;
  };
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const webhookUrl = () => `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/sendcloud/events`;

export const getAccount = (merchantId: string) => prisma.sendcloudAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: SendcloudAccount) => ({
  connectedAt: account.createdAt,
  testMode: account.testMode,
  senderAddress: account.senderAddress,
  webhookUrl: webhookUrl(),
});

const envFor = (account: SendcloudAccount): Env => {
  try {
    return { publicKey: decrypt(account.publicKey), secretKey: decrypt(account.secretKey) };
  } catch {
    throw unprocessable("The saved Sendcloud keys can't be read — reconnect Sendcloud in settings.");
  }
};

/** The first sender address on the account: the store, as Sendcloud knows it. */
const firstSender = async (e: Env): Promise<SenderAddress> => {
  const reply = await request<{ sender_addresses?: SenderAddress[] }>(e, "GET", "/user/addresses/sender");
  const sender = reply.sender_addresses?.[0];
  if (!sender) throw new CarrierError("The Sendcloud account has no sender address yet; add one under Settings → Addresses in Sendcloud.", 200, reply);
  return sender;
};

export const connectAccount = async (merchantId: string, publicKey: string, secretKey: string, testMode: boolean) => {
  const e: Env = { publicKey: publicKey.trim(), secretKey: secretKey.trim() };
  let sender: SenderAddress;
  try {
    await request(e, "GET", "/user");
    sender = await firstSender(e);
  } catch (error) {
    throw friendly(error, "Sendcloud didn't accept those keys.");
  }
  const label = [sender.company_name, sender.postal_code, sender.city, sender.country].filter(Boolean).join(", ");
  return prisma.sendcloudAccount.upsert({
    where: { merchantId },
    create: { merchantId, publicKey: encrypt(e.publicKey), secretKey: encrypt(e.secretKey), senderAddressId: sender.id, senderAddress: label, testMode },
    update: { publicKey: encrypt(e.publicKey), secretKey: encrypt(e.secretKey), senderAddressId: sender.id, senderAddress: label, testMode },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.sendcloudAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean }) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Sendcloud isn't connected.");
  return prisma.sendcloudAccount.update({ where: { merchantId }, data: { ...(input.testMode === undefined ? {} : { testMode: input.testMode }) } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Sendcloud isn't connected.");
  try {
    await request(envFor(account), "GET", "/user");
  } catch (error) {
    throw friendly(error, "Sendcloud didn't answer.");
  }
  return { ok: true, testMode: account.testMode };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The return methods that serve this lane and carry this weight, priced for the store's country. */
const methodsFor = async (e: Env, account: SendcloudAccount, parcel: Parcel): Promise<ShippingMethod[]> => {
  const query = new URLSearchParams({
    sender_address: String(account.senderAddressId),
    from_country: parcel.from.countryCode,
    to_country: parcel.to.countryCode,
    is_return: "true",
  });
  const reply = await request<{ shipping_methods?: ShippingMethod[] }>(e, "GET", `/shipping_methods?${query}`);
  return (reply.shipping_methods ?? []).filter((m) => {
    const min = num(m.min_weight) ?? 0;
    const max = num(m.max_weight) ?? Infinity;
    return parcel.weightKg >= min && parcel.weightKg <= max && (m.countries ?? []).some((c) => c.iso_2 === parcel.to.countryCode);
  });
};

const quoteOf = (m: ShippingMethod, toCountry: string, recommended: boolean): CourierQuote => ({
  courierId: m.id,
  name: m.name,
  rate: num((m.countries ?? []).find((c) => c.iso_2 === toCountry)?.price),
  currency: "EUR",
  shopRate: null,
  etd: null,
  days: null,
  surface: !/express|priority|next/i.test(m.name),
  rating: null,
  recommended,
});

export const quote = async (account: SendcloudAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  let methods: ShippingMethod[];
  try {
    methods = await methodsFor(envFor(account), account, parcel);
  } catch (error) {
    throw friendly(error, "Sendcloud couldn't list return methods.");
  }
  if (methods.length === 0) {
    throw unprocessable(
      `No Sendcloud return method serves ${parcel.from.countryCode} → ${parcel.to.countryCode} at ${parcel.weightKg} kg. Check the carriers and return settings in Sendcloud.`,
    );
  }
  const quotes = methods.map((m) => quoteOf(m, parcel.to.countryCode, false)).sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity));
  quotes[0].recommended = true;
  return quotes;
};

const parcelInput = (parcel: Parcel, methodId: number, orderId: string, requestLabel: boolean) => ({
  parcel: {
    // Where it's going: the store.
    name: fullName(parcel.to) || parcel.to.firstName,
    company_name: parcel.to.company || parcel.to.firstName,
    address: parcel.to.address1,
    address_2: parcel.to.address2 || undefined,
    city: parcel.to.city,
    postal_code: parcel.to.pincode,
    country: parcel.to.countryCode,
    email: parcel.to.email || undefined,
    telephone: parcel.to.phone || undefined,
    // Where it's coming from: the shopper.
    from_name: fullName(parcel.from) || parcel.from.firstName,
    from_address_1: parcel.from.address1,
    from_address_2: parcel.from.address2 || undefined,
    from_city: parcel.from.city,
    from_postal_code: parcel.from.pincode,
    from_country: parcel.from.countryCode,
    from_telephone: parcel.from.phone || undefined,
    from_email: parcel.from.email || undefined,
    is_return: true,
    order_number: orderId,
    weight: parcel.weightKg.toFixed(3),
    length: String(parcel.lengthCm),
    width: String(parcel.breadthCm),
    height: String(parcel.heightCm),
    total_order_value: parcel.value.toFixed(2),
    shipment: { id: methodId },
    request_label: requestLabel,
  },
});

/** Announces the parcel and, outside test mode, fetches the label to host. */
export const book = async (
  request_: LabelRequest,
  account: SendcloudAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request_.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("SENDCLOUD", returnId, actorId, step, error);

  let method: ShippingMethod;
  try {
    const methods = await methodsFor(e, account, parcel);
    if (methods.length === 0) throw new CarrierError(`No Sendcloud return method serves ${parcel.from.countryCode} → ${parcel.to.countryCode}.`, 200);
    method =
      (options.courierId !== null ? methods.find((m) => m.id === options.courierId) : undefined) ??
      [...methods].sort((a, b) => (num(a.countries?.find((c) => c.iso_2 === parcel.to.countryCode)?.price) ?? Infinity) - (num(b.countries?.find((c) => c.iso_2 === parcel.to.countryCode)?.price) ?? Infinity))[0];
  } catch (error) {
    return fail("choosing a return method", error);
  }

  let reply: ParcelReply;
  try {
    reply = await request<ParcelReply>(e, "POST", "/parcels", parcelInput(parcel, method.id, orderId, !account.testMode));
    if (!reply.parcel?.id) throw new CarrierError("Sendcloud didn't announce the parcel.", 200, reply);
    if (!account.testMode && !reply.parcel.tracking_number) {
      throw new CarrierError(reply.parcel.status?.message || "Sendcloud announced the parcel but made no label.", 200, reply);
    }
  } catch (error) {
    return fail("announcing the parcel", error);
  }

  const tracking = reply.parcel.tracking_number || `SC${reply.parcel.id}`;
  const saved = await saveShipment(returnId, "SENDCLOUD", {
    provider: "SENDCLOUD",
    isTest: account.testMode,
    status: "LABEL_CREATED",
    courierId: method.id,
    externalOrderId: orderId,
    externalShipmentId: String(reply.parcel.id),
    externalStatus: reply.parcel.status?.message ?? "Announced",
    externalStatusId: reply.parcel.status?.id ?? null,
    carrier: method.name,
    trackingNumber: tracking,
    trackingUrl: reply.parcel.tracking_url ?? null,
    labelUrl: null,
    labelData: null,
    pickupScheduledAt: null,
    pickupToken: null,
    scans: [],
    shippedAt: null,
    deliveredAt: null,
    lastError: null,
  });

  if (account.testMode) {
    await prisma.returnShipment.update({ where: { id: saved.id }, data: { labelUrl: testLabelUrl(saved.id) } });
  } else {
    try {
      const url = reply.parcel.label?.normal_printer?.[0];
      if (!url) throw new CarrierError("Sendcloud returned no label link.", 200, reply);
      const pdf = await fetchPdf(e, url);
      await prisma.returnShipment.update({
        where: { id: saved.id },
        data: { labelData: pdf.toString("base64"), labelUrl: hostedLabelUrl(saved.id) },
      });
    } catch (error) {
      return fail("fetching the label", error);
    }
  }

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${method.name}, tracking ${tracking}${account.testMode ? " — test mode, announced without a label, nothing charged" : ""}`,
    { ok: true, awb: tracking, courier: method.name, provider: "SENDCLOUD", test: account.testMode },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

/** Sendcloud's parcel statuses, by their wording; the numbers vary by carrier. */
export const sendcloudOutcome = (message: string | null | undefined): Outcome => {
  const m = (message ?? "").toLowerCase();
  if (!m) return "UNKNOWN";
  if (/cancel|deleted/.test(m)) return "CANCELLED";
  if (/not delivered|unable|returned to sender|error|failed|refused/.test(m)) return "FAILED";
  if (/delivered/.test(m)) return "DELIVERED";
  if (/announced|ready to send|being announced|no label/.test(m)) return "WAITING";
  if (/route|sorting|transit|collected|picked|out for delivery|driver|awaiting|shipped|at parcel shop|depot/.test(m)) return "IN_TRANSIT";
  return "UNKNOWN";
};

const applyParcel = (shipment: TrackedShipment, parcel: ParcelReply["parcel"], source: "webhook" | "poll") => {
  const message = parcel.status?.message ?? null;
  const outcome = sendcloudOutcome(message);
  const now = new Date().toISOString();
  return applyTracking(
    shipment,
    {
      outcome,
      statusId: parcel.status?.id ?? null,
      statusLabel: message,
      courier: shipment.carrier,
      scans: [{ date: now, activity: message ?? "", location: "", status: message ?? "" }, ...((shipment.scans as unknown[]) ?? [])],
      etd: null,
      pickedUpAt: outcome === "IN_TRANSIT" ? now : null,
      deliveredAt: outcome === "DELIVERED" ? now : null,
    },
    source,
  );
};

export const refresh = async (account: SendcloudAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.externalShipmentId) throw notFound("This return has no Sendcloud parcel.");
  let reply: ParcelReply;
  try {
    reply = await request<ParcelReply>(envFor(account), "GET", `/parcels/${encodeURIComponent(shipment.externalShipmentId)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  const message = reply.parcel?.status?.message ?? null;
  if (!message || message === shipment.externalStatus || sendcloudOutcome(message) === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  await applyParcel(shipment, reply.parcel, "poll");
};

export const cancelCalls = async (account: SendcloudAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId) return [];
  try {
    const result = await request<{ status?: string; message?: string }>(envFor(account), "POST", `/parcels/${encodeURIComponent(shipment.externalShipmentId)}/cancel`);
    return result.status && !/cancel|delet/i.test(result.status) ? [result.message ?? `Sendcloud said: ${result.status}`] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

/**
 * A `parcel_status_changed` event, signed over the raw body with the
 * account's secret key. The parcel names the store, and the store's key
 * checks the signature.
 */
export const handleWebhook = async (rawBody: Buffer, signature: string | undefined, payload: unknown): Promise<"applied" | "ignored" | "unauthorized"> => {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (body.action !== "parcel_status_changed") return "ignored";
  const parcel = (body.parcel ?? {}) as ParcelReply["parcel"];
  if (!parcel.id) return "ignored";
  const shipment = await prisma.returnShipment.findFirst({
    where: { provider: "SENDCLOUD", externalShipmentId: String(parcel.id) },
    include: trackedInclude,
  });
  if (!shipment) return "ignored";
  const account = await getAccount(shipment.returnRequest.merchantId);
  if (!account || !signature) return "unauthorized";
  const expected = createHmac("sha256", envFor(account).secretKey).update(rawBody).digest("hex");
  if (!safeEqual(signature.trim(), expected)) {
    logger.warn({ shipmentId: shipment.id }, "Sendcloud webhook signature didn't match");
    return "unauthorized";
  }
  if (shipment.status === "CANCELLED") return "ignored";
  await applyParcel(shipment, parcel, "webhook");
  return "applied";
};
