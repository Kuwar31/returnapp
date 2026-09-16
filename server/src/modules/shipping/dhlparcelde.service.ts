import type { DhlParcelDeAccount, ReturnShipment } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import { basic, carrierCall, pdfBase64 } from "./carrier.http.js";
import type { Outcome, Scan } from "./shiprocket.status.js";
import {
  CarrierError,
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  hostedLabelUrl,
  saveShipment,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
  type TrackedShipment,
} from "./shipments.js";

/**
 * Deutsche Post / DHL Paket through the DHL Parcel DE Shipping API.
 *
 * An API key from the DHL developer portal, the business customer
 * portal login, and the billing number the label is charged to. A
 * standard parcel is created with the shopper as shipper and the store as
 * consignee; the label comes back as a PDF the app hosts. Contract rates
 * aren't quoted, so the one product is offered unpriced. The sandbox is
 * the test mode; tracking goes through DHL's unified tracking API.
 */

interface Env {
  apiKey: string;
  user: string;
  password: string;
  billing: string;
  sandbox: boolean;
}

const baseOf = (e: Env) => (e.sandbox ? env.DHL_PARCEL_DE_SANDBOX_URL : env.DHL_PARCEL_DE_API_URL);

const errorOf = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as { status?: { title?: string; detail?: string }; detail?: string; title?: string; items?: Array<{ sstatus?: { title?: string; detail?: string }; validationMessages?: Array<{ validationMessage?: string }> }> };
  const item = b.items?.[0];
  const validation = item?.validationMessages?.map((v) => v.validationMessage).filter(Boolean).join("; ");
  return validation || item?.sstatus?.detail || item?.sstatus?.title || b.status?.detail || b.status?.title || b.detail || b.title || null;
};

const call = <T>(e: Env, path: string, body?: unknown, method?: "GET" | "POST" | "DELETE") =>
  carrierCall<T>({
    base: baseOf(e),
    path,
    method,
    body,
    headers: { "dhl-api-key": e.apiKey, authorization: basic(e.user, e.password) },
    carrier: "DHL Paket",
    errorOf,
    unauthorized: "DHL Paket rejected the API key or the business customer login. Check them under Settings → Shipping, and that they belong to the environment chosen there.",
  });

/** ISO 3166-1 alpha-3, which this API wants where every other takes alpha-2. */
const ALPHA3: Record<string, string> = {
  DE: "DEU", AT: "AUT", CH: "CHE", NL: "NLD", BE: "BEL", FR: "FRA", IT: "ITA", ES: "ESP", PL: "POL", CZ: "CZE",
  DK: "DNK", SE: "SWE", NO: "NOR", FI: "FIN", GB: "GBR", IE: "IRL", PT: "PRT", LU: "LUX", US: "USA", IN: "IND",
  AU: "AUS", CA: "CAN", HU: "HUN", RO: "ROU", GR: "GRC", SK: "SVK", SI: "SVN", HR: "HRV", BG: "BGR", LT: "LTU",
  LV: "LVA", EE: "EST", TR: "TUR", JP: "JPN", CN: "CHN", MX: "MEX", BR: "BRA",
};
const alpha3 = (code: string) => (code.length === 3 ? code : (ALPHA3[code.toUpperCase()] ?? code));

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) => prisma.dhlParcelDeAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (a: DhlParcelDeAccount) => ({ connectedAt: a.createdAt, testMode: a.sandbox, billingNumber: a.billingNumber });

const envFor = (a: DhlParcelDeAccount): Env => {
  try {
    return { apiKey: decrypt(a.apiKey), user: a.username, password: decrypt(a.password), billing: a.billingNumber, sandbox: a.sandbox };
  } catch {
    throw unprocessable("The saved DHL Paket credentials can't be read — reconnect DHL Paket in settings.");
  }
};

/** A cheap authenticated read: the manifest documents endpoint says who's asking. */
const probe = (e: Env) => call(e, "/manifests?billingNumber=" + encodeURIComponent(e.billing), undefined, "GET");

export const connectAccount = async (merchantId: string, apiKey: string, username: string, password: string, billingNumber: string, sandbox: boolean) => {
  const e: Env = { apiKey: apiKey.trim(), user: username.trim(), password: password.trim(), billing: billingNumber.trim(), sandbox };
  if (!/^\d{14}$/.test(e.billing)) throw unprocessable("A DHL billing number is 14 digits: your EKP, the procedure and the participation.");
  try {
    await probe(e);
  } catch (error) {
    throw friendly(error, "DHL Paket didn't accept those credentials.");
  }
  const data = { apiKey: encrypt(e.apiKey), username: e.user, password: encrypt(e.password), billingNumber: e.billing, sandbox };
  return prisma.dhlParcelDeAccount.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.dhlParcelDeAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean }) => {
  if (!(await getAccount(merchantId))) throw notFound("DHL Paket isn't connected.");
  return prisma.dhlParcelDeAccount.update({ where: { merchantId }, data: { ...(input.testMode === undefined ? {} : { sandbox: input.testMode }) } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("DHL Paket isn't connected.");
  try {
    await probe(envFor(account));
  } catch (error) {
    throw friendly(error, "DHL Paket didn't answer.");
  }
  return { ok: true, testMode: account.sandbox };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

/** The product a domestic parcel is; abroad, the international one. */
const productFor = (parcel: Parcel) => (parcel.from.countryCode === "DE" && parcel.to.countryCode === "DE" ? "V01PAK" : "V53WPAK");

const PRODUCT_NAMES: Record<string, string> = { V01PAK: "DHL Paket", V53WPAK: "DHL Paket International" };

/** Contract rates aren't quoted by this API, so the one product is offered unpriced. */
export const quote = async (_account: DhlParcelDeAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  const product = productFor(parcel);
  return [
    {
      courierId: 1,
      name: PRODUCT_NAMES[product] ?? product,
      rate: null,
      currency: "EUR",
      shopRate: null,
      etd: null,
      days: null,
      surface: true,
      rating: null,
      recommended: true,
    },
  ];
};

const address = (p: Party) => {
  // "Musterstraße 12" → street and house number, which this API wants apart.
  const m = /^(.*?)[\s,]+(\d+[a-zA-Z\-/]*)$/.exec(p.address1.trim());
  return {
    name1: (fullName(p) || p.firstName).slice(0, 50),
    ...(p.address2 ? { name2: p.address2.slice(0, 50) } : {}),
    addressStreet: (m ? m[1] : p.address1).slice(0, 50),
    ...(m ? { addressHouse: m[2].slice(0, 10) } : {}),
    postalCode: p.pincode,
    city: p.city.slice(0, 40),
    country: alpha3(p.countryCode),
    ...(p.email ? { email: p.email } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
  };
};

interface OrderReply {
  status?: { title?: string; statusCode?: number };
  items?: Array<{ shipmentNo?: string; label?: { b64?: string; url?: string }; sstatus?: { title?: string; detail?: string; statusCode?: number }; validationMessages?: Array<{ validationMessage?: string }> }>;
}

export const book = async (
  request: LabelRequest,
  account: DhlParcelDeAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("DEUTSCHE_POST", returnId, actorId, step, error);
  const product = productFor(parcel);
  const name = PRODUCT_NAMES[product] ?? product;

  let shipmentNo: string;
  let label: string;
  try {
    const reply = await call<OrderReply>(e, "/orders?includeDocs=include&docFormat=PDF", {
      profile: "STANDARD_GRUPPENPROFIL",
      shipments: [
        {
          product,
          billingNumber: e.billing,
          refNo: orderId.slice(0, 35),
          shipper: address(parcel.from),
          consignee: address(parcel.to),
          details: {
            weight: { uom: "kg", value: parcel.weightKg },
            dim: { uom: "cm", length: Math.round(parcel.lengthCm), width: Math.round(parcel.breadthCm), height: Math.round(parcel.heightCm) },
          },
        },
      ],
    });
    const item = reply.items?.[0];
    const b64 = pdfBase64(item?.label?.b64);
    if (!item?.shipmentNo || !b64) {
      const why = item?.validationMessages?.map((v) => v.validationMessage).filter(Boolean).join("; ") || item?.sstatus?.detail || item?.sstatus?.title;
      throw new CarrierError(why || "DHL Paket didn't create the shipment.", 200, reply);
    }
    shipmentNo = item.shipmentNo;
    label = b64;
  } catch (error) {
    return fail("creating the shipment", error);
  }

  const saved = await saveShipment(returnId, "DEUTSCHE_POST", {
    provider: "DEUTSCHE_POST",
    isTest: account.sandbox,
    status: "LABEL_CREATED",
    courierId: 1,
    externalOrderId: orderId,
    externalShipmentId: shipmentNo,
    externalStatus: "Label created",
    externalStatusId: null,
    carrier: name,
    trackingNumber: shipmentNo,
    trackingUrl: `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${encodeURIComponent(shipmentNo)}`,
    labelData: label,
    pickupScheduledAt: null,
    pickupToken: null,
    scans: [],
    shippedAt: null,
    deliveredAt: null,
    lastError: null,
  });
  await prisma.returnShipment.update({ where: { id: saved.id }, data: { labelUrl: hostedLabelUrl(saved.id) } });

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${name}, shipment ${shipmentNo}${account.sandbox ? " — sandbox, nothing charged" : ""}`,
    { ok: true, awb: shipmentNo, courier: name, provider: "DEUTSCHE_POST", test: account.sandbox },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

/** DHL's unified tracking statuses. */
export const dhlUnifiedOutcome = (code: string | null | undefined): Outcome => {
  switch ((code ?? "").toLowerCase()) {
    case "pre-transit":
      return "WAITING";
    case "transit":
      return "IN_TRANSIT";
    case "delivered":
      return "DELIVERED";
    case "failure":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
};

interface TrackReply {
  shipments?: Array<{
    status?: { statusCode?: string; status?: string; timestamp?: string };
    estimatedTimeOfDelivery?: string;
    events?: Array<{ timestamp?: string; description?: string; statusCode?: string; location?: { address?: { addressLocality?: string } } }>;
  }>;
}

export const refresh = async (account: DhlParcelDeAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber) throw notFound("This return has no DHL shipment number.");
  const e = envFor(account);
  let reply: TrackReply;
  try {
    reply = await carrierCall<TrackReply>({
      base: env.DHL_TRACKING_API_URL,
      path: `/shipments?trackingNumber=${encodeURIComponent(shipment.trackingNumber)}&service=parcel-de`,
      method: "GET",
      headers: { "dhl-api-key": e.apiKey },
      carrier: "DHL tracking",
      errorOf,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  const found = reply.shipments?.[0];
  const outcome = dhlUnifiedOutcome(found?.status?.statusCode);
  if (!found || outcome === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  const scans: Scan[] = (found.events ?? [])
    .map((ev) => ({ date: ev.timestamp ?? "", activity: ev.description ?? "", location: ev.location?.address?.addressLocality ?? "", status: ev.statusCode ?? "" }))
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  await applyTracking(
    shipment,
    {
      outcome,
      statusLabel: found.status?.status ?? null,
      courier: shipment.carrier,
      scans,
      etd: found.estimatedTimeOfDelivery ?? null,
      pickedUpAt: scans.find((s) => s.status === "transit")?.date ?? null,
      deliveredAt: outcome === "DELIVERED" ? (found.status?.timestamp ?? scans[0]?.date ?? null) : null,
    },
    "poll",
  );
};

/** Unmanifested shipments can be deleted; a manifested one is billed regardless. */
export const cancelCalls = async (account: DhlParcelDeAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId) return [];
  try {
    await call(envFor(account), `/orders?profile=STANDARD_GRUPPENPROFIL&shipment=${encodeURIComponent(shipment.externalShipmentId)}`, undefined, "DELETE");
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};
