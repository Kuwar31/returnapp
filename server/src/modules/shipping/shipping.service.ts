import type { ReturnShipment, ShipmentProvider } from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import * as delhivery from "./delhivery.service.js";
import * as easypost from "./easypost.service.js";
import * as auspost from "./auspost.service.js";
import * as dhlexpress from "./dhlexpress.service.js";
import * as dhlparcelde from "./dhlparcelde.service.js";
import * as external from "./external.service.js";
import * as fedex from "./fedex.service.js";
import * as sendcloud from "./sendcloud.service.js";
import * as shippo from "./shippo.service.js";
import * as shipstation from "./shipstation.service.js";
import * as shiprocket from "./shiprocket.service.js";
import { getSettings, type ShippingSettingsRow } from "./shipping.settings.js";
import { changeStatus } from "../returns/returns.service.js";
import { notify } from "../email/notifications.js";
import { annotateOrdersInBackground } from "../shopify/order-notes.service.js";
import {
  PHONE_RULES,
  PROVIDER_NAMES,
  TEST_COURIERS,
  bookTestLabel,
  bookable,
  byRate,
  event,
  failStep,
  loadForLabel,
  OPEN_FOR_LABEL,
  parcelFor,
  ruleMethodOf,
  rupeesToShop,
  trackedInclude,
  type CourierQuote,
  type LabelRequest,
} from "./shipments.js";

/**
 * Return labels, whichever carrier a store uses.
 *
 * The store's shipping settings name the carrier; this module does the
 * parts every carrier shares — loading the return, checking the parcel,
 * remembering the chosen service, moving tracking along — and hands the
 * carrier module the calls only it can make.
 */

export { hostedLabelPdf, simulateTracking, testLabelHtml } from "./shipments.js";
export { handleWebhook as handleSendcloudWebhook } from "./sendcloud.service.js";
export { handleWebhook } from "./shiprocket.service.js";
export { handleWebhook as handleEasyPostWebhook } from "./easypost.service.js";
export { handleWebhook as handleShippoWebhook } from "./shippo.service.js";
export { handleEvent as handleExternalEvent } from "./external.service.js";
export type { CourierQuote } from "./shipments.js";

/**
 * The carrier that books this return's labels, with its account loaded:
 * the one its routing rule names, else its regional policy's, else the
 * store's default.
 */
const carrierFor = async (settings: ShippingSettingsRow, policyProvider: ShipmentProvider | null = null, ruleProvider: ShipmentProvider | null = null) => {
  const merchantId = settings.merchantId;
  const provider = ruleProvider ?? policyProvider ?? settings.provider;
  if (!provider) {
    throw unprocessable("Choose a carrier under Settings → Shipping first.");
  }
  if (provider === "EXTERNAL") {
    const account = await external.getAccount(merchantId);
    if (!account) throw unprocessable("Set up the external connector under Settings → Shipping first.");
    return { provider: "EXTERNAL" as const, account };
  }
  if (provider === "SHIPROCKET") {
    const account = await shiprocket.getAccount(merchantId);
    if (!account) throw unprocessable("Connect Shiprocket under Settings → Shipping first.");
    return { provider: "SHIPROCKET" as const, account };
  }
  if (provider === "EASYPOST") {
    const account = await easypost.getAccount(merchantId);
    if (!account) throw unprocessable("Connect EasyPost under Settings → Shipping first.");
    return { provider: "EASYPOST" as const, account };
  }
  if (provider === "SHIPPO") {
    const account = await shippo.getAccount(merchantId);
    if (!account) throw unprocessable("Connect Shippo under Settings → Shipping first.");
    return { provider: "SHIPPO" as const, account };
  }
  if (provider === "SHIPSTATION") {
    const account = await shipstation.getAccount(merchantId);
    if (!account) throw unprocessable("Connect ShipStation under Settings → Shipping first.");
    return { provider: "SHIPSTATION" as const, account };
  }
  if (provider === "SENDCLOUD") {
    const account = await sendcloud.getAccount(merchantId);
    if (!account) throw unprocessable("Connect Sendcloud under Settings → Shipping first.");
    return { provider: "SENDCLOUD" as const, account };
  }
  if (provider === "DHL_EXPRESS") {
    const account = await dhlexpress.getAccount(merchantId);
    if (!account) throw unprocessable("Connect DHL Express under Settings → Shipping first.");
    return { provider: "DHL_EXPRESS" as const, account };
  }
  if (provider === "FEDEX") {
    const account = await fedex.getAccount(merchantId);
    if (!account) throw unprocessable("Connect FedEx under Settings → Shipping first.");
    return { provider: "FEDEX" as const, account };
  }
  if (provider === "AUSPOST") {
    const account = await auspost.getAccount(merchantId);
    if (!account) throw unprocessable("Connect Australia Post under Settings → Shipping first.");
    return { provider: "AUSPOST" as const, account };
  }
  if (provider === "DEUTSCHE_POST") {
    const account = await dhlparcelde.getAccount(merchantId);
    if (!account) throw unprocessable("Connect DHL Paket under Settings → Shipping first.");
    return { provider: "DEUTSCHE_POST" as const, account };
  }
  const account = await delhivery.getAccount(merchantId);
  if (!account) throw unprocessable("Connect Delhivery under Settings → Shipping first.");
  return { provider: "DELHIVERY" as const, account };
};

const labelWanted = (request: LabelRequest) => {
  if (!["SUBMITTED", ...OPEN_FOR_LABEL].includes(request.status)) {
    throw unprocessable("This return is no longer waiting for a parcel.");
  }
  if (request.returnMethod === "KEEP") throw unprocessable("A green return has nothing to ship.");
};

/**
 * The courier services that can collect this return, cheapest first.
 *
 * Runs the same address checks a booking does, so a missing phone number
 * shows here rather than at the moment of booking. Allowed before approval:
 * the merchant may want to see the cost while deciding.
 */
export const quoteCouriers = async (
  merchantId: string,
  returnId: string,
): Promise<{ provider: ShipmentProvider; couriers: CourierQuote[]; shopCurrency: string }> => {
  const settings = await getSettings(merchantId);
  const request = await loadForLabel(merchantId, returnId);
  const carrier = await carrierFor(settings, request.regionalPolicy?.labelProvider ?? null, ruleMethodOf(request)?.carrier ?? null);
  labelWanted(request);
  const parcel = await parcelFor(request, settings, PHONE_RULES[carrier.provider]);
  const toShop = rupeesToShop(request.order);
  /** The store's own figure: rupees through the order's rate, or the rate itself when already in the shop's currency. */
  const withShop = (rate: number | null, currency: string) => {
    if (rate === null) return null;
    if (currency === request.order.currency) return rate;
    if (currency === "INR" && toShop !== null) return Math.round(rate * toShop * 100) / 100;
    return null;
  };

  let couriers: CourierQuote[];
  if (carrier.provider === "EXTERNAL") {
    couriers = external.quote();
  } else if (carrier.provider === "SHIPROCKET") {
    couriers = carrier.account.testMode
      ? TEST_COURIERS.map((c, i) => ({ ...c, shopRate: null, recommended: i === 0 }))
      : await shiprocket.quote(merchantId, parcel);
  } else if (carrier.provider === "EASYPOST") {
    couriers = await easypost.quote(carrier.account, parcel, request.reference);
  } else if (carrier.provider === "SHIPPO") {
    couriers = await shippo.quote(carrier.account, parcel, request.reference);
  } else if (carrier.provider === "SHIPSTATION") {
    couriers = await shipstation.quote(carrier.account, parcel);
  } else if (carrier.provider === "SENDCLOUD") {
    couriers = await sendcloud.quote(carrier.account, parcel);
  } else if (carrier.provider === "DHL_EXPRESS") {
    couriers = await dhlexpress.quote(carrier.account, parcel);
  } else if (carrier.provider === "FEDEX") {
    couriers = await fedex.quote(carrier.account, parcel);
  } else if (carrier.provider === "AUSPOST") {
    couriers = await auspost.quote(carrier.account, parcel);
  } else if (carrier.provider === "DEUTSCHE_POST") {
    couriers = await dhlparcelde.quote(carrier.account, parcel);
  } else {
    couriers = await delhivery.quote(carrier.account, parcel);
  }
  return {
    provider: carrier.provider,
    shopCurrency: request.order.currency,
    couriers: couriers
      .map((c) => ({ ...c, currency: c.currency ?? "INR", shopRate: withShop(c.rate, c.currency ?? "INR") }))
      .sort(byRate),
  };
};

/**
 * Makes the label with the store's carrier.
 *
 * Booked once: a shipment that already has a label is left alone, and one
 * whose courier failed or was cancelled starts over under a fresh reference.
 * `email` is off when the approval mail is about to go out anyway and will
 * carry the label itself; `courierId` is the merchant's pick from the quote,
 * remembered so a retry books the same one.
 */
export const createReturnLabel = async (
  merchantId: string,
  returnId: string,
  actorId: string | null,
  options: { email?: boolean; courierId?: number | null } = {},
): Promise<ReturnShipment> => {
  const settings = await getSettings(merchantId);
  const request = await loadForLabel(merchantId, returnId);
  const method = ruleMethodOf(request);
  const carrier = await carrierFor(settings, request.regionalPolicy?.labelProvider ?? null, method?.carrier ?? null);
  const { existing, orderId } = bookable(request);
  const email = options.email !== false;
  let courierId = options.courierId ?? existing?.courierId ?? null;
  // The rule's named service, when nobody chose one: matched against what's offered, else the cheapest.
  if (courierId === null && method?.serviceName?.trim()) {
    try {
      const wanted = method.serviceName.trim().toLowerCase();
      const { couriers } = await quoteCouriers(merchantId, returnId);
      courierId = couriers.find((c) => c.name.toLowerCase() === wanted)?.courierId ?? couriers.find((c) => c.name.toLowerCase().includes(wanted))?.courierId ?? null;
    } catch (error) {
      logger.warn({ merchantId, returnId, err: error }, "Couldn't match the rule's shipping service; booking the carrier's pick");
    }
  }

  let parcel;
  try {
    parcel = await parcelFor(request, settings, PHONE_RULES[carrier.provider]);
  } catch (error) {
    return failStep(carrier.provider, returnId, actorId, "checking addresses", error);
  }

  if (carrier.provider === "EXTERNAL") {
    return external.book(request, carrier.account, parcel, orderId, actorId, { email });
  }
  if (carrier.provider === "SHIPROCKET") {
    // Test mode books a pretend pickup: the same checks, nothing sent.
    if (carrier.account.testMode) {
      return bookTestLabel("SHIPROCKET", request, orderId, actorId, { email, courierId });
    }
    return shiprocket.book(merchantId, request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "EASYPOST") {
    return easypost.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "SHIPPO") {
    return shippo.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "SHIPSTATION") {
    return shipstation.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "SENDCLOUD") {
    return sendcloud.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "DHL_EXPRESS") {
    return dhlexpress.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "FEDEX") {
    return fedex.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "AUSPOST") {
    return auspost.book(request, carrier.account, parcel, orderId, actorId, { email, courierId });
  }
  if (carrier.provider === "DEUTSCHE_POST") {
    return dhlparcelde.book(request, carrier.account, parcel, orderId, actorId, { email });
  }
  return delhivery.book(request, carrier.account, parcel, orderId, actorId, { email });
};

/**
 * At approval: make the label when the shopper asked for one and the store
 * makes them automatically. Never throws — the approval has already
 * happened, and the failure is on the timeline for the merchant to retry.
 */
export const createLabelOnApproval = async (
  merchantId: string,
  returnId: string,
  actorId: string | null,
  /**
   * From the approval dialog: `book` says outright whether to book (and
   * overrides the store's automatic setting either way), `courierId` which
   * service. Absent, the store's setting decides and the carrier picks.
   */
  choice: { book?: boolean; courierId?: number | null } = {},
): Promise<void> => {
  try {
    if (choice.book === false) return;
    const settings = await getSettings(merchantId);
    const request = await prisma.returnRequest.findFirst({
      where: { id: returnId, merchantId },
      select: {
        returnMethod: true,
        shipment: { select: { labelUrl: true } },
        regionalPolicy: { select: { generateLabels: true, labelProvider: true } },
        routingRule: { select: { methods: { where: { kind: "LABEL" }, select: { carrier: true } } } },
      },
    });
    if (!(request?.routingRule?.methods[0]?.carrier ?? request?.regionalPolicy?.labelProvider ?? settings.provider)) return;
    // The region's own switch first, then the store's.
    const automatic = request?.regionalPolicy ? request.regionalPolicy.generateLabels : settings.autoCreate;
    if (!automatic && choice.book !== true) return;
    if (request?.shipment?.labelUrl) return;
    if (request?.returnMethod !== "LABEL" && choice.book !== true) return;
    await createReturnLabel(merchantId, returnId, actorId, { email: false, courierId: choice.courierId ?? null });
  } catch (error) {
    logger.warn({ merchantId, returnId, err: error }, "Automatic return label failed");
  }
};

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Asks the carrier about one parcel and applies the answer. */
export const refreshTracking = async (merchantId: string, returnId: string): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
    include: trackedInclude,
  });
  if (!shipment?.provider) throw notFound("This return has no booked shipment.");
  if (shipment.provider === "EXTERNAL") {
    // Nothing to ask: the connector posts what it knows.
    return prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date() } });
  }
  if (shipment.provider === "SHIPROCKET" && shipment.isTest) {
    // Nothing to ask: a pretend parcel moves only when simulated from the return.
    return prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date() } });
  }
  if (shipment.provider === "SHIPROCKET") {
    await shiprocket.refresh(merchantId, shipment);
  } else if (shipment.provider === "EASYPOST") {
    const account = await easypost.getAccount(merchantId);
    if (!account) throw unprocessable("EasyPost is no longer connected, so this parcel can't be tracked.");
    await easypost.refresh(account, shipment);
  } else if (shipment.provider === "SHIPPO") {
    const account = await shippo.getAccount(merchantId);
    if (!account) throw unprocessable("Shippo is no longer connected, so this parcel can't be tracked.");
    await shippo.refresh(account, shipment);
  } else if (shipment.provider === "SHIPSTATION") {
    // ShipStation has no tracking API: the carrier's own page is the only word.
    return prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date() } });
  } else if (shipment.provider === "SENDCLOUD") {
    const account = await sendcloud.getAccount(merchantId);
    if (!account) throw unprocessable("Sendcloud is no longer connected, so this parcel can't be tracked.");
    if (shipment.isTest) return prisma.returnShipment.update({ where: { id: shipment.id }, data: { lastTrackedAt: new Date() } });
    await sendcloud.refresh(account, shipment);
  } else if (shipment.provider === "DHL_EXPRESS") {
    const account = await dhlexpress.getAccount(merchantId);
    if (!account) throw unprocessable("DHL Express is no longer connected, so this parcel can't be tracked.");
    await dhlexpress.refresh(account, shipment);
  } else if (shipment.provider === "FEDEX") {
    const account = await fedex.getAccount(merchantId);
    if (!account) throw unprocessable("FedEx is no longer connected, so this parcel can't be tracked.");
    await fedex.refresh(account, shipment);
  } else if (shipment.provider === "AUSPOST") {
    const account = await auspost.getAccount(merchantId);
    if (!account) throw unprocessable("Australia Post is no longer connected, so this parcel can't be tracked.");
    await auspost.refresh(account, shipment);
  } else if (shipment.provider === "DEUTSCHE_POST") {
    const account = await dhlparcelde.getAccount(merchantId);
    if (!account) throw unprocessable("DHL Paket is no longer connected, so this parcel can't be tracked.");
    await dhlparcelde.refresh(account, shipment);
  } else {
    const account = await delhivery.getAccount(merchantId);
    if (!account) throw unprocessable("Delhivery is no longer connected, so this parcel can't be tracked.");
    await delhivery.refresh(account, shipment);
  }
  return prisma.returnShipment.findUniqueOrThrow({ where: { id: shipment.id } });
};

/** How long a parcel is left alone between polls. */
const POLL_AFTER_MS = 20 * 60 * 1000;

/**
 * One pass over every open real parcel, for stores without a webhook. Each
 * is asked about on its own, so one refusal doesn't stall the rest.
 */
export const runTrackingSweep = async (): Promise<{ checked: number; failed: number }> => {
  const due = await prisma.returnShipment.findMany({
    where: {
      provider: { not: null },
      isTest: false,
      status: { in: ["PENDING", "LABEL_CREATED", "IN_TRANSIT"] },
      externalShipmentId: { not: null },
      returnRequest: { status: { in: ["APPROVED", "IN_TRANSIT"] } },
      OR: [{ lastTrackedAt: null }, { lastTrackedAt: { lt: new Date(Date.now() - POLL_AFTER_MS) } }],
    },
    include: trackedInclude,
    take: 200,
  });
  let failed = 0;
  for (const shipment of due) {
    try {
      await refreshTracking(shipment.returnRequest.merchantId, shipment.returnRequestId);
    } catch (error) {
      failed++;
      logger.warn({ shipmentId: shipment.id, err: error }, "Tracking poll failed");
    }
  }
  return { checked: due.length, failed };
};

export const runTrackingSweepSafely = async (): Promise<void> => {
  try {
    const result = await runTrackingSweep();
    if (result.checked > 0) logger.info(result, "Tracking sweep done");
  } catch (error) {
    logger.error({ err: error }, "Tracking sweep failed");
  }
  try {
    const result = await runAutoCancel();
    if (result.cancelled > 0) logger.info(result, "Auto-cancel done");
  } catch (error) {
    logger.error({ err: error }, "Auto-cancel failed");
  }
};

/**
 * AfterShip's "Auto-cancel return labels": a label with no shipping update
 * this many days after approval is voided and the return expires. Runs
 * with the tracking sweep, one store at a time.
 */
export const runAutoCancel = async (): Promise<{ cancelled: number; failed: number }> => {
  const stores = await prisma.shippingSettings.findMany({
    where: { autoCancelDays: { not: null } },
    select: { merchantId: true, autoCancelDays: true },
  });
  let cancelled = 0;
  let failed = 0;
  for (const store of stores) {
    const days = store.autoCancelDays!;
    const due = await prisma.returnShipment.findMany({
      where: {
        provider: { not: null },
        status: { in: ["PENDING", "LABEL_CREATED"] },
        shippedAt: null,
        returnRequest: { merchantId: store.merchantId, status: "APPROVED", reviewedAt: { lte: new Date(Date.now() - days * 86_400_000) } },
      },
      select: { returnRequestId: true },
      take: 100,
    });
    for (const { returnRequestId } of due) {
      try {
        await cancelLabel(store.merchantId, returnRequestId, null);
        await changeStatus({
          merchantId: store.merchantId,
          id: returnRequestId,
          to: "EXPIRED",
          message: `Closed automatically — the return label had no shipping update ${days} days after approval, so it was cancelled`,
        });
        await notify(returnRequestId, "EXPIRED");
        annotateOrdersInBackground(store.merchantId, returnRequestId, "EXPIRED");
        cancelled++;
      } catch (error) {
        failed++;
        logger.warn({ merchantId: store.merchantId, returnId: returnRequestId, err: error }, "Auto-cancel failed for a return");
      }
    }
  }
  return { cancelled, failed };
};

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Calls the courier off. A refusal from the carrier is recorded rather than
 * thrown, since the merchant can finish the job in the carrier's panel.
 */
export const cancelLabel = async (
  merchantId: string,
  returnId: string,
  actorId: string | null,
): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
  });
  if (!shipment?.provider) throw notFound("This return has no booked shipment.");
  if (["DELIVERED", "CANCELLED"].includes(shipment.status)) {
    throw unprocessable("That parcel can't be cancelled any more.");
  }
  let problems: string[] = [];
  if (shipment.provider === "EXTERNAL") {
    const account = await external.getAccount(merchantId);
    problems = account ? await external.cancelCalls(account, shipment) : [];
  } else if (shipment.provider === "SHIPROCKET") {
    // A pretend booking exists nowhere but here.
    if (!shipment.isTest) problems = await shiprocket.cancelCalls(merchantId, shipment);
  } else if (shipment.provider === "EASYPOST") {
    const account = await easypost.getAccount(merchantId);
    problems = account ? await easypost.cancelCalls(account, shipment) : ["EasyPost is no longer connected."];
  } else if (shipment.provider === "SHIPPO") {
    const account = await shippo.getAccount(merchantId);
    problems = account ? await shippo.cancelCalls(account, shipment) : ["Shippo is no longer connected."];
  } else if (shipment.provider === "SHIPSTATION") {
    const account = await shipstation.getAccount(merchantId);
    problems = account ? await shipstation.cancelCalls(account, shipment) : ["ShipStation is no longer connected."];
  } else if (shipment.provider === "SENDCLOUD") {
    const account = await sendcloud.getAccount(merchantId);
    problems = account ? await sendcloud.cancelCalls(account, shipment) : ["Sendcloud is no longer connected."];
  } else if (shipment.provider === "DHL_EXPRESS") {
    const account = await dhlexpress.getAccount(merchantId);
    problems = account ? await dhlexpress.cancelCalls(account, shipment) : [];
  } else if (shipment.provider === "FEDEX") {
    const account = await fedex.getAccount(merchantId);
    problems = account ? await fedex.cancelCalls(account, shipment) : ["FedEx is no longer connected."];
  } else if (shipment.provider === "AUSPOST") {
    const account = await auspost.getAccount(merchantId);
    problems = account ? await auspost.cancelCalls(account, shipment) : ["Australia Post is no longer connected."];
  } else if (shipment.provider === "DEUTSCHE_POST") {
    const account = await dhlparcelde.getAccount(merchantId);
    problems = account ? await dhlparcelde.cancelCalls(account, shipment) : ["DHL Paket is no longer connected."];
  } else {
    const account = await delhivery.getAccount(merchantId);
    problems = account ? await delhivery.cancelCalls(account, shipment) : ["Delhivery is no longer connected."];
  }
  const updated = await prisma.returnShipment.update({
    where: { id: shipment.id },
    data: { status: "CANCELLED", lastError: problems.length ? `cancelling: ${problems.join("; ")}` : null },
  });
  await event(
    returnId,
    actorId,
    "LABEL_GENERATED",
    problems.length
      ? `Return label cancelled here; ${PROVIDER_NAMES[shipment.provider]} said: ${problems.join("; ")}`
      : `Return label cancelled${shipment.trackingNumber ? ` (AWB ${shipment.trackingNumber})` : ""}`,
    { ok: problems.length === 0, cancelled: true, provider: shipment.provider },
  );
  return updated;
};

/** When a return is cancelled, its parcel is too. Never throws. */
export const cancelLabelQuietly = async (merchantId: string, returnId: string, actorId: string | null) => {
  try {
    const shipment = await prisma.returnShipment.findFirst({
      where: { returnRequestId: returnId, provider: { not: null }, status: { in: ["PENDING", "LABEL_CREATED", "IN_TRANSIT"] } },
      select: { id: true },
    });
    if (shipment) await cancelLabel(merchantId, returnId, actorId);
  } catch (error) {
    logger.warn({ merchantId, returnId, err: error }, "Couldn't cancel the return's parcel");
  }
};
