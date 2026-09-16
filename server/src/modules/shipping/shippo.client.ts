import { env } from "../../config/env.js";
import { CarrierError } from "./shipments.js";

/**
 * The thinnest useful wrapper over Shippo's API.
 *
 * One token is the account, sent as `ShippoToken …`. A test token
 * (shippo_test_…) makes the same calls against test labels — that carrier's
 * test mode. Shippo takes centimetres and kilograms as they are.
 */

const TIMEOUT_MS = 20_000;

export interface Env {
  token: string;
}

const base = () => env.SHIPPO_API_URL.replace(/\/+$/, "");

/** Shippo's errors come as `{ detail }`, `{ __all__: [...] }`, or per field. */
const messageOf = (body: unknown, fallback: string): string => {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.detail === "string" && b.detail.trim()) return b.detail.trim();
    const parts = Object.entries(b)
      .map(([k, v]) => {
        const text = Array.isArray(v) ? v.map(String).join(" ") : typeof v === "string" ? v : "";
        return text ? (k === "__all__" ? text : `${k}: ${text}`) : "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ").slice(0, 300);
  }
  return fallback;
};

const request = async <T>(e: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        authorization: `ShippoToken ${e.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError" ? "Shippo didn't answer in time." : "Couldn't reach Shippo.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw new CarrierError("Shippo rejected the API token. Check it under Settings → Shipping.", res.status, parsed);
  }
  if (!res.ok) throw new CarrierError(messageOf(parsed, `Shippo returned ${res.status}.`), res.status, parsed);
  return parsed as T;
};

// ---------------------------------------------------------------------------
// The calls a return label needs
// ---------------------------------------------------------------------------

/** Proves a token works: the cheapest authenticated read there is. */
export const probe = (e: Env) => request<unknown>(e, "GET", "/addresses?results=1");

export interface AddressInput {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface Rate {
  object_id: string;
  provider: string;
  servicelevel?: { name?: string; token?: string } | null;
  amount: string;
  currency: string;
  estimated_days?: number | null;
  duration_terms?: string | null;
}

export interface Shipment {
  object_id: string;
  status?: string;
  test?: boolean;
  rates?: Rate[];
  messages?: Array<{ source?: string; code?: string; text?: string }>;
}

/** Makes the shipment and, with it, every rate the account's carriers offer. */
export const createShipment = (
  e: Env,
  input: { to: AddressInput; from: AddressInput; parcel: { length: number; width: number; height: number; weight: number }; reference: string },
) =>
  request<Shipment>(e, "POST", "/shipments", {
    address_from: input.from,
    address_to: input.to,
    parcels: [{ ...input.parcel, distance_unit: "cm", mass_unit: "kg" }],
    // A return: the shopper posts it, the store receives it.
    extra: { is_return: true, reference_1: input.reference },
    metadata: input.reference,
    async: false,
  });

export interface Transaction {
  object_id: string;
  status?: "SUCCESS" | "ERROR" | "QUEUED" | "WAITING" | string;
  test?: boolean;
  label_url?: string | null;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  tracking_status?: string | null;
  eta?: string | null;
  messages?: Array<{ source?: string; code?: string; text?: string }>;
  rate?: Rate | string | null;
}

/** Buys a rate; the label and tracking number come back with it. */
export const buyRate = (e: Env, rateId: string) =>
  request<Transaction>(e, "POST", "/transactions", { rate: rateId, label_file_type: "PDF", async: false });

export const getTransaction = (e: Env, id: string) =>
  request<Transaction>(e, "GET", `/transactions/${encodeURIComponent(id)}`);

export interface Track {
  tracking_number?: string;
  carrier?: string;
  eta?: string | null;
  tracking_status?: TrackStatus | null;
  tracking_history?: TrackStatus[];
}

export interface TrackStatus {
  status?: string;
  status_details?: string | null;
  status_date?: string | null;
  location?: { city?: string | null; state?: string | null; country?: string | null } | null;
}

/** The carrier's own scans, by Shippo's carrier token and the tracking number. */
export const track = (e: Env, carrier: string, trackingNumber: string) =>
  request<Track>(e, "GET", `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`);

/** Asks for the postage back; the label stops working once the carrier agrees. */
export const refund = (e: Env, transactionId: string) =>
  request<{ status?: string }>(e, "POST", "/refunds", { transaction: transactionId, async: false });
