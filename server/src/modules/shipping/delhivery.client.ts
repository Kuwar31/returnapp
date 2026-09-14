import { env } from "../../config/env.js";
import { CarrierError } from "./shipments.js";

/**
 * The thinnest useful wrapper over Delhivery's API.
 *
 * Every call carries the account's token as `Authorization: Token …`.
 * Staging and production are the same API at different hosts; the account
 * says which, and a staging booking is a real call that charges nothing.
 */

const TIMEOUT_MS = 20_000;

export interface Env {
  token: string;
  staging: boolean;
}

const baseOf = (e: Env) => (e.staging ? env.DELHIVERY_STAGING_URL : env.DELHIVERY_API_URL).replace(/\/+$/, "");

/** Delhivery's error bodies vary: `rmk`, `error`, `message`, `detail`, or a package's remarks. */
const messageOf = (body: unknown, fallback: string): string => {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["rmk", "error", "message", "detail", "Error"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length && typeof v[0] === "string") return v.join(" ");
    }
  }
  return fallback;
};

const request = async <T>(
  e: Env,
  method: "GET" | "POST",
  path: string,
  body?: { json: unknown } | { text: string },
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseOf(e)}${path}`, {
      method,
      headers: {
        authorization: `Token ${e.token}`,
        accept: "application/json",
        // Delhivery documents `format=json&data=…` bodies under a JSON content type.
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : "json" in body ? JSON.stringify(body.json) : body.text,
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError"
        ? "Delhivery didn't answer in time."
        : "Couldn't reach Delhivery.",
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
      "Delhivery rejected the API token. Check it under Settings → Shipping, and that it belongs to the environment chosen there.",
      res.status,
      parsed,
    );
  }
  if (!res.ok) {
    throw new CarrierError(messageOf(parsed, `Delhivery returned ${res.status}.`), res.status, parsed);
  }
  return parsed as T;
};

// ---------------------------------------------------------------------------
// The calls a return label needs
// ---------------------------------------------------------------------------

export interface PincodeReply {
  delivery_codes?: Array<{
    postal_code?: {
      pin?: number | string;
      /** "Y" when Delhivery collects from this postcode. */
      pickup?: string;
      /** "Y" when it delivers prepaid parcels there. */
      pre_paid?: string;
      district?: string;
      state_code?: string;
      is_oda?: string;
    };
  }>;
}

/** What Delhivery does at a postcode. An empty list means nothing. */
export const pincode = (e: Env, pin: string) =>
  request<PincodeReply>(e, "GET", `/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pin)}`);

/** One reverse-pickup shipment, as Delhivery's manifest wants it. */
export interface ReverseShipmentInput {
  /** The consignee for a reverse pickup is the shopper it's collected from. */
  name: string;
  add: string;
  pin: string;
  city: string;
  state: string;
  country: string;
  phone: string;
  /** Our reference; must be unique per account. */
  order: string;
  payment_mode: "Pickup";
  /** Where it's delivered: the store. */
  return_pin: string;
  return_city: string;
  return_phone: string;
  return_add: string;
  return_state: string;
  return_country: string;
  products_desc: string;
  hsn_code: string;
  cod_amount: string;
  order_date: string | null;
  total_amount: string;
  seller_add: string;
  seller_name: string;
  seller_inv: string;
  quantity: string;
  waybill: string;
  shipment_width: string;
  shipment_height: string;
  shipment_length: string;
  /** Grams. */
  weight: string;
  shipping_mode: "Surface" | "Express";
  address_type: string;
}

export interface CreateReply {
  success?: boolean;
  rmk?: string;
  packages?: Array<{
    status?: string;
    waybill?: string;
    refnum?: string;
    remarks?: string[] | string;
    serviceable?: boolean;
  }>;
}

/** Manifests one shipment under a registered warehouse. */
export const createShipment = (e: Env, warehouse: string, shipment: ReverseShipmentInput) =>
  request<CreateReply>(e, "POST", "/api/cmu/create.json", {
    text: `format=json&data=${JSON.stringify({ shipments: [shipment], pickup_location: { name: warehouse } })}`,
  });

export interface PackingSlipReply {
  packages?: Array<{ wbn?: string; pdf_download_link?: string }>;
  packages_found?: number;
}

/** The label, as a PDF Delhivery hosts. */
export const packingSlip = (e: Env, waybill: string) =>
  request<PackingSlipReply>(e, "GET", `/api/p/packing_slip?wbns=${encodeURIComponent(waybill)}&pdf=true`);

export interface TrackReply {
  ShipmentData?: Array<{
    Shipment?: {
      AWB?: string;
      Status?: {
        Status?: string;
        StatusType?: string;
        StatusDateTime?: string;
        StatusLocation?: string;
        Instructions?: string;
      };
      Scans?: Array<{
        ScanDetail?: {
          Scan?: string;
          ScanType?: string;
          ScanDateTime?: string;
          ScannedLocation?: string;
          Instructions?: string;
          StatusCode?: string;
        };
      }>;
      PickUpDate?: string | null;
      DeliveryDate?: string | null;
      ExpectedDeliveryDate?: string | null;
    };
  }>;
  Error?: string;
}

export const track = (e: Env, waybill: string) =>
  request<TrackReply>(e, "GET", `/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}`);

/** Cancels a shipment that hasn't been collected yet. */
export const cancel = (e: Env, waybill: string) =>
  request<unknown>(e, "POST", "/api/p/edit", { json: { waybill, cancellation: "true" } });
