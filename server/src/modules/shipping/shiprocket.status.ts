import type { ShipmentStatus } from "@prisma/client";

/**
 * What Shiprocket's shipment statuses mean for a return coming back.
 *
 * Shiprocket names ~80 states; the parcel we care about is a reverse pickup,
 * so they collapse to a few of ours. Matched on the numeric status first —
 * the labels vary in case and spelling between the tracking API and the
 * webhook — with the label as a fallback for events that carry no number.
 * Pure, so the mapping can be tested without a courier.
 */

/** A scan as Shiprocket reports it, normalised. */
export interface Scan {
  date: string;
  activity: string;
  location: string;
  status: string;
}

export type Outcome =
  | "WAITING" // made, not collected yet — pickup scheduled, exception, rescheduled
  | "IN_TRANSIT" // collected and on its way to the destination
  | "DELIVERED"
  | "CANCELLED"
  | "FAILED" // lost, damaged, destroyed, or went back to the shopper
  | "UNKNOWN";

const BY_ID: Record<number, Outcome> = {
  1: "WAITING", // NEW
  2: "WAITING", // INVOICED
  3: "WAITING", // READY TO SHIP
  4: "WAITING", // PICKUP SCHEDULED
  5: "WAITING", // MANIFEST GENERATED
  6: "IN_TRANSIT", // SHIPPED
  7: "DELIVERED",
  8: "CANCELLED",
  9: "FAILED", // RTO INITIATED — going back to the shopper
  10: "FAILED", // RTO DELIVERED
  11: "WAITING", // PENDING
  12: "FAILED", // LOST
  13: "WAITING", // PICKUP ERROR
  14: "FAILED", // RTO ACKNOWLEDGED
  15: "WAITING", // PICKUP RESCHEDULED
  16: "CANCELLED", // CANCELLATION REQUESTED
  17: "IN_TRANSIT", // OUT FOR DELIVERY
  18: "IN_TRANSIT",
  19: "WAITING", // OUT FOR PICKUP
  20: "WAITING", // PICKUP EXCEPTION
  21: "IN_TRANSIT", // UNDELIVERED — still with the courier
  22: "IN_TRANSIT", // DELAYED
  23: "DELIVERED", // PARTIAL DELIVERED
  24: "FAILED", // DESTROYED
  25: "FAILED", // DAMAGED
  26: "DELIVERED", // FULFILLED
  27: "WAITING", // PICKUP BOOKED
  38: "IN_TRANSIT", // REACHED AT DESTINATION HUB
  39: "IN_TRANSIT", // MISROUTED
  40: "FAILED", // RTO NDR
  41: "FAILED", // RTO OFD
  42: "IN_TRANSIT", // PICKED UP
  43: "DELIVERED", // SELF FULFILLED
  44: "FAILED", // DISPOSED OFF
  45: "CANCELLED", // CANCELLED BEFORE DISPATCHED
  46: "FAILED", // RTO IN TRANSIT
  47: "WAITING", // QC FAILED — courier refused the pickup
  48: "DELIVERED", // REACHED WAREHOUSE
  76: "IN_TRANSIT", // UNTRACEABLE
  77: "IN_TRANSIT", // ISSUE RELATED TO THE RECIPIENT
  78: "FAILED", // REACHED BACK AT SELLER CITY
};

const BY_LABEL: Array<[RegExp, Outcome]> = [
  [/\bDELIVERED\b/, "DELIVERED"],
  [/\bCANCEL/, "CANCELLED"],
  [/\bRTO\b|\bLOST\b|\bDAMAGED\b|\bDESTROYED\b|\bDISPOSED\b/, "FAILED"],
  [/\bPICKED ?UP\b|\bIN.?TRANSIT\b|\bSHIPPED\b|\bOUT FOR DELIVERY\b|\bDELAYED\b|\bMISROUTED\b|\bDESTINATION HUB\b|\bUNDELIVERED\b/, "IN_TRANSIT"],
  [/\bPICKUP\b|\bMANIFEST\b|\bREADY TO SHIP\b|\bNEW\b|\bPENDING\b|\bQC FAILED\b/, "WAITING"],
];

/** Where a Shiprocket status leaves the parcel. */
export const outcomeOf = (statusId: number | null | undefined, label: string | null | undefined): Outcome => {
  if (typeof statusId === "number" && BY_ID[statusId]) return BY_ID[statusId];
  const text = (label ?? "").toUpperCase().replace(/_/g, " ");
  // "RTO DELIVERED" must read as a failure, not a delivery: the parcel went
  // back to the shopper. Checked before the plain "delivered" match.
  if (/\bRTO\b/.test(text)) return "FAILED";
  for (const [pattern, outcome] of BY_LABEL) {
    if (pattern.test(text)) return outcome;
  }
  return "UNKNOWN";
};

/** Our status for a parcel in that state; null leaves it as it was. */
export const shipmentStatusFor = (outcome: Outcome): ShipmentStatus | null => {
  switch (outcome) {
    case "WAITING":
      return "LABEL_CREATED";
    case "IN_TRANSIT":
      return "IN_TRANSIT";
    case "DELIVERED":
      return "DELIVERED";
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
      return "FAILED";
    default:
      return null;
  }
};

/**
 * Shiprocket's timestamps come in two shapes: "2023-05-23 11:43:52" from
 * scans and tracking, and "23 05 2023 11:43:52" on the webhook's own clock.
 * Both are Indian time. Returns null rather than an Invalid Date.
 */
export const parseShiprocketDate = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  let text = value.trim();
  const dmy = /^(\d{2}) (\d{2}) (\d{4})(?: (\d{2}:\d{2}:\d{2}))?$/.exec(text);
  if (dmy) text = `${dmy[3]}-${dmy[2]}-${dmy[1]}${dmy[4] ? ` ${dmy[4]}` : ""}`;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/.exec(text);
  if (!iso) return null;
  const date = new Date(`${iso[1]}T${iso[2] ?? "00:00:00"}+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** The scan list as stored: latest first, one shape whichever API sent it. */
export const normaliseScans = (value: unknown): Scan[] => {
  if (!Array.isArray(value)) return [];
  const scans = value.flatMap((raw): Scan[] => {
    if (!raw || typeof raw !== "object") return [];
    const s = raw as Record<string, unknown>;
    const str = (key: string) => (typeof s[key] === "string" ? (s[key] as string) : "");
    return [
      {
        date: str("date"),
        activity: str("activity"),
        location: str("location"),
        status: str("sr-status-label") || str("status"),
      },
    ];
  });
  return scans.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
};

/** A plain-English status for the shopper and the merchant: "Picked up". */
export const describeStatus = (label: string | null | undefined): string | null => {
  if (!label) return null;
  const words = label.replace(/_/g, " ").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
};
