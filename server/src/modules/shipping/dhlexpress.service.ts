import type { DhlExpressAccount, ReturnShipment } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import { basic, carrierCall, num, pdfBase64 } from "./carrier.http.js";
import { serviceId } from "./easypost.service.js";
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
 * DHL Express through the MyDHL API.
 *
 * An API key and secret plus the store's DHL account number. Rates come
 * back per product; a shipment made with the shopper as shipper and the
 * store as receiver, billed to the store's account, returns the label as
 * a base64 PDF the app hosts. DHL's test environment is the test mode.
 * DHL doesn't cancel a label — an unused one isn't billed.
 */

interface Env {
  key: string;
  secret: string;
  account: string;
  test: boolean;
}

const baseOf = (e: Env) => (e.test ? env.DHL_EXPRESS_TEST_URL : env.DHL_EXPRESS_API_URL);

const errorOf = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as { detail?: unknown; message?: unknown; title?: unknown; additionalDetails?: unknown };
  const details = Array.isArray(b.additionalDetails) ? b.additionalDetails.map(String).join("; ") : "";
  const main = [b.detail, b.message, b.title].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return main ? (details ? `${main} (${details})` : main) : details || null;
};

const call = <T>(e: Env, path: string, body?: unknown, method?: "GET" | "POST" | "DELETE") =>
  carrierCall<T>({
    base: baseOf(e),
    path,
    method,
    body,
    headers: { authorization: basic(e.key, e.secret) },
    carrier: "DHL Express",
    errorOf,
    unauthorized: "DHL Express rejected the API key and secret. Check them under Settings → Shipping, and that they belong to the environment chosen there.",
  });

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) => prisma.dhlExpressAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (a: DhlExpressAccount) => ({
  connectedAt: a.createdAt,
  testMode: a.testMode,
  accountNumber: a.accountNumber,
});

const envFor = (a: DhlExpressAccount): Env => {
  try {
    return { key: decrypt(a.apiKey), secret: decrypt(a.apiSecret), account: a.accountNumber, test: a.testMode };
  } catch {
    throw unprocessable("The saved DHL Express credentials can't be read — reconnect DHL Express in settings.");
  }
};

/** Rates for a small parcel between two places DHL is sure to know. */
const probe = (e: Env) =>
  call(e, "/rates", {
    customerDetails: {
      shipperDetails: { postalCode: "10001", cityName: "New York", countryCode: "US" },
      receiverDetails: { postalCode: "SW1A 1AA", cityName: "London", countryCode: "GB" },
    },
    accounts: [{ typeCode: "shipper", number: e.account }],
    plannedShippingDateAndTime: `${new Date().toISOString().slice(0, 10)}T10:00:00 GMT+00:00`,
    unitOfMeasurement: "metric",
    isCustomsDeclarable: false,
    packages: [{ weight: 0.5, dimensions: { length: 10, width: 10, height: 10 } }],
  });

export const connectAccount = async (merchantId: string, apiKey: string, apiSecret: string, accountNumber: string, testMode: boolean) => {
  const e: Env = { key: apiKey.trim(), secret: apiSecret.trim(), account: accountNumber.trim(), test: testMode };
  try {
    await probe(e);
  } catch (error) {
    throw friendly(error, "DHL Express didn't accept those credentials.");
  }
  return prisma.dhlExpressAccount.upsert({
    where: { merchantId },
    create: { merchantId, apiKey: encrypt(e.key), apiSecret: encrypt(e.secret), accountNumber: e.account, testMode },
    update: { apiKey: encrypt(e.key), apiSecret: encrypt(e.secret), accountNumber: e.account, testMode },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.dhlExpressAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean }) => {
  if (!(await getAccount(merchantId))) throw notFound("DHL Express isn't connected.");
  return prisma.dhlExpressAccount.update({ where: { merchantId }, data: { ...(input.testMode === undefined ? {} : { testMode: input.testMode }) } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("DHL Express isn't connected.");
  try {
    await probe(envFor(account));
  } catch (error) {
    throw friendly(error, "DHL Express didn't answer.");
  }
  return { ok: true, testMode: account.testMode };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const when = () => `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:00:00 GMT+00:00`;

const details = (p: Party) => ({
  postalAddress: {
    postalCode: p.pincode,
    cityName: p.city,
    countryCode: p.countryCode,
    addressLine1: p.address1.slice(0, 45),
    ...(p.address2 ? { addressLine2: p.address2.slice(0, 45) } : {}),
    ...(p.stateCode ? { provinceCode: p.stateCode } : {}),
  },
  contactInformation: {
    fullName: fullName(p) || p.firstName,
    companyName: (p.company || fullName(p) || p.firstName).slice(0, 35),
    phone: p.phone || "0000000000",
    ...(p.email ? { email: p.email } : {}),
  },
});

const packages = (parcel: Parcel) => [
  { weight: parcel.weightKg, dimensions: { length: parcel.lengthCm, width: parcel.breadthCm, height: parcel.heightCm } },
];

interface Product {
  productName?: string;
  productCode: string;
  totalPrice?: Array<{ currencyType?: string; priceCurrency?: string; price?: number }>;
  deliveryCapabilities?: { estimatedDeliveryDateAndTime?: string; totalTransitDays?: number };
}

const priceOf = (p: Product) => {
  const billed = p.totalPrice?.find((t) => t.currencyType === "BILLC") ?? p.totalPrice?.[0];
  return { rate: num(billed?.price), currency: billed?.priceCurrency ?? "USD" };
};

const quotesOf = (products: Product[]): CourierQuote[] =>
  products
    .map((p) => ({ p, ...priceOf(p) }))
    .sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
    .map(({ p, rate, currency }, i) => ({
      courierId: serviceId("DHL", p.productCode),
      name: `DHL Express ${p.productName ?? p.productCode}`,
      rate,
      currency,
      shopRate: null,
      etd: p.deliveryCapabilities?.estimatedDeliveryDateAndTime ?? null,
      days: p.deliveryCapabilities?.totalTransitDays ?? null,
      surface: false,
      rating: null,
      recommended: i === 0,
    }));

const rates = (e: Env, parcel: Parcel) =>
  call<{ products?: Product[] }>(e, "/rates", {
    customerDetails: {
      shipperDetails: { postalCode: parcel.from.pincode, cityName: parcel.from.city, countryCode: parcel.from.countryCode },
      receiverDetails: { postalCode: parcel.to.pincode, cityName: parcel.to.city, countryCode: parcel.to.countryCode },
    },
    accounts: [{ typeCode: "shipper", number: e.account }],
    plannedShippingDateAndTime: when(),
    unitOfMeasurement: "metric",
    isCustomsDeclarable: parcel.from.countryCode !== parcel.to.countryCode,
    packages: packages(parcel),
  });

export const quote = async (account: DhlExpressAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  try {
    const reply = await rates(envFor(account), parcel);
    if (!reply.products?.length) throw new CarrierError("DHL Express offers no product on this lane for this parcel.", 200, reply);
    return quotesOf(reply.products);
  } catch (error) {
    throw friendly(error, "DHL Express couldn't rate the parcel.");
  }
};

export const book = async (
  request: LabelRequest,
  account: DhlExpressAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("DHL_EXPRESS", returnId, actorId, step, error);

  let products: Product[];
  try {
    const reply = await rates(e, parcel);
    products = reply.products ?? [];
    if (!products.length) throw new CarrierError("DHL Express offers no product on this lane for this parcel.", 200, reply);
  } catch (error) {
    return fail("rating the parcel", error);
  }
  const quotes = quotesOf(products);
  const chosen = (options.courierId !== null ? quotes.find((q) => q.courierId === options.courierId) : undefined) ?? quotes[0];
  const product = products.find((p) => serviceId("DHL", p.productCode) === chosen.courierId)!;

  let made: { shipmentTrackingNumber?: string; trackingUrl?: string; documents?: Array<{ typeCode?: string; imageFormat?: string; content?: string }> };
  try {
    made = await call(e, "/shipments", {
      plannedShippingDateAndTime: when(),
      pickup: { isRequested: false },
      productCode: product.productCode,
      accounts: [{ typeCode: "shipper", number: e.account }],
      customerDetails: { shipperDetails: details(parcel.from), receiverDetails: details(parcel.to) },
      // The store's label references, else the booking's own; DHL prints up to three.
      customerReferences: (parcel.references.length ? parcel.references : [orderId]).slice(0, 3).map((value) => ({ value: value.slice(0, 35), typeCode: "CU" })),
      content: {
        packages: packages(parcel),
        isCustomsDeclarable: parcel.from.countryCode !== parcel.to.countryCode,
        description: "Returned goods",
        incoterm: "DAP",
        unitOfMeasurement: "metric",
        ...(parcel.from.countryCode !== parcel.to.countryCode
          ? { declaredValue: parcel.value, declaredValueCurrency: request.order.currency }
          : {}),
      },
      outputImageProperties: { encodingFormat: "pdf", imageOptions: [{ typeCode: "label", templateName: "ECOM26_84_001" }] },
    });
    const label = pdfBase64(made.documents?.find((d) => d.typeCode === "label")?.content ?? made.documents?.[0]?.content);
    if (!made.shipmentTrackingNumber || !label) throw new CarrierError("DHL Express made the shipment but returned no label.", 200, made);
    const saved = await saveShipment(returnId, "DHL_EXPRESS", {
      provider: "DHL_EXPRESS",
      isTest: account.testMode,
      status: "LABEL_CREATED",
      courierId: chosen.courierId,
      externalOrderId: orderId,
      externalShipmentId: made.shipmentTrackingNumber,
      externalStatus: "Label created",
      externalStatusId: null,
      carrier: chosen.name,
      trackingNumber: made.shipmentTrackingNumber,
      trackingUrl: made.trackingUrl ?? `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(made.shipmentTrackingNumber)}`,
      labelData: label,
      pickupScheduledAt: null,
      pickupToken: null,
      scans: [],
      shippedAt: null,
      deliveredAt: null,
      lastError: null,
    });
    await prisma.returnShipment.update({ where: { id: saved.id }, data: { labelUrl: hostedLabelUrl(saved.id) } });
  } catch (error) {
    return fail("making the label", error);
  }

  return finishBooking(
    returnId,
    actorId,
    `Return label made with ${chosen.name}, waybill ${made.shipmentTrackingNumber}${account.testMode ? " — test environment, nothing charged" : ""}`,
    { ok: true, awb: made.shipmentTrackingNumber, courier: chosen.name, provider: "DHL_EXPRESS", test: account.testMode },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

/** DHL Express event type codes, the ones that matter. */
export const dhlExpressOutcome = (code: string | null | undefined, description?: string | null): Outcome => {
  const c = (code ?? "").toUpperCase();
  const d = (description ?? "").toLowerCase();
  if (c === "OK" || /delivered/.test(d)) return "DELIVERED";
  if (c === "RT" || /returned|undeliverable/.test(d)) return "FAILED";
  if (c === "SD" || c === "SA" || /shipment information received|created/.test(d)) return "WAITING";
  if (["PU", "PL", "DF", "AF", "AR", "WC", "CC", "MD", "OH"].includes(c) || /picked up|transit|departed|arrived|with delivery courier/.test(d)) return "IN_TRANSIT";
  return "UNKNOWN";
};

interface TrackReply {
  shipments?: Array<{
    status?: string;
    estimatedDeliveryDate?: string;
    events?: Array<{ date?: string; time?: string; typeCode?: string; description?: string; serviceArea?: Array<{ description?: string }> }>;
  }>;
}

const scansOf = (reply: TrackReply): Scan[] =>
  (reply.shipments?.[0]?.events ?? [])
    .map((ev) => ({
      date: [ev.date, ev.time].filter(Boolean).join("T"),
      activity: ev.description ?? "",
      location: ev.serviceArea?.[0]?.description ?? "",
      status: ev.typeCode ?? "",
    }))
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

export const refresh = async (account: DhlExpressAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber) throw notFound("This return has no DHL Express waybill.");
  let reply: TrackReply;
  try {
    reply = await call<TrackReply>(envFor(account), `/shipments/${encodeURIComponent(shipment.trackingNumber)}/tracking`, undefined, "GET");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  const scans = scansOf(reply);
  const latest = scans[0];
  const outcome = dhlExpressOutcome(latest?.status, latest?.activity);
  if (!latest || outcome === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  await applyTracking(
    shipment,
    {
      outcome,
      statusLabel: latest.activity || latest.status,
      courier: shipment.carrier,
      scans,
      etd: reply.shipments?.[0]?.estimatedDeliveryDate ?? null,
      pickedUpAt: scans.find((s) => s.status === "PU")?.date ?? null,
      deliveredAt: outcome === "DELIVERED" ? latest.date : null,
    },
    "poll",
  );
};

/** DHL Express has no label cancellation; an unused label is simply not billed. */
export const cancelCalls = async (_account: DhlExpressAccount, _shipment: ReturnShipment): Promise<string[]> => [];
