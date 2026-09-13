import { env } from "../../config/env.js";
import { decrypt } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

/**
 * The thinnest useful wrapper over Shiprocket's REST API.
 *
 * Every call carries a login token. Shiprocket's last ten days, so one is
 * cached on the store's account and refreshed a day early; a 401 in between
 * — the merchant changed the password, say — logs in once more and retries.
 */

/** A Shiprocket refusal, with what it said. */
export class ShiprocketError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ShiprocketError";
  }
}

/** Tokens last 240 hours; refresh with a day to spare. */
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;

const TIMEOUT_MS = 20_000;

/** Shiprocket's error bodies: `message`, sometimes with `errors` per field. */
const messageOf = (body: unknown, fallback: string): string => {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const errors = b.errors;
    if (errors && typeof errors === "object") {
      const detail = Object.values(errors as Record<string, unknown>)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      if (detail) return detail;
    }
    if (typeof b.message === "string" && b.message.trim()) return b.message;
  }
  return fallback;
};

const request = async <T>(
  method: "GET" | "POST",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.SHIPROCKET_API_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ShiprocketError(
      error instanceof Error && error.name === "AbortError"
        ? "Shiprocket didn't answer in time."
        : "Couldn't reach Shiprocket.",
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
  if (!res.ok) {
    throw new ShiprocketError(
      messageOf(parsed, `Shiprocket returned ${res.status}.`),
      res.status,
      parsed,
    );
  }
  return parsed as T;
};

/** Trades the API user's credentials for a token. */
export const login = async (email: string, password: string): Promise<string> => {
  const reply = await request<{ token?: string }>("POST", "/auth/login", null, {
    email,
    password,
  });
  if (!reply?.token) {
    throw new ShiprocketError("Shiprocket accepted the login but sent no token.", 200, reply);
  }
  return reply.token;
};

/**
 * A live token for the store, logging in when the cached one is missing or
 * about to lapse. `force` skips the cache after a 401.
 */
const tokenFor = async (merchantId: string, force = false): Promise<string> => {
  const account = await prisma.shiprocketAccount.findUnique({ where: { merchantId } });
  if (!account) throw new ShiprocketError("Shiprocket isn't connected for this store.", 0);
  if (
    !force &&
    account.token &&
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() > Date.now()
  ) {
    return account.token;
  }
  let password: string;
  try {
    password = decrypt(account.password);
  } catch {
    throw new ShiprocketError(
      "The saved Shiprocket password can't be read — reconnect Shiprocket in settings.",
      0,
    );
  }
  const token = await login(account.email, password);
  await prisma.shiprocketAccount.update({
    where: { merchantId },
    data: { token, tokenExpiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS) },
  });
  return token;
};

/** Calls Shiprocket for a store, logging in again once if the token is stale. */
export const call = async <T>(
  merchantId: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> => {
  const token = await tokenFor(merchantId);
  try {
    return await request<T>(method, path, token, body);
  } catch (error) {
    if (error instanceof ShiprocketError && error.status === 401) {
      logger.info({ merchantId }, "Shiprocket token rejected; logging in again");
      const fresh = await tokenFor(merchantId, true);
      return request<T>(method, path, fresh, body);
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// The calls a return label needs, typed to what Shiprocket actually sends
// ---------------------------------------------------------------------------

export interface ReturnOrderItem {
  name: string;
  sku: string;
  units: number;
  selling_price: number;
  discount?: number;
  qc_enable?: boolean;
  qc_product_name?: string;
  qc_product_image?: string;
}

/** The body of `orders/create/return`: pickup from the shopper, ship to us. */
export interface ReturnOrderInput {
  order_id: string;
  order_date: string;
  pickup_customer_name: string;
  pickup_last_name: string;
  pickup_address: string;
  pickup_address_2: string;
  pickup_city: string;
  pickup_state: string;
  pickup_country: string;
  pickup_pincode: string;
  pickup_email: string;
  pickup_phone: string;
  pickup_isd_code: string;
  shipping_customer_name: string;
  shipping_last_name: string;
  shipping_address: string;
  shipping_address_2: string;
  shipping_city: string;
  shipping_country: string;
  shipping_pincode: string;
  shipping_state: string;
  shipping_email: string;
  shipping_isd_code: string;
  shipping_phone: string;
  order_items: ReturnOrderItem[];
  payment_method: "PREPAID";
  total_discount: number;
  sub_total: number;
  length: number;
  breadth: number;
  height: number;
  weight: number;
}

export interface ReturnOrderReply {
  order_id: number;
  shipment_id: number;
  status: string;
  status_code: number;
}

export interface AwbReply {
  awb_assign_status: number;
  response?: {
    data?: {
      awb_code?: string;
      courier_company_id?: number;
      courier_name?: string;
      pickup_scheduled_date?: string;
      awb_assign_error?: string;
    };
  };
}

export interface LabelReply {
  label_created: number;
  label_url?: string;
  response?: string;
  not_created?: unknown[];
}

export interface PickupReply {
  pickup_status?: number;
  response?: {
    pickup_scheduled_date?: string;
    pickup_token_number?: string;
    data?: string;
  };
  /** The other shape Shiprocket uses for the same answer. */
  pickup_scheduled_date?: string;
  pickup_token_number?: string;
  message?: string;
}

export interface TrackingReply {
  tracking_data?: {
    track_status?: number;
    shipment_status?: number;
    error?: string;
    shipment_track?: Array<{
      awb_code?: string;
      courier_name?: string;
      current_status?: string;
      pickup_date?: string | null;
      delivered_date?: string | null;
      edd?: string | null;
    }>;
    shipment_track_activities?: unknown[];
    track_url?: string;
    etd?: string;
  };
}

export const createReturnOrder = (merchantId: string, input: ReturnOrderInput) =>
  call<ReturnOrderReply>(merchantId, "POST", "/orders/create/return", input);

/** Assigns a courier and AWB. `is_return` is what makes it a reverse pickup. */
export const assignAwb = (merchantId: string, shipmentId: string) =>
  call<AwbReply>(merchantId, "POST", "/courier/assign/awb", {
    shipment_id: shipmentId,
    is_return: 1,
  });

export const generateLabel = (merchantId: string, shipmentId: string) =>
  call<LabelReply>(merchantId, "POST", "/courier/generate/label", {
    shipment_id: [shipmentId],
  });

export const requestPickup = (merchantId: string, shipmentId: string) =>
  call<PickupReply>(merchantId, "POST", "/courier/generate/pickup", {
    shipment_id: [shipmentId],
  });

export const trackShipment = (merchantId: string, shipmentId: string) =>
  call<TrackingReply>(merchantId, "GET", `/courier/track/shipment/${encodeURIComponent(shipmentId)}`);

export const cancelShipment = (merchantId: string, awb: string) =>
  call<unknown>(merchantId, "POST", "/orders/cancel/shipment/awbs", { awbs: [awb] });

export const cancelOrder = (merchantId: string, orderId: string) =>
  call<unknown>(merchantId, "POST", "/orders/cancel", { ids: [Number(orderId)] });
