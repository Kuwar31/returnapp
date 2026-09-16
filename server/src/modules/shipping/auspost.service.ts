import type { AusPostAccount, ReturnShipment } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import { basic, carrierCall, num } from "./carrier.http.js";
import { serviceId } from "./easypost.service.js";
import type { Outcome, Scan } from "./shiprocket.status.js";
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
 * Australia Post through the Shipping and Tracking API.
 *
 * An API key and password plus the account number, sent on every call.
 * Prices come back per product for the item; a shipment from the shopper
 * to the store is created, then a label asked for, which Australia Post
 * hosts as a PDF. Its test environment is the test mode.
 */

interface Env {
  key: string;
  password: string;
  account: string;
  test: boolean;
}

const baseOf = (e: Env) => (e.test ? env.AUSPOST_TEST_URL : env.AUSPOST_API_URL);

const errorOf = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as { errors?: Array<{ code?: string; message?: string; name?: string }> };
  return Array.isArray(b.errors) && b.errors.length ? b.errors.map((e) => e.message ?? e.name ?? e.code ?? "").filter(Boolean).join("; ") : null;
};

const call = <T>(e: Env, path: string, body?: unknown, method?: "GET" | "POST" | "DELETE") =>
  carrierCall<T>({
    base: baseOf(e),
    path,
    method,
    body,
    headers: { authorization: basic(e.key, e.password), "account-number": e.account },
    carrier: "Australia Post",
    errorOf,
    unauthorized: "Australia Post rejected the API key, password or account number. Check them under Settings → Shipping, and that they belong to the environment chosen there.",
  });

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) => prisma.ausPostAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (a: AusPostAccount) => ({ connectedAt: a.createdAt, testMode: a.testMode, accountNumber: a.accountNumber });

const envFor = (a: AusPostAccount): Env => {
  try {
    return { key: decrypt(a.apiKey), password: decrypt(a.password), account: a.accountNumber, test: a.testMode };
  } catch {
    throw unprocessable("The saved Australia Post credentials can't be read — reconnect Australia Post in settings.");
  }
};

const probe = (e: Env) => call(e, `/accounts/${encodeURIComponent(e.account)}`, undefined, "GET");

export const connectAccount = async (merchantId: string, apiKey: string, password: string, accountNumber: string, testMode: boolean) => {
  const e: Env = { key: apiKey.trim(), password: password.trim(), account: accountNumber.trim(), test: testMode };
  try {
    await probe(e);
  } catch (error) {
    throw friendly(error, "Australia Post didn't accept those credentials.");
  }
  return prisma.ausPostAccount.upsert({
    where: { merchantId },
    create: { merchantId, apiKey: encrypt(e.key), password: encrypt(e.password), accountNumber: e.account, testMode },
    update: { apiKey: encrypt(e.key), password: encrypt(e.password), accountNumber: e.account, testMode },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.ausPostAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean }) => {
  if (!(await getAccount(merchantId))) throw notFound("Australia Post isn't connected.");
  return prisma.ausPostAccount.update({ where: { merchantId }, data: { ...(input.testMode === undefined ? {} : { testMode: input.testMode }) } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Australia Post isn't connected.");
  try {
    await probe(envFor(account));
  } catch (error) {
    throw friendly(error, "Australia Post didn't answer.");
  }
  return { ok: true, testMode: account.testMode };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const address = (p: Party) => ({
  name: fullName(p) || p.firstName,
  lines: [p.address1, p.address2].filter(Boolean),
  suburb: p.city,
  state: p.stateCode || p.state,
  postcode: p.pincode,
  country: p.countryCode,
  ...(p.phone ? { phone: p.phone } : {}),
  ...(p.email ? { email: p.email } : {}),
});

const item = (parcel: Parcel) => ({
  length: parcel.lengthCm,
  width: parcel.breadthCm,
  height: parcel.heightCm,
  weight: parcel.weightKg,
});

interface Price {
  product_id: string;
  product_type?: string;
  calculated_price?: number | string;
  calculated_price_ex_gst?: number | string;
}

const quotesOf = (prices: Price[]): CourierQuote[] =>
  prices
    .map((p) => ({ p, rate: num(p.calculated_price) }))
    .sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
    .map(({ p, rate }, i) => ({
      courierId: serviceId("AUSPOST", p.product_id),
      name: `Australia Post ${p.product_type ?? p.product_id}`,
      rate,
      currency: "AUD",
      shopRate: null,
      etd: null,
      days: null,
      surface: !/express/i.test(p.product_type ?? p.product_id),
      rating: null,
      recommended: i === 0,
    }));

const prices = (e: Env, parcel: Parcel) =>
  call<{ items?: Array<{ prices?: Price[]; errors?: Array<{ message?: string }> }> }>(e, "/prices/items", {
    from: { postcode: parcel.from.pincode, country: parcel.from.countryCode },
    to: { postcode: parcel.to.pincode, country: parcel.to.countryCode },
    items: [item(parcel)],
  });

const pricesOf = async (e: Env, parcel: Parcel): Promise<Price[]> => {
  const reply = await prices(e, parcel);
  const first = reply.items?.[0];
  const found = first?.prices ?? [];
  if (!found.length) {
    const why = (first?.errors ?? []).map((er) => er.message).filter(Boolean).join("; ");
    throw new CarrierError(why || "Australia Post offers no product for this parcel on this lane.", 200, reply);
  }
  return found;
};

export const quote = async (account: AusPostAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  try {
    return quotesOf(await pricesOf(envFor(account), parcel));
  } catch (error) {
    throw friendly(error, "Australia Post couldn't price the parcel.");
  }
};

interface ShipmentReply {
  shipments?: Array<{ shipment_id: string; items?: Array<{ item_id?: string; tracking_details?: { article_id?: string; consignment_id?: string } }> }>;
}

export const book = async (
  request: LabelRequest,
  account: AusPostAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("AUSPOST", returnId, actorId, step, error);

  let found: Price[];
  try {
    found = await pricesOf(e, parcel);
  } catch (error) {
    return fail("pricing the parcel", error);
  }
  const quotes = quotesOf(found);
  const chosen = (options.courierId !== null ? quotes.find((q) => q.courierId === options.courierId) : undefined) ?? quotes[0];
  const productId = found.find((p) => serviceId("AUSPOST", p.product_id) === chosen.courierId)!.product_id;

  let shipmentId: string;
  let tracking: string;
  try {
    const reply = await call<ShipmentReply>(e, "/shipments", {
      shipments: [
        {
          shipment_reference: orderId.slice(0, 50),
          from: address(parcel.from),
          to: address(parcel.to),
          items: [{ ...item(parcel), item_reference: request.reference.slice(0, 50), product_id: productId, authority_to_leave: false, allow_partial_delivery: false }],
        },
      ],
    });
    const made = reply.shipments?.[0];
    shipmentId = made?.shipment_id ?? "";
    tracking = made?.items?.[0]?.tracking_details?.article_id ?? made?.items?.[0]?.tracking_details?.consignment_id ?? "";
    if (!shipmentId || !tracking) throw new CarrierError("Australia Post didn't create the shipment.", 200, reply);
    await saveShipment(returnId, "AUSPOST", {
      provider: "AUSPOST",
      isTest: account.testMode,
      status: "PENDING",
      courierId: chosen.courierId,
      externalOrderId: orderId,
      externalShipmentId: shipmentId,
      externalStatus: "Created",
      externalStatusId: null,
      carrier: chosen.name,
      trackingNumber: tracking,
      trackingUrl: `https://auspost.com.au/mypost/track/#/details/${encodeURIComponent(tracking)}`,
      labelUrl: null,
      labelData: null,
      pickupScheduledAt: null,
      pickupToken: null,
      scans: [],
      shippedAt: null,
      deliveredAt: null,
      lastError: null,
    });
  } catch (error) {
    return fail("creating the shipment", error);
  }

  try {
    const reply = await call<{ labels?: Array<{ url?: string; status?: string }> }>(e, "/labels", {
      wait_for_label_url: true,
      preferences: [{ type: "PRINT", format: "PDF", groups: [{ group: "Parcel Post", layout: "A4-1pp", branded: false, left_offset: 0, top_offset: 0 }] }],
      shipments: [{ shipment_id: shipmentId }],
    });
    const url = reply.labels?.[0]?.url;
    if (!url) throw new CarrierError("Australia Post created the shipment but returned no label link.", 200, reply);
    await saveShipment(returnId, "AUSPOST", { labelUrl: url, status: "LABEL_CREATED", lastError: null });
  } catch (error) {
    return fail("printing the label", error);
  }

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${chosen.name}, article ${tracking}${account.testMode ? " — test environment, nothing charged" : ""}`,
    { ok: true, awb: tracking, courier: chosen.name, provider: "AUSPOST", test: account.testMode },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

export const ausPostOutcome = (status: string | null | undefined): Outcome => {
  const s = (status ?? "").toLowerCase();
  if (!s) return "UNKNOWN";
  if (/cancel/.test(s)) return "CANCELLED";
  if (/returned|unsuccessful|cannot be delivered|unable/.test(s)) return "FAILED";
  if (/delivered/.test(s)) return "DELIVERED";
  if (/initiated|created|sender|awaiting collection from sender/.test(s)) return "WAITING";
  if (/transit|awaiting collection|processed|onboard|on board|out for delivery|delivery attempted|possible delay/.test(s)) return "IN_TRANSIT";
  return "UNKNOWN";
};

interface TrackReply {
  tracking_results?: Array<{
    tracking_id?: string;
    status?: string;
    trackable_items?: Array<{ events?: Array<{ description?: string; date?: string; location?: string }> }>;
  }>;
}

export const refresh = async (account: AusPostAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber) throw notFound("This return has no Australia Post article.");
  let reply: TrackReply;
  try {
    reply = await call<TrackReply>(envFor(account), `/track?tracking_ids=${encodeURIComponent(shipment.trackingNumber)}`, undefined, "GET");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  const result = reply.tracking_results?.[0];
  const outcome = ausPostOutcome(result?.status);
  if (!result || outcome === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  const scans: Scan[] = (result.trackable_items?.[0]?.events ?? [])
    .map((ev) => ({ date: ev.date ?? "", activity: ev.description ?? "", location: ev.location ?? "", status: ev.description ?? "" }))
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  await applyTracking(
    shipment,
    {
      outcome,
      statusLabel: result.status ?? null,
      courier: shipment.carrier,
      scans,
      etd: null,
      pickedUpAt: outcome === "IN_TRANSIT" ? (scans[0]?.date ?? null) : null,
      deliveredAt: outcome === "DELIVERED" ? (scans[0]?.date ?? null) : null,
    },
    "poll",
  );
};

export const cancelCalls = async (account: AusPostAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId) return [];
  try {
    await call(envFor(account), `/shipments/${encodeURIComponent(shipment.externalShipmentId)}`, undefined, "DELETE");
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};
