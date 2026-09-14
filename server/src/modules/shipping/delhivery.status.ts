import type { Outcome, Scan } from "./shiprocket.status.js";

/**
 * What Delhivery's shipment statuses mean for a return coming back.
 *
 * Delhivery reports a status line ("In Transit") and a type ("UD"); the
 * line is the more precise of the two and is read first. Pure, so the
 * mapping can be tested without a courier.
 */

const BY_TYPE: Record<string, Outcome> = {
  PP: "WAITING", // pending pickup
  PU: "IN_TRANSIT", // picked up
  UD: "IN_TRANSIT", // undelivered so far — in transit
  DL: "DELIVERED",
  RT: "FAILED", // return to origin: went back to the shopper
  CN: "CANCELLED",
  CL: "CANCELLED",
};

export const delhiveryOutcome = (status: string | null | undefined, type: string | null | undefined): Outcome => {
  const text = (status ?? "").toUpperCase();
  if (text) {
    if (/\bRTO\b|RETURN(ED)? TO ORIGIN|\bLOST\b|\bDAMAGED\b/.test(text)) return "FAILED";
    if (/\bDELIVERED\b/.test(text)) return "DELIVERED";
    if (/\bCANCEL/.test(text)) return "CANCELLED";
    if (/IN TRANSIT|DISPATCHED|PICKED|OUT FOR DELIVERY|REACHED|\bPENDING\b/.test(text)) return "IN_TRANSIT";
    if (/MANIFEST|NOT PICKED|\bOPEN\b|SCHEDULED/.test(text)) return "WAITING";
  }
  const byType = BY_TYPE[(type ?? "").toUpperCase()];
  return byType ?? "UNKNOWN";
};

/** Delhivery's scans, in the shape the app stores, latest first. */
export const delhiveryScans = (
  scans: Array<{ ScanDetail?: { Scan?: string; ScanDateTime?: string; ScannedLocation?: string; Instructions?: string; StatusCode?: string } }> | undefined,
): Scan[] =>
  (scans ?? [])
    .flatMap((s): Scan[] => {
      const d = s.ScanDetail;
      if (!d) return [];
      return [
        {
          date: (d.ScanDateTime ?? "").replace("T", " ").slice(0, 19),
          activity: [d.Scan, d.Instructions].filter(Boolean).join(" — "),
          location: d.ScannedLocation ?? "",
          status: d.Scan ?? d.StatusCode ?? "",
        },
      ];
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
