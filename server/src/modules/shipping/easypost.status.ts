import type { Tracker } from "./easypost.client.js";
import type { Outcome, Scan } from "./shiprocket.status.js";

/**
 * EasyPost's tracker statuses, read into the app's own idea of where a
 * parcel is. The names are EasyPost's, shared by every carrier it fronts.
 */
export const easypostOutcome = (status: string | null | undefined): Outcome => {
  switch ((status ?? "").toLowerCase()) {
    case "pre_transit":
      return "WAITING";
    case "in_transit":
    case "out_for_delivery":
    case "available_for_pickup":
      return "IN_TRANSIT";
    case "delivered":
      return "DELIVERED";
    case "cancelled":
      return "CANCELLED";
    case "return_to_sender":
    case "failure":
    case "error":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
};

/** "out_for_delivery" → "Out for delivery". */
export const easypostLabel = (status: string | null | undefined): string | null => {
  if (!status) return null;
  const words = status.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
};

/** The tracker's events as the app's scans, newest first. */
export const easypostScans = (tracker: Tracker | null | undefined): Scan[] =>
  (tracker?.tracking_details ?? [])
    .map((d) => ({
      date: d.datetime ?? "",
      activity: d.message ?? easypostLabel(d.status) ?? "",
      location: [d.tracking_location?.city, d.tracking_location?.state].filter(Boolean).join(", "),
      status: easypostLabel(d.status) ?? "",
    }))
    .filter((s) => s.date || s.activity)
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
