import { env } from "../../config/env.js";
import { CarrierError } from "./shipments.js";

/**
 * The thinnest useful wrapper over EasyPost's API.
 *
 * One key, sent as HTTP basic auth, is the whole of the account. A test key
 * (EZTK…) buys test labels against the same endpoints — that is EasyPost's
 * test mode, and this app's for that carrier.
 */

const TIMEOUT_MS = 20_000;

export interface Env {
  apiKey: string;
}

const base = () => env.EASYPOST_API_URL.replace(/\/+$/, "");

/** EasyPost's error body: `{ error: { code, message, errors: [{ field, message }] } }`. */
const messageOf = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: { message?: unknown; errors?: unknown } }).error;
    const details = Array.isArray(e?.errors)
      ? e!.errors
          .map((d) => (d && typeof d === "object" ? [d.field, d.message].filter(Boolean).join(": ") : String(d)))
          .filter(Boolean)
          .join("; ")
      : "";
    if (typeof e?.message === "string" && e.message.trim()) {
      return details ? `${e.message.trim()} (${details})` : e.message.trim();
    }
    if (details) return details;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
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
        authorization: `Basic ${Buffer.from(`${e.apiKey}:`).toString("base64")}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError" ? "EasyPost didn't answer in time." : "Couldn't reach EasyPost.",
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
    throw new CarrierError(
      "EasyPost rejected the API key. Check it under Settings → Shipping; a test key only works while the account is in test mode.",
      res.status,
      parsed,
    );
  }
  if (!res.ok) {
    throw new CarrierError(messageOf(parsed, `EasyPost returned ${res.status}.`), res.status, parsed);
  }
  return parsed as T;
};

// ---------------------------------------------------------------------------
// The calls a return label needs
// ---------------------------------------------------------------------------

/** Proves a key works: the cheapest authenticated read there is. */
export const probe = (e: Env) => request<unknown>(e, "GET", "/addresses?page_size=1");

export interface AddressInput {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

/** Inches and ounces, as EasyPost wants them. */
export interface ParcelInput {
  length: number;
  width: number;
  height: number;
  weight: number;
}

export interface Rate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  delivery_date?: string | null;
  delivery_date_guaranteed?: boolean;
}

export interface Tracker {
  id?: string;
  tracking_code?: string;
  status?: string;
  status_detail?: string;
  public_url?: string;
  est_delivery_date?: string | null;
  tracking_details?: Array<{
    datetime?: string;
    message?: string;
    status?: string;
    status_detail?: string;
    tracking_location?: { city?: string | null; state?: string | null; country?: string | null } | null;
  }>;
}

export interface Shipment {
  id: string;
  mode?: "test" | "production";
  reference?: string | null;
  rates?: Rate[];
  messages?: Array<{ carrier?: string; type?: string; message?: string }>;
  postage_label?: { label_url?: string; label_pdf_url?: string } | null;
  tracking_code?: string | null;
  tracker?: Tracker | null;
  selected_rate?: Rate | null;
  refund_status?: string | null;
}

/** Makes the shipment and, with it, the rates every carrier on the account offers. */
export const createShipment = (
  e: Env,
  input: { to: AddressInput; from: AddressInput; parcel: ParcelInput; reference: string; references?: string[] },
) =>
  request<Shipment>(e, "POST", "/shipments", {
    shipment: {
      to_address: input.to,
      from_address: input.from,
      parcel: input.parcel,
      // A return: the shopper posts it, the store receives it.
      is_return: true,
      reference: input.reference,
      options: {
        label_format: "PDF",
        label_size: "4x6",
        // The store's label references, in the three lines EasyPost prints.
        ...Object.fromEntries((input.references ?? []).slice(0, 3).map((text, i) => [`print_custom_${i + 1}`, text])),
      },
    },
  });

/** Buys the chosen rate; the label and tracking come back with it. */
export const buyShipment = (e: Env, shipmentId: string, rateId: string) =>
  request<Shipment>(e, "POST", `/shipments/${encodeURIComponent(shipmentId)}/buy`, { rate: { id: rateId } });

export const getShipment = (e: Env, shipmentId: string) =>
  request<Shipment>(e, "GET", `/shipments/${encodeURIComponent(shipmentId)}`);

/** Asks for the postage back; the label stops working once the carrier agrees. */
export const refundShipment = (e: Env, shipmentId: string) =>
  request<Shipment>(e, "POST", `/shipments/${encodeURIComponent(shipmentId)}/refund`);
