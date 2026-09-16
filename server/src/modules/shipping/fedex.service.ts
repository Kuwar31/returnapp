import type { FedexAccount, ReturnShipment } from "@prisma/client";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fullName, type Party } from "./addresses.js";
import { carrierCall, num, pdfBase64 } from "./carrier.http.js";
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
 * FedEx through its REST APIs.
 *
 * A project's client id and secret, exchanged for an hour's token, plus
 * the store's FedEx account number. Rates come back per service; a
 * return shipment made with the shopper as shipper and the store as
 * recipient, billed to the store's account, returns the label as a PDF
 * the app hosts. FedEx's sandbox is the test mode.
 */

interface Env {
  clientId: string;
  clientSecret: string;
  account: string;
  sandbox: boolean;
}

const baseOf = (e: Env) => (e.sandbox ? env.FEDEX_SANDBOX_URL : env.FEDEX_API_URL);

const errorOf = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const b = body as { errors?: Array<{ code?: string; message?: string }>; error_description?: string; error?: string };
  if (Array.isArray(b.errors) && b.errors.length) return b.errors.map((e) => [e.code, e.message].filter(Boolean).join(": ")).join("; ");
  return b.error_description ?? b.error ?? null;
};

/** Tokens last an hour; one is cached per account in the row. */
const tokenFor = async (a: FedexAccount, e: Env): Promise<string> => {
  if (a.token && a.tokenExpiresAt && a.tokenExpiresAt.getTime() > Date.now() + 60_000) return a.token;
  const reply = await carrierCall<{ access_token: string; expires_in?: number }>({
    base: baseOf(e),
    path: "/oauth/token",
    form: { grant_type: "client_credentials", client_id: e.clientId, client_secret: e.clientSecret },
    carrier: "FedEx",
    errorOf,
    unauthorized: "FedEx rejected the client id and secret. Check them under Settings → Shipping, and that they belong to the environment chosen there.",
  });
  await prisma.fedexAccount.update({
    where: { id: a.id },
    data: { token: reply.access_token, tokenExpiresAt: new Date(Date.now() + (reply.expires_in ?? 3600) * 1000) },
  });
  return reply.access_token;
};

const call = async <T>(a: FedexAccount, e: Env, path: string, body: unknown, method: "POST" | "PUT" = "POST") =>
  carrierCall<T>({
    base: baseOf(e),
    path,
    method,
    body,
    headers: { authorization: `Bearer ${await tokenFor(a, e)}`, "x-locale": "en_US" },
    carrier: "FedEx",
    errorOf,
    unauthorized: "FedEx rejected the token; reconnect FedEx under Settings → Shipping.",
  });

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

export const getAccount = (merchantId: string) => prisma.fedexAccount.findUnique({ where: { merchantId } });

export const serializeAccount = (a: FedexAccount) => ({
  connectedAt: a.createdAt,
  testMode: a.sandbox,
  accountNumber: a.accountNumber,
});

const envFor = (a: FedexAccount): Env => {
  try {
    return { clientId: decrypt(a.clientId), clientSecret: decrypt(a.clientSecret), account: a.accountNumber, sandbox: a.sandbox };
  } catch {
    throw unprocessable("The saved FedEx credentials can't be read — reconnect FedEx in settings.");
  }
};

export const connectAccount = async (merchantId: string, clientId: string, clientSecret: string, accountNumber: string, sandbox: boolean) => {
  const e: Env = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), account: accountNumber.trim(), sandbox };
  let token: { access_token: string; expires_in?: number };
  try {
    token = await carrierCall({
      base: baseOf(e),
      path: "/oauth/token",
      form: { grant_type: "client_credentials", client_id: e.clientId, client_secret: e.clientSecret },
      carrier: "FedEx",
      errorOf,
      unauthorized: "FedEx rejected the client id and secret.",
    });
  } catch (error) {
    throw friendly(error, "FedEx didn't accept those credentials.");
  }
  const data = {
    clientId: encrypt(e.clientId),
    clientSecret: encrypt(e.clientSecret),
    accountNumber: e.account,
    sandbox,
    token: token.access_token,
    tokenExpiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
  };
  return prisma.fedexAccount.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.fedexAccount.deleteMany({ where: { merchantId } });
};

export const updateAccount = async (merchantId: string, input: { testMode?: boolean }) => {
  if (!(await getAccount(merchantId))) throw notFound("FedEx isn't connected.");
  return prisma.fedexAccount.update({
    where: { merchantId },
    // A new environment needs a new token.
    data: { ...(input.testMode === undefined ? {} : { sandbox: input.testMode, token: null, tokenExpiresAt: null }) },
  });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("FedEx isn't connected.");
  try {
    await tokenFor({ ...account, token: null, tokenExpiresAt: null }, envFor(account));
  } catch (error) {
    throw friendly(error, "FedEx didn't answer.");
  }
  return { ok: true, testMode: account.sandbox };
};

// ---------------------------------------------------------------------------
// Quotes and bookings
// ---------------------------------------------------------------------------

const address = (p: Party) => ({
  streetLines: [p.address1, p.address2].filter(Boolean).map((l) => l.slice(0, 35)),
  city: p.city,
  ...(p.stateCode ? { stateOrProvinceCode: p.stateCode } : {}),
  postalCode: p.pincode,
  countryCode: p.countryCode,
});

const party = (p: Party) => ({
  contact: { personName: fullName(p) || p.firstName, phoneNumber: p.phone || "0000000000", ...(p.email ? { emailAddress: p.email } : {}) },
  address: address(p),
});

const lineItems = (parcel: Parcel) => [
  {
    weight: { units: "KG", value: parcel.weightKg },
    dimensions: { length: Math.round(parcel.lengthCm), width: Math.round(parcel.breadthCm), height: Math.round(parcel.heightCm), units: "CM" },
  },
];

interface RateDetail {
  serviceType: string;
  serviceName?: string;
  ratedShipmentDetails?: Array<{ totalNetCharge?: number; currency?: string }>;
  commit?: { dateDetail?: { dayFormat?: string }; transitDays?: { minimumTransitTime?: string } };
}

const quotesOf = (details: RateDetail[]): CourierQuote[] =>
  details
    .map((d) => ({ d, rate: num(d.ratedShipmentDetails?.[0]?.totalNetCharge), currency: d.ratedShipmentDetails?.[0]?.currency ?? "USD" }))
    .sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
    .map(({ d, rate, currency }, i) => ({
      courierId: serviceId("FEDEX", d.serviceType),
      name: `FedEx ${d.serviceName ?? d.serviceType.replace(/_/g, " ")}`,
      rate,
      currency,
      shopRate: null,
      etd: d.commit?.dateDetail?.dayFormat ?? null,
      days: null,
      surface: /GROUND/i.test(d.serviceType),
      rating: null,
      recommended: i === 0,
    }));

const rateQuotes = (a: FedexAccount, e: Env, parcel: Parcel) =>
  call<{ output?: { rateReplyDetails?: RateDetail[] } }>(a, e, "/rate/v1/rates/quotes", {
    accountNumber: { value: e.account },
    requestedShipment: {
      shipper: { address: address(parcel.from) },
      recipient: { address: address(parcel.to) },
      pickupType: "DROPOFF_AT_FEDEX_LOCATION",
      rateRequestType: ["ACCOUNT"],
      requestedPackageLineItems: lineItems(parcel),
    },
  });

export const quote = async (account: FedexAccount, parcel: Parcel): Promise<CourierQuote[]> => {
  try {
    const reply = await rateQuotes(account, envFor(account), parcel);
    const details = reply.output?.rateReplyDetails ?? [];
    if (!details.length) throw new CarrierError("FedEx offers no service on this lane for this parcel.", 200, reply);
    return quotesOf(details);
  } catch (error) {
    throw friendly(error, "FedEx couldn't rate the parcel.");
  }
};

interface ShipReply {
  output?: {
    transactionShipments?: Array<{
      masterTrackingNumber?: string;
      pieceResponses?: Array<{ trackingNumber?: string; packageDocuments?: Array<{ url?: string; encodedLabel?: string; contentType?: string }> }>;
    }>;
  };
}

export const book = async (
  request: LabelRequest,
  account: FedexAccount,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email: boolean; courierId: number | null },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const e = envFor(account);
  const fail = (step: string, error: unknown) => failStep("FEDEX", returnId, actorId, step, error);

  let details: RateDetail[];
  try {
    details = (await rateQuotes(account, e, parcel)).output?.rateReplyDetails ?? [];
    if (!details.length) throw new CarrierError("FedEx offers no service on this lane for this parcel.", 200);
  } catch (error) {
    return fail("rating the parcel", error);
  }
  const quotes = quotesOf(details);
  const chosen = (options.courierId !== null ? quotes.find((q) => q.courierId === options.courierId) : undefined) ?? quotes[0];
  const serviceType = details.find((d) => serviceId("FEDEX", d.serviceType) === chosen.courierId)!.serviceType;

  let tracking: string;
  let label: string;
  try {
    const reply = await call<ShipReply>(account, e, "/ship/v1/shipments", {
      labelResponseOptions: "LABEL",
      accountNumber: { value: e.account },
      requestedShipment: {
        shipper: party(parcel.from),
        recipients: [party(parcel.to)],
        shipDatestamp: new Date().toISOString().slice(0, 10),
        serviceType,
        packagingType: "YOUR_PACKAGING",
        pickupType: "DROPOFF_AT_FEDEX_LOCATION",
        shippingChargesPayment: { paymentType: "SENDER", payor: { responsibleParty: { accountNumber: { value: e.account } } } },
        shipmentSpecialServices: { specialServiceTypes: ["RETURN_SHIPMENT"], returnShipmentDetail: { returnType: "PRINT_RETURN_LABEL" } },
        labelSpecification: { imageType: "PDF", labelStockType: "PAPER_4X6" },
        requestedPackageLineItems: lineItems(parcel).map((li) => ({ ...li, customerReferences: [{ customerReferenceType: "CUSTOMER_REFERENCE", value: orderId.slice(0, 40) }] })),
      },
    });
    const ts = reply.output?.transactionShipments?.[0];
    const doc = ts?.pieceResponses?.[0]?.packageDocuments?.[0];
    tracking = ts?.masterTrackingNumber ?? ts?.pieceResponses?.[0]?.trackingNumber ?? "";
    const encoded = pdfBase64(doc?.encodedLabel);
    if (!tracking || !encoded) throw new CarrierError("FedEx made the shipment but returned no label.", 200, reply);
    label = encoded;
  } catch (error) {
    return fail("making the label", error);
  }

  const saved = await saveShipment(returnId, "FEDEX", {
    provider: "FEDEX",
    isTest: account.sandbox,
    status: "LABEL_CREATED",
    courierId: chosen.courierId,
    externalOrderId: orderId,
    externalShipmentId: tracking,
    externalStatus: "Label created",
    externalStatusId: null,
    carrier: chosen.name,
    trackingNumber: tracking,
    trackingUrl: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`,
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
    `Return label made with ${chosen.name}, tracking ${tracking}${account.sandbox ? " — sandbox, nothing charged" : ""}`,
    { ok: true, awb: tracking, courier: chosen.name, provider: "FEDEX", test: account.sandbox },
    options.email,
  );
};

// ---------------------------------------------------------------------------
// Tracking and cancelling
// ---------------------------------------------------------------------------

export const fedexOutcome = (code: string | null | undefined): Outcome => {
  switch ((code ?? "").toUpperCase()) {
    case "DL":
      return "DELIVERED";
    case "IT":
    case "OD":
    case "PU":
    case "AR":
    case "DP":
    case "HL":
      return "IN_TRANSIT";
    case "OC":
    case "IN":
      return "WAITING";
    case "CA":
      return "CANCELLED";
    case "DE":
    case "RS":
    case "SE":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
};

interface TrackReply {
  output?: {
    completeTrackResults?: Array<{
      trackResults?: Array<{
        latestStatusDetail?: { code?: string; description?: string; statusByLocale?: string };
        dateAndTimes?: Array<{ type?: string; dateTime?: string }>;
        scanEvents?: Array<{ date?: string; eventDescription?: string; derivedStatusCode?: string; scanLocation?: { city?: string; stateOrProvinceCode?: string } }>;
      }>;
    }>;
  };
}

const scansOf = (r: NonNullable<NonNullable<TrackReply["output"]>["completeTrackResults"]>[number]["trackResults"] extends (infer T)[] | undefined ? T : never): Scan[] =>
  (r?.scanEvents ?? [])
    .map((ev) => ({
      date: ev.date ?? "",
      activity: ev.eventDescription ?? "",
      location: [ev.scanLocation?.city, ev.scanLocation?.stateOrProvinceCode].filter(Boolean).join(", "),
      status: ev.derivedStatusCode ?? "",
    }))
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

export const refresh = async (account: FedexAccount, shipment: TrackedShipment): Promise<void> => {
  if (!shipment.trackingNumber) throw notFound("This return has no FedEx tracking number.");
  let reply: TrackReply;
  try {
    reply = await call<TrackReply>(account, envFor(account), "/track/v1/trackingnumbers", {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: shipment.trackingNumber } }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` } });
    throw friendly(error, message);
  }
  const result = reply.output?.completeTrackResults?.[0]?.trackResults?.[0];
  const outcome = fedexOutcome(result?.latestStatusDetail?.code);
  if (!result || outcome === "UNKNOWN") {
    await prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date(), lastError: null } });
    return;
  }
  const scans = scansOf(result);
  await applyTracking(
    shipment,
    {
      outcome,
      statusLabel: result.latestStatusDetail?.statusByLocale ?? result.latestStatusDetail?.description ?? null,
      courier: shipment.carrier,
      scans,
      etd: result.dateAndTimes?.find((d) => d.type === "ESTIMATED_DELIVERY")?.dateTime ?? null,
      pickedUpAt: scans.find((s) => s.status === "PU")?.date ?? null,
      deliveredAt: result.dateAndTimes?.find((d) => d.type === "ACTUAL_DELIVERY")?.dateTime ?? (outcome === "DELIVERED" ? scans[0]?.date : null) ?? null,
    },
    "poll",
  );
};

export const cancelCalls = async (account: FedexAccount, shipment: ReturnShipment): Promise<string[]> => {
  if (!shipment.trackingNumber) return [];
  try {
    const e = envFor(account);
    const reply = await call<{ output?: { cancelledShipment?: boolean; message?: string } }>(account, e, "/ship/v1/shipments/cancel", {
      accountNumber: { value: e.account },
      trackingNumber: shipment.trackingNumber,
    }, "PUT");
    return reply.output?.cancelledShipment === false ? [reply.output.message ?? "FedEx refused to cancel the shipment."] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};
