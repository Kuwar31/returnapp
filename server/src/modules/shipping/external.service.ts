import type { ExternalConnector, ReturnShipment } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { decrypt, encrypt, safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { carrierCall } from "./carrier.http.js";
import {
  applyTracking,
  failStep,
  finishBooking,
  friendly,
  hostedLabelUrl,
  saveShipment,
  trackedInclude,
  type CourierQuote,
  type LabelRequest,
  type Parcel,
} from "./shipments.js";

/**
 * The merchant's own label system — Loop's "external connector".
 *
 * The store gives a URL. Each return that needs a label is posted there,
 * signed with a shared secret, and the system on the other end answers
 * with the label straight away or, when it needs time, later through
 * /api/shipping/external/events, which the same secret authenticates.
 * Nothing is quoted or tracked here: the connector tells the app what it
 * knows, when it knows it.
 */

export const eventsUrl = () =>
  `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/external/events`;

export const getAccount = (merchantId: string) =>
  prisma.externalConnector.findUnique({ where: { merchantId } });

const secretOf = (account: ExternalConnector): string => {
  try {
    return decrypt(account.secret);
  } catch {
    throw unprocessable(
      "The saved connector secret can't be read — reconnect the external connector in settings.",
    );
  }
};

export const serializeAccount = (account: ExternalConnector) => ({
  connectedAt: account.createdAt,
  url: account.url,
  /** Shown once connected, so the merchant can put it in their own system. */
  secret: secretOf(account),
  eventsUrl: eventsUrl(),
  testMode: false,
});

// ---------------------------------------------------------------------------
// Talking to the connector
// ---------------------------------------------------------------------------

/** What the connector answers a label request with, now or later. */
interface LabelReply {
  labelUrl?: string | null;
  /** The label itself, when the connector would rather the app host it. */
  labelPdfBase64?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null;
  /** The connector's own id for the shipment, echoed back in later events. */
  shipmentId?: string | null;
}

const signature = (secret: string, raw: string) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

/** One signed POST to the connector; the body is what it gets, verbatim. */
const post = async <T>(
  account: ExternalConnector,
  body: Record<string, unknown>,
): Promise<T | null> => {
  const raw = JSON.stringify({ ...body, sentAt: new Date().toISOString() });
  const url = new URL(account.url);
  try {
    return await carrierCall<T | null>({
      base: url.origin,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      body: JSON.parse(raw) as unknown,
      headers: {
        "x-returns-signature": signature(secretOf(account), raw),
        "x-returns-event": String(body.event),
      },
      carrier: "Your connector",
      errorOf: (b) =>
        b &&
        typeof b === "object" &&
        typeof (b as { error?: unknown }).error === "string"
          ? (b as { error: string }).error
          : null,
      unauthorized:
        "Your connector refused the request. Check that it uses the secret shown under Settings → Shipping.",
      // carrierCall signs nothing itself; the header above is what the connector checks.
    });
  } catch (error) {
    throw friendly(error, "Your connector didn't answer.");
  }
};

const validUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ||
      (url.protocol === "http:" && !env.isProduction)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

/**
 * Keeps the URL after a ping it must answer 2xx to. The secret is the
 * merchant's when they gave one, else made here and shown to them.
 */
export const connectAccount = async (
  merchantId: string,
  urlInput: string,
  secretInput?: string | null,
) => {
  if (!env.ENCRYPTION_KEY) {
    throw unprocessable(
      "This server has no ENCRYPTION_KEY, so it can't keep a connector secret.",
    );
  }
  const url = validUrl(urlInput);
  if (!url) throw unprocessable("Enter the connector's full https:// address.");
  const secret = (secretInput ?? "").trim() || randomBytes(24).toString("hex");
  if (secret.length < 16)
    throw unprocessable("The secret must be at least 16 characters.");
  const draft = {
    merchantId,
    url,
    secret: encrypt(secret),
    id: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await post(draft, { event: "ping", merchantId, eventsUrl: eventsUrl() });
  return prisma.externalConnector.upsert({
    where: { merchantId },
    create: { merchantId, url, secret: encrypt(secret) },
    update: { url, secret: encrypt(secret) },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.externalConnector.deleteMany({ where: { merchantId } });
};

export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("No external connector is set up.");
  await post(account, { event: "ping", merchantId, eventsUrl: eventsUrl() });
  return { ok: true, testMode: false };
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The one "service" a connector offers: whatever it chooses, unpriced. */
export const quote = (): CourierQuote[] => [
  {
    courierId: 990001,
    name: "Your connector",
    rate: null,
    currency: undefined,
    shopRate: null,
    etd: null,
    days: null,
    surface: false,
    rating: null,
    recommended: true,
  },
];

/** The label and tracking the connector gave, as a shipment update. */
const labelData = (reply: LabelReply, shipmentId: string) => {
  const pdf =
    reply.labelPdfBase64?.replace(/^data:application\/pdf;base64,/, "") || null;
  const labelUrl =
    reply.labelUrl?.trim() || (pdf ? hostedLabelUrl(shipmentId) : null);
  return {
    labelUrl,
    labelData: pdf,
    trackingNumber: reply.trackingNumber?.trim() || null,
    trackingUrl: reply.trackingUrl?.trim() || null,
    carrier: reply.carrier?.trim() || null,
    externalShipmentId: reply.shipmentId?.trim() || null,
  };
};

/**
 * Asks the connector for a label. An answer that carries one finishes the
 * booking; an empty or 202 answer leaves the shipment pending until the
 * connector posts an event.
 */
export const book = async (
  request: LabelRequest,
  account: ExternalConnector,
  parcel: Parcel,
  orderId: string,
  actorId: string | null,
  options: { email?: boolean },
): Promise<ReturnShipment> => {
  const returnId = request.id;
  const email = options.email !== false;
  const saved = await saveShipment(returnId, "EXTERNAL", {
    status: "PENDING",
    isTest: false,
    carrier: null,
    courierId: null,
    trackingNumber: null,
    trackingUrl: null,
    labelUrl: null,
    labelData: null,
    externalOrderId: orderId,
    externalShipmentId: null,
    lastError: null,
  });

  let reply: LabelReply | null;
  try {
    reply = await post<LabelReply>(account, {
      event: "label.requested",
      merchantId: request.merchantId,
      returnId,
      reference: request.reference,
      orderNumber: request.order.orderNumber,
      orderId: request.order.externalId,
      shipmentReference: orderId,
      customer: { name: request.customerName, email: request.customerEmail },
      from: parcel.from,
      to: parcel.to,
      items: parcel.items,
      parcel: {
        lengthCm: parcel.lengthCm,
        breadthCm: parcel.breadthCm,
        heightCm: parcel.heightCm,
        weightKg: parcel.weightKg,
        value: parcel.value,
        currency: request.order.currency,
      },
      eventsUrl: eventsUrl(),
    });
  } catch (error) {
    return failStep(
      "EXTERNAL",
      returnId,
      actorId,
      "asking your connector for a label",
      error,
    );
  }

  const data =
    reply && typeof reply === "object" ? labelData(reply, saved.id) : null;
  if (!data?.labelUrl) {
    await prisma.returnShipment.update({
      where: { id: saved.id },
      data: { ...(data ?? {}), labelUrl: null, status: "PENDING" },
    });
    return finishBooking(
      returnId,
      actorId,
      "Label asked of your connector; waiting for it to send one back",
      { ok: true, pending: true, provider: "EXTERNAL" },
      false,
    );
  }
  await prisma.returnShipment.update({
    where: { id: saved.id },
    data: { ...data, status: "LABEL_CREATED" },
  });
  return finishBooking(
    returnId,
    actorId,
    `Return label made by your connector${data.carrier ? ` with ${data.carrier}` : ""}${data.trackingNumber ? `, tracking ${data.trackingNumber}` : ""}`,
    {
      ok: true,
      awb: data.trackingNumber,
      courier: data.carrier,
      provider: "EXTERNAL",
    },
    email,
  );
};

/** Tells the connector the label isn't needed. Best effort, as with every carrier. */
export const cancelCalls = async (
  account: ExternalConnector,
  shipment: ReturnShipment,
): Promise<string[]> => {
  try {
    const request = await prisma.returnRequest.findUnique({
      where: { id: shipment.returnRequestId },
      select: { reference: true },
    });
    await post(account, {
      event: "label.cancelled",
      returnId: shipment.returnRequestId,
      reference: request?.reference ?? null,
      shipmentId: shipment.externalShipmentId,
      trackingNumber: shipment.trackingNumber,
    });
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

// ---------------------------------------------------------------------------
// What the connector sends back
// ---------------------------------------------------------------------------

const STATUSES = [
  "LABEL_CREATED",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
] as const;
type InboundStatus = (typeof STATUSES)[number];

/**
 * An event from the connector: the label for a pending return, or where
 * the parcel is now. Named by the return id the app sent, and
 * authenticated by the store's secret in `x-api-key`.
 */
export const handleEvent = async (
  apiKey: string | undefined,
  body: unknown,
): Promise<"unauthorized" | "ignored" | "labelled" | "tracked"> => {
  if (!apiKey || !body || typeof body !== "object") return "unauthorized";
  const b = body as LabelReply & {
    returnId?: string;
    reference?: string;
    status?: string;
    statusLabel?: string;
    error?: string;
  };
  const shipment = await prisma.returnShipment.findFirst({
    where: {
      provider: "EXTERNAL",
      returnRequest: b.returnId
        ? { id: String(b.returnId) }
        : b.reference
          ? { reference: String(b.reference) }
          : { id: "" },
    },
    include: trackedInclude,
  });
  if (!shipment) return "unauthorized";
  const account = await getAccount(shipment.returnRequest.merchantId);
  if (!account || !safeEqual(apiKey, secretOf(account))) return "unauthorized";
  if (shipment.status === "CANCELLED") return "ignored";

  const data = labelData(b, shipment.id);
  const status =
    typeof b.status === "string" &&
    (STATUSES as readonly string[]).includes(b.status.toUpperCase())
      ? (b.status.toUpperCase() as InboundStatus)
      : null;

  // A label for a return still waiting on one.
  if (!shipment.labelUrl && data.labelUrl) {
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { ...data, status: "LABEL_CREATED", lastError: null },
    });
    await finishBooking(
      shipment.returnRequestId,
      null,
      `Return label sent by your connector${data.carrier ? ` with ${data.carrier}` : ""}${data.trackingNumber ? `, tracking ${data.trackingNumber}` : ""}`,
      {
        ok: true,
        awb: data.trackingNumber,
        courier: data.carrier,
        provider: "EXTERNAL",
      },
      true,
    );
    if (!status || status === "LABEL_CREATED") return "labelled";
  } else if (status === "FAILED" || typeof b.error === "string") {
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: {
        status: "FAILED",
        lastError: `from your connector: ${b.error ?? "it couldn't make the label"}`,
      },
    });
    logger.warn(
      { returnId: shipment.returnRequestId },
      "External connector reported a failed label",
    );
    return "tracked";
  }

  if (!status || status === "LABEL_CREATED") {
    // Tracking details alone, for a label already in hand.
    const details = Object.fromEntries(
      Object.entries(data).filter(
        ([k, v]) => v && k !== "labelUrl" && k !== "labelData",
      ),
    );
    if (Object.keys(details).length)
      await prisma.returnShipment.update({
        where: { id: shipment.id },
        data: details,
      });
    return "ignored";
  }
  const fresh = await prisma.returnShipment.findUniqueOrThrow({
    where: { id: shipment.id },
    include: trackedInclude,
  });
  await applyTracking(
    fresh,
    {
      outcome:
        status === "IN_TRANSIT"
          ? "IN_TRANSIT"
          : status === "DELIVERED"
            ? "DELIVERED"
            : "FAILED",
      statusLabel:
        typeof b.statusLabel === "string"
          ? b.statusLabel
          : status.replace("_", " ").toLowerCase(),
      courier: data.carrier,
    },
    "webhook",
  );
  return "tracked";
};
