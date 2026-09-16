import type { ReturnShipment, ShipmentProvider } from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import * as delhivery from "./delhivery.service.js";
import * as easypost from "./easypost.service.js";
import * as shiprocket from "./shiprocket.service.js";
import { getSettings, type ShippingSettingsRow } from "./shipping.settings.js";
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

export { simulateTracking, testLabelHtml } from "./shipments.js";
export { handleWebhook } from "./shiprocket.service.js";
export { handleWebhook as handleEasyPostWebhook } from "./easypost.service.js";
export type { CourierQuote } from "./shipments.js";

/** The carrier that books this store's labels, with its account loaded. */
const carrierFor = async (settings: ShippingSettingsRow) => {
  const merchantId = settings.merchantId;
  if (!settings.provider) {
    throw unprocessable("Choose a carrier under Settings → Shipping first.");
  }
  if (settings.provider === "SHIPROCKET") {
    const account = await shiprocket.getAccount(merchantId);
    if (!account) throw unprocessable("Connect Shiprocket under Settings → Shipping first.");
    return { provider: "SHIPROCKET" as const, account };
  }
  if (settings.provider === "EASYPOST") {
    const account = await easypost.getAccount(merchantId);
    if (!account) throw unprocessable("Connect EasyPost under Settings → Shipping first.");
    return { provider: "EASYPOST" as const, account };
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
  const carrier = await carrierFor(settings);
  const request = await loadForLabel(merchantId, returnId);
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
  if (carrier.provider === "SHIPROCKET") {
    couriers = carrier.account.testMode
      ? TEST_COURIERS.map((c, i) => ({ ...c, shopRate: null, recommended: i === 0 }))
      : await shiprocket.quote(merchantId, parcel);
  } else if (carrier.provider === "EASYPOST") {
    couriers = await easypost.quote(carrier.account, parcel, request.reference);
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
  const carrier = await carrierFor(settings);
  const request = await loadForLabel(merchantId, returnId);
  const { existing, orderId } = bookable(request);
  const email = options.email !== false;
  const courierId = options.courierId ?? existing?.courierId ?? null;

  let parcel;
  try {
    parcel = await parcelFor(request, settings, PHONE_RULES[carrier.provider]);
  } catch (error) {
    return failStep(carrier.provider, returnId, actorId, "checking addresses", error);
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
    if (!settings.provider) return;
    if (!settings.autoCreate && choice.book !== true) return;
    const request = await prisma.returnRequest.findFirst({
      where: { id: returnId, merchantId },
      select: { returnMethod: true, shipment: { select: { labelUrl: true } } },
    });
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
  if (shipment.provider === "SHIPROCKET") {
    // A pretend booking exists nowhere but here.
    if (!shipment.isTest) problems = await shiprocket.cancelCalls(merchantId, shipment);
  } else if (shipment.provider === "EASYPOST") {
    const account = await easypost.getAccount(merchantId);
    problems = account ? await easypost.cancelCalls(account, shipment) : ["EasyPost is no longer connected."];
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
