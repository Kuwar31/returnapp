import type { ReturnShipment, ShipStationAccount } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import { serviceId } from "./easypost.service.js";
import {
  CarrierError,
  failStep,
  finishBooking,
  friendly,
  hostedLabelUrl,
  saveShipment,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
} from "./shipments.js";

/**
 * ShipStation as a return-label carrier.
 *
 * An API key and secret front the carriers the store has set up in
 * ShipStation. Rates are asked for per carrier; a label is made in one
 * call and comes back as a PDF, which this app hosts, since ShipStation
 * doesn't. There's no tracking API — the merchant marks the return
 * received when the parcel arrives — and no sandbox: the test mode asks
 * for test labels, which ShipStation voids and never charges for.
 */

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

interface Env {
  apiKey: string;
  apiSecret: string;
}

const TIMEOUT_MS = 20_000;

const request = async <T>(e: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.SHIPSTATION_API_URL.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${e.apiKey}:${e.apiSecret}`).toString("base64")}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError" ? "ShipStation didn't answer in time." : "Couldn't reach ShipStation.",
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
    throw new CarrierError("ShipStation rejected the API key and secret. Check them under Settings → Shipping.", res.status, parsed);
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && typeof (parsed as { Message?: unknown }).Message === "string"
        ? (parsed as { Message: string }).Message
        : parsed && typeof parsed === "object" && typeof (parsed as { ExceptionMessage?: unknown }).ExceptionMessage === "string"
          ? (parsed as { ExceptionMessage: string }).ExceptionMessage
          : typeof parsed === "string" && parsed.trim()
            ? parsed.trim().slice(0, 300)
            : `ShipStation returned ${res.status}.`;
    throw new CarrierError(message, res.status, parsed);
  }
  return parsed as T;
};

interface Carrier {
  name: string;
  code: string;
  accountNumber?: string | null;
  requiresFundedAccount?: boolean;
  balance?: number | null;
}

interface RateRow {
  serviceName: string;
  serviceCode: string;
  shipmentCost: number;
  otherCost: number;
}

interface LabelReply {
  shipmentId: number;
  shipmentCost?: number;
  trackingNumber?: string | null;
  labelData?: string | null;
  voided?: boolean;
}

const listCarriers = (e: Env) => request<Carrier[]>(e, "GET", "/carriers");

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) => prisma.shipStationAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (account: ShipStationAccount) => ({
  connectedAt: account.createdAt,
  testMode: account.testLabels,
  currency: account.currency,
});

const envFor = (account: ShipStationAccount): Env => {
  try {
    return { apiKey: decrypt(account.apiKey), apiSecret: decrypt(account.apiSecret) };
  } catch {
    throw unprocessable("The saved ShipStation credentials can't be read — reconnect ShipStation in settings.");
  }
};

export const connectAccount = async (merchantId: string, apiKey: string, apiSecret: string, currency: string) => {
  try {
    await listCarriers({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
  } catch (error) {
    throw friendly(error, "ShipStation didn't accept those credentials.");
  }
  return prisma.shipStationAccount.upsert({
    where: { merchantId },
    create: { merchantId, apiKey: encrypt(apiKey.trim()), apiSecret: encrypt(apiSecret.trim()), currency },
    update: { apiKey: encrypt(apiKey.trim()), apiSecret: encrypt(apiSecret.trim()), currency },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.shipStationAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean; currency?: string }) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("ShipStation isn't connected.");
  return prisma.shipStationAccount.update({
    where: { merchantId },
    data: {
      ...(input.testMode === undefined ? {} : { testLabels: input.testMode }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
    },
  });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("ShipStation isn't connected.");
  let carriers: Carrier[];
  try {
    carriers = await listCarriers(envFor(account));
  } catch (error) {
    throw friendly(error, "ShipStation didn't answer.");
  }
  return { ok: true, testMode: account.testLabels, carriers: carriers.map((c) => c.name) };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const address = (p: Party) => ({
  name: fullName(p) || p.firstName,
  street1: p.address1,
  street2: p.address2 || null,
  city: p.city,
  state: p.stateCode || p.state,
  postalCode: p.pincode,
  country: p.countryCode,
  phone: p.phone || null,
  residential: null as boolean | null,
});

const measures = (parcel: Parcel) => ({
  weight: { value: Math.round(parcel.weightKg * 1000), units: "grams" },
  dimensions: { units: "centimeters", length: parcel.lengthCm, width: parcel.breadthCm, height: parcel.heightCm },
});

/** Every carrier's services, cheapest first. A carrier that can't rate this parcel is left out. */
export const quote = async (account: ShipStationAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  const e = envFor(account);
  let carriers: Carrier[];
  try {
    carriers = await listCarriers(e);
  } catch (error) {
    throw friendly(error, "ShipStation couldn't list the carriers.");
  }
  const found: CourierQuote[] = [];
  const problems: string[] = [];
  for (const carrier of carriers) {
    try {
      const rows = await request<RateRow[]>(e, "POST", "/shipments/getrates", {
        carrierCode: carrier.code,
        fromPostalCode: parcel.from.pincode,
        fromCity: parcel.from.city,
        fromState: parcel.from.stateCode || parcel.from.state,
        toState: parcel.to.stateCode || parcel.to.state,
        toCountry: parcel.to.countryCode,
        toPostalCode: parcel.to.pincode,
        toCity: parcel.to.city,
        ...measures(parcel),
        confirmation: "none",
        residential: false,
      });
      for (const r of rows) {
        found.push({
          courierId: serviceId(carrier.code, r.serviceCode),
          name: `${carrier.name} ${r.serviceName}`.trim(),
          rate: Math.round(((r.shipmentCost ?? 0) + (r.otherCost ?? 0)) * 100) / 100,
          currency: account.currency,
          shopRate: null,
          etd: null,
          days: null,
          surface: !/express|priority|overnight|next|air/i.test(r.serviceName),
          rating: null,
          recommended: false,
        });
      }
    } catch (error) {
      problems.push(`${carrier.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (found.length === 0) {
    throw unprocessable(
      problems.length
        ? `No ShipStation carrier rated this parcel: ${problems.join("; ")}`
        : "No carrier in the ShipStation account rated this parcel. Check the addresses and the carriers set up there.",
    );
  }
  found.sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity));
  found[0].recommended = true;
  return found;
};

/** Where the carrier's own tracking page is, by ShipStation's carrier code. */
const trackingUrlFor = (carrierCode: string, tracking: string): string | null => {
  const n = encodeURIComponent(tracking);
  if (/^stamps|^usps|^express_1/.test(carrierCode)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (/^ups/.test(carrierCode)) return `https://www.ups.com/track?tracknum=${n}`;
  if (/^fedex/.test(carrierCode)) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (/^dhl/.test(carrierCode)) return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`;
  return null;
};

/** One call: the label comes back as a PDF, which the app then hosts. */
export const book = async (
  request_: LabelRequest,
  account: ShipStationAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request_.id;
  const fail = (step: string, error: unknown) => failStep("SHIPSTATION", returnId, actorId, step, error);

  let quotes: CourierQuote[];
  let carriers: Carrier[];
  try {
    const e = envFor(account);
    carriers = await listCarriers(e);
    quotes = await quote(account, parcel);
  } catch (error) {
    return fail("rating the parcel", error);
  }
  const chosen = (options.courierId !== null ? quotes.find((q) => q.courierId === options.courierId) : undefined) ?? quotes[0];
  // Recover the codes from the name, since the quote carries only the hash.
  const carrier = carriers.find((c) => chosen.name.startsWith(c.name));
  if (!carrier) return fail("choosing a service", new Error("The chosen service is no longer offered."));
  let serviceCode: string | null = null;
  try {
    const rows = await request<RateRow[]>(envFor(account), "POST", "/shipments/getrates", {
      carrierCode: carrier.code,
      fromPostalCode: parcel.from.pincode,
      toState: parcel.to.stateCode || parcel.to.state,
      toCountry: parcel.to.countryCode,
      toPostalCode: parcel.to.pincode,
      toCity: parcel.to.city,
      ...measures(parcel),
      confirmation: "none",
      residential: false,
    });
    serviceCode = rows.find((r) => serviceId(carrier.code, r.serviceCode) === chosen.courierId)?.serviceCode ?? rows[0]?.serviceCode ?? null;
  } catch (error) {
    return fail("choosing a service", error);
  }
  if (!serviceCode) return fail("choosing a service", new Error("The chosen service is no longer offered."));

  let label: LabelReply;
  try {
    label = await request<LabelReply>(envFor(account), "POST", "/shipments/createlabel", {
      carrierCode: carrier.code,
      serviceCode,
      packageCode: "package",
      confirmation: "none",
      shipDate: new Date().toISOString().slice(0, 10),
      ...measures(parcel),
      shipFrom: address(parcel.from),
      shipTo: address(parcel.to),
      testLabel: account.testLabels,
    });
    if (!label.labelData || !label.trackingNumber) throw new CarrierError("ShipStation returned no label.", 200, label);
  } catch (error) {
    return fail("making the label", error);
  }

  const saved = await saveShipment(returnId, "SHIPSTATION", {
    provider: "SHIPSTATION",
    isTest: account.testLabels,
    status: "LABEL_CREATED",
    courierId: chosen.courierId,
    externalOrderId: orderId,
    externalShipmentId: String(label.shipmentId),
    externalStatus: "Label created",
    externalStatusId: null,
    carrier: chosen.name,
    trackingNumber: label.trackingNumber,
    trackingUrl: trackingUrlFor(carrier.code, label.trackingNumber),
    labelData: label.labelData,
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
    `Return label made with ${chosen.name}, tracking ${label.trackingNumber}${account.testLabels ? " — test label, nothing charged" : ""}`,
    { ok: true, awb: label.trackingNumber, courier: chosen.name, provider: "SHIPSTATION", test: account.testLabels },
    options.email,
  );
};

/** ShipStation voids the label; an already-used one is refused. */
export const cancelCalls = async (account: ShipStationAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.externalShipmentId) return [];
  try {
    const result = await request<{ approved?: boolean; message?: string }>(envFor(account), "POST", "/shipments/voidlabel", {
      shipmentId: Number(shipment.externalShipmentId),
    });
    return result.approved === false ? [result.message ?? "ShipStation refused to void the label."] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};
