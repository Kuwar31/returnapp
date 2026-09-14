import { createHmac, randomBytes } from "node:crypto";
import type { Prisma, ReturnShipment, ReturnStatus, ShiprocketAccount } from "@prisma/client";
import { env } from "../../config/env.js";
import { encrypt, safeEqual } from "../../lib/crypto.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { toDecimal } from "../../lib/money.js";
import { prisma } from "../../lib/prisma.js";
import { notify } from "../email/notifications.js";
import { changeStatus, markReceived } from "../returns/returns.service.js";
import { defaultDestination } from "../settings/destinations.service.js";
import { readOrderPhone } from "../shopify/order.sync.js";
import * as api from "./shiprocket.client.js";
import { ShiprocketError } from "./shiprocket.client.js";
import {
  describeStatus,
  normaliseScans,
  outcomeOf,
  parseShiprocketDate,
  shipmentStatusFor,
} from "./shiprocket.status.js";

/**
 * Return labels through Shiprocket.
 *
 * A return that chose "ship with a return label" gets, at approval, a
 * reverse pickup: Shiprocket books a courier to collect the parcel from the
 * shopper's address and bring it to the store's return destination. Four
 * calls make one — create the return order, assign a courier and AWB, print
 * the label, book the pickup — and each is resumable, so a failure halfway
 * is retried from where it stopped rather than booking a second parcel.
 *
 * Tracking comes back two ways: Shiprocket's webhook, when the merchant has
 * set it up, and a sweep that asks about open shipments for stores that
 * haven't. Both land in `applyTracking`, which moves the parcel and, through
 * it, the return.
 */

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/** Tokens last 240 hours; refresh with a day to spare. */
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;

const newSecret = () => randomBytes(24).toString("hex");

/** Where Shiprocket posts tracking events. Must not contain "shiprocket". */
export const webhookUrl = () => `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/events`;

/** The account with the destination it delivers to, when one is chosen. */
export const getAccount = (merchantId: string) =>
  prisma.shiprocketAccount.findUnique({
    where: { merchantId },
    include: { destination: true },
  });

/**
 * Where the courier delivers for this store: the destination chosen on the
 * Shipping page, else the store's default. A regional policy's own
 * destination outranks both, per return.
 */
export const deliveryDestination = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  return account?.destination ?? (await defaultDestination(merchantId));
};

export const serializeAccount = (account: ShiprocketAccount | null) =>
  account
    ? {
        connected: true as const,
        email: account.email,
        connectedAt: account.createdAt,
        tokenExpiresAt: account.tokenExpiresAt,
        webhookUrl: webhookUrl(),
        webhookSecret: account.webhookSecret,
        /** Null means the store's default destination. */
        destinationId: account.destinationId,
        testMode: account.testMode,
        autoCreate: account.autoCreate,
        receiveOnDelivery: account.receiveOnDelivery,
        qcEnabled: account.qcEnabled,
        parcel: {
          lengthCm: Number(account.lengthCm),
          breadthCm: Number(account.breadthCm),
          heightCm: Number(account.heightCm),
          weightKg: Number(account.weightKg),
        },
      }
    : { connected: false as const, webhookUrl: webhookUrl() };

/** Shiprocket's refusal, as the merchant should read it. */
const friendly = (error: unknown, fallback: string): Error => {
  if (error instanceof ShiprocketError) return unprocessable(error.message);
  if (error instanceof Error && "status" in error) return error;
  return unprocessable(error instanceof Error ? error.message : fallback);
};

/** Proves the API user works, then keeps it. */
export const connectAccount = async (merchantId: string, email: string, password: string) => {
  if (!env.ENCRYPTION_KEY) {
    throw unprocessable("This server has no ENCRYPTION_KEY, so it can't keep a Shiprocket password.");
  }
  let token: string;
  try {
    token = await api.login(email, password);
  } catch (error) {
    throw friendly(error, "Shiprocket didn't accept those details.");
  }
  const tokenExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  return prisma.shiprocketAccount.upsert({
    where: { merchantId },
    create: {
      merchantId,
      email,
      password: encrypt(password),
      token,
      tokenExpiresAt,
      webhookSecret: newSecret(),
    },
    update: { email, password: encrypt(password), token, tokenExpiresAt },
  });
};

export const disconnectAccount = async (merchantId: string) => {
  await prisma.shiprocketAccount.deleteMany({ where: { merchantId } });
};

export interface AccountInput {
  autoCreate?: boolean;
  receiveOnDelivery?: boolean;
  qcEnabled?: boolean;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
  weightKg?: number;
  /** A destination of this store's, or null for the default. */
  destinationId?: string | null;
  testMode?: boolean;
}

export const updateAccount = async (merchantId: string, input: AccountInput) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  if (input.destinationId) {
    const owned = await prisma.returnDestination.findFirst({
      where: { id: input.destinationId, merchantId },
      select: { id: true },
    });
    if (!owned) throw notFound("That destination isn't one of this store's.");
  }
  return prisma.shiprocketAccount.update({
    where: { merchantId },
    data: input,
    include: { destination: true },
  });
};

export const rotateWebhookSecret = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  return prisma.shiprocketAccount.update({
    where: { merchantId },
    data: { webhookSecret: newSecret() },
    include: { destination: true },
  });
};

/** Logs in afresh, so "Test connection" says something true. */
export const testConnection = async (merchantId: string) => {
  const account = await getAccount(merchantId);
  if (!account) throw notFound("Shiprocket isn't connected.");
  await prisma.shiprocketAccount.update({ where: { merchantId }, data: { token: null } });
  try {
    await api.call(merchantId, "GET", "/settings/company/pickup");
  } catch (error) {
    throw friendly(error, "Couldn't reach Shiprocket.");
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Addresses, as Shiprocket wants them
// ---------------------------------------------------------------------------

/** Shopify sends Indian provinces as ISO codes; Shiprocket wants the name. */
const INDIAN_STATES: Record<string, string> = {
  AN: "Andaman and Nicobar Islands",
  AP: "Andhra Pradesh",
  AR: "Arunachal Pradesh",
  AS: "Assam",
  BR: "Bihar",
  CH: "Chandigarh",
  CT: "Chhattisgarh",
  CG: "Chhattisgarh",
  DN: "Dadra and Nagar Haveli and Daman and Diu",
  DD: "Daman and Diu",
  DH: "Dadra and Nagar Haveli and Daman and Diu",
  DL: "Delhi",
  GA: "Goa",
  GJ: "Gujarat",
  HR: "Haryana",
  HP: "Himachal Pradesh",
  JK: "Jammu and Kashmir",
  JH: "Jharkhand",
  KA: "Karnataka",
  KL: "Kerala",
  LA: "Ladakh",
  LD: "Lakshadweep",
  MP: "Madhya Pradesh",
  MH: "Maharashtra",
  MN: "Manipur",
  ML: "Meghalaya",
  MZ: "Mizoram",
  NL: "Nagaland",
  OR: "Odisha",
  OD: "Odisha",
  PY: "Puducherry",
  PB: "Punjab",
  RJ: "Rajasthan",
  SK: "Sikkim",
  TN: "Tamil Nadu",
  TG: "Telangana",
  TS: "Telangana",
  TR: "Tripura",
  UP: "Uttar Pradesh",
  UT: "Uttarakhand",
  UK: "Uttarakhand",
  WB: "West Bengal",
};

const stateName = (code: string | null): string | null => {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  return INDIAN_STATES[key] ?? code.trim();
};

const countryName = (code: string | null): string | null => {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/**
 * A ten-digit Indian mobile number, which is the only kind Shiprocket's
 * couriers will call. Country code and a leading zero are stripped; anything
 * else is left for the caller to explain.
 */
export const indianMobile = (raw: string | null | undefined): string | null => {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
};

interface Party {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  phone: string;
  email: string;
}

const str = (a: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const found = a[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
};

/**
 * The shopper's phone number, wherever it can be had.
 *
 * The order's own field first: it holds what the shopper typed at checkout,
 * or what the merchant entered on the return. The order sync never fetches
 * phone — it's protected customer data — so an order without one is asked
 * about now, once, and the answer kept.
 */
const shopperPhone = async (
  merchantId: string,
  order: { id: string; externalId: string | null; phone: string | null },
  address: Record<string, unknown>,
): Promise<string> => {
  if (order.phone) return order.phone;
  const onAddress = str(address, "phone");
  if (onAddress) return onAddress;
  const { phone, problem } = order.externalId
    ? await readOrderPhone(merchantId, order.externalId)
    : { phone: null, problem: null };
  if (phone) {
    await prisma.order.update({ where: { id: order.id }, data: { phone } });
    return phone;
  }
  // Say why, since "the order has no number" is often untrue: Shopify has
  // one and won't hand it over until the app is approved for the field.
  const fix = "Enter the customer's number on the return, then book again.";
  switch (problem) {
    case "NOT_APPROVED":
      throw unprocessable(
        "Shopify hasn't approved this app to read customer phone numbers, so the number on the order can't be read. " +
          `Request the Phone field under Protected customer data in your Partner Dashboard, or: ${fix}`,
      );
    case "UNREACHABLE":
      throw unprocessable(
        `Shopify couldn't be reached to read the customer's phone number. Try again in a moment, or: ${fix}`,
      );
    default:
      throw unprocessable(
        `Shiprocket needs a 10-digit Indian mobile number for the pickup, and the order doesn't carry one. ${fix}`,
      );
  }
};

/** The shopper, from the order's shipping address in either of its shapes. */
const shopperParty = async (
  merchantId: string,
  order: {
    id: string;
    externalId: string | null;
    shippingAddress: unknown;
    phone: string | null;
    email: string;
    customerName: string | null;
  },
  reference: string,
): Promise<Party> => {
  const a =
    order.shippingAddress && typeof order.shippingAddress === "object"
      ? (order.shippingAddress as Record<string, unknown>)
      : {};
  const fullName =
    str(a, "name") ??
    [str(a, "firstName", "first_name"), str(a, "lastName", "last_name")].filter(Boolean).join(" ") ??
    order.customerName ??
    "";
  const [firstName, ...rest] = (fullName || order.customerName || "Customer").split(/\s+/);
  const address1 = str(a, "address1");
  const city = str(a, "city");
  const pincode = str(a, "zip", "postalCode", "postal_code");
  if (!address1 || !city || !pincode) {
    throw unprocessable(
      `Order for ${reference} has no complete shipping address to collect the parcel from.`,
    );
  }
  const raw = await shopperPhone(merchantId, order, a);
  const phone = indianMobile(raw);
  if (!phone) {
    throw unprocessable(
      `The order's phone number, ${raw}, isn't a 10-digit Indian mobile number, which Shiprocket needs for the pickup. Add one on the return, then book again.`,
    );
  }
  return {
    firstName,
    lastName: rest.join(" "),
    address1,
    address2: str(a, "address2") ?? "",
    city,
    state:
      str(a, "province") ?? stateName(str(a, "provinceCode", "province_code")) ?? "",
    country:
      str(a, "country") ?? countryName(str(a, "countryCodeV2", "country_code", "countryCode")) ?? "India",
    pincode,
    phone,
    email: order.email,
  };
};

/** Where the parcel is going: the region's destination, else the default. */
const destinationParty = async (
  merchantId: string,
  destination: {
    name: string;
    address1: string;
    address2: string | null;
    city: string;
    province: string | null;
    zip: string | null;
    countryCode: string;
    phone: string | null;
  } | null,
  merchantEmail: string | null,
): Promise<Party> => {
  const d = destination ?? (await defaultDestination(merchantId));
  if (!d) {
    throw unprocessable(
      "Add a return destination under Return policies → Destinations first; it's where the courier delivers.",
    );
  }
  const phone = indianMobile(d.phone);
  if (!phone) {
    throw unprocessable(
      `Give the return destination "${d.name}" a 10-digit Indian mobile number — Shiprocket needs one for the delivery.`,
    );
  }
  if (!d.zip) throw unprocessable(`Give the return destination "${d.name}" a postcode.`);
  return {
    firstName: d.name,
    lastName: "",
    address1: d.address1,
    address2: d.address2 ?? "",
    city: d.city,
    state: stateName(d.province) ?? "",
    country: countryName(d.countryCode) ?? "India",
    pincode: d.zip,
    phone,
    email: merchantEmail ?? "",
  };
};

// ---------------------------------------------------------------------------
// Making the label
// ---------------------------------------------------------------------------

const labelInclude = {
  order: true,
  lineItems: { include: { orderLineItem: true } },
  shipment: true,
  regionalPolicy: { select: { destination: true } },
  merchant: { select: { name: true, email: true } },
} satisfies Prisma.ReturnRequestInclude;

type LabelRequest = Prisma.ReturnRequestGetPayload<{ include: typeof labelInclude }>;

const loadForLabel = async (merchantId: string, returnId: string): Promise<LabelRequest> => {
  const request = await prisma.returnRequest.findFirst({
    where: { id: returnId, merchantId },
    include: labelInclude,
  });
  if (!request) throw notFound("Return request not found.");
  return request;
};

/** "2024-03-08 14:05", Shiprocket's order date. */
const orderDate = (at: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
};

export const trackingUrlFor = (awb: string) => `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;

type Account = NonNullable<Awaited<ReturnType<typeof getAccount>>>;

const buildReturnOrder = async (
  request: LabelRequest,
  account: Account,
  orderId: string,
): Promise<api.ReturnOrderInput> => {
  const shopper = await shopperParty(request.merchantId, request.order, request.reference);
  // The region's own destination first, then the one chosen for Shiprocket,
  // then the store default (inside destinationParty).
  const store = await destinationParty(
    request.merchantId,
    request.regionalPolicy?.destination ?? account.destination ?? null,
    request.merchant.email,
  );
  const items: api.ReturnOrderItem[] = request.lineItems
    .filter((line) => !line.keepItem)
    .map((line) => {
      const title = line.orderLineItem?.title ?? "Item";
      const name = line.orderLineItem?.variantTitle ? `${title} - ${line.orderLineItem.variantTitle}` : title;
      return {
        name: name.slice(0, 150),
        sku: (line.orderLineItem?.sku || `line-${line.id}`).slice(0, 50),
        units: line.quantity,
        selling_price: toDecimal(line.unitPrice).toNumber(),
        discount: 0,
        qc_enable: account.qcEnabled,
        ...(account.qcEnabled
          ? {
              qc_product_name: title.slice(0, 150),
              ...(line.orderLineItem?.imageUrl ? { qc_product_image: line.orderLineItem.imageUrl } : {}),
            }
          : {}),
      };
    });
  if (items.length === 0) throw unprocessable("Nothing on this return is being sent back.");

  return {
    order_id: orderId,
    order_date: orderDate(request.submittedAt),
    pickup_customer_name: shopper.firstName,
    pickup_last_name: shopper.lastName,
    pickup_address: shopper.address1,
    pickup_address_2: shopper.address2,
    pickup_city: shopper.city,
    pickup_state: shopper.state,
    pickup_country: shopper.country,
    pickup_pincode: shopper.pincode,
    pickup_email: shopper.email,
    pickup_phone: shopper.phone,
    pickup_isd_code: "91",
    shipping_customer_name: store.firstName,
    shipping_last_name: store.lastName,
    shipping_address: store.address1,
    shipping_address_2: store.address2,
    shipping_city: store.city,
    shipping_country: store.country,
    shipping_pincode: store.pincode,
    shipping_state: store.state,
    shipping_email: store.email,
    shipping_isd_code: "91",
    shipping_phone: store.phone,
    order_items: items,
    payment_method: "PREPAID",
    total_discount: 0,
    sub_total: toDecimal(request.itemsSubtotal).toNumber(),
    length: Number(account.lengthCm),
    breadth: Number(account.breadthCm),
    height: Number(account.heightCm),
    weight: Number(account.weightKg),
  };
};

const saveShipment = (returnId: string, data: Prisma.ReturnShipmentUncheckedUpdateInput) =>
  prisma.returnShipment.upsert({
    where: { returnRequestId: returnId },
    create: {
      ...(data as Omit<Prisma.ReturnShipmentUncheckedCreateInput, "returnRequestId">),
      returnRequestId: returnId,
      provider: "SHIPROCKET",
    },
    update: data,
  });

const event = (
  returnId: string,
  actorId: string | null,
  type: "LABEL_GENERATED" | "STATUS_CHANGED",
  message: string,
  metadata?: Prisma.InputJsonValue,
) =>
  prisma.returnEvent.create({
    data: { returnRequestId: returnId, actorId, type, message, metadata },
  });

const OPEN_FOR_LABEL: ReturnStatus[] = ["APPROVED", "IN_TRANSIT"];

// ---------------------------------------------------------------------------
// Courier quotes — who can collect this parcel, and for how much
// ---------------------------------------------------------------------------

/** One courier service the merchant can book, priced. */
export interface CourierQuote {
  courierId: number;
  name: string;
  /** Rupees — Shiprocket's own currency. */
  rate: number;
  /** The same in the store's currency, when the order's rate makes that possible. */
  shopRate: number | null;
  /** "Sep 18, 2026", as Shiprocket words it. */
  etd: string | null;
  days: number | null;
  surface: boolean;
  rating: number | null;
  /** Shiprocket's own pick, which is what a booking without a choice gets. */
  recommended: boolean;
}

/** The couriers test mode offers, so the choosing can be tried too. */
const TEST_COURIERS: Array<Omit<CourierQuote, "shopRate" | "recommended">> = [
  { courierId: 900001, name: "Test courier Surface", rate: 120, etd: null, days: 4, surface: true, rating: 4.5 },
  { courierId: 900002, name: "Test courier Express", rate: 260, etd: null, days: 2, surface: false, rating: 4.8 },
];

/**
 * Rupees into the store's currency, using the order's own exchange rate: an
 * order billed in rupees knows what its shop-currency total was worth. Null
 * when there's no such rate to lean on.
 */
const rupeesToShop = (order: {
  currency: string;
  total: Prisma.Decimal;
  presentmentCurrency: string | null;
  presentmentTotal: Prisma.Decimal | null;
}): number | null => {
  if (order.currency === "INR") return 1;
  if (order.presentmentCurrency !== "INR" || !order.presentmentTotal) return null;
  const inr = toDecimal(order.presentmentTotal).toNumber();
  const shop = toDecimal(order.total).toNumber();
  return inr > 0 && shop > 0 ? shop / inr : null;
};

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
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
): Promise<{ couriers: CourierQuote[]; shopCurrency: string }> => {
  const account = await getAccount(merchantId);
  if (!account) throw unprocessable("Connect Shiprocket under Settings → Shipping first.");
  const request = await loadForLabel(merchantId, returnId);
  if (!["SUBMITTED", ...OPEN_FOR_LABEL].includes(request.status)) {
    throw unprocessable("This return is no longer waiting for a parcel.");
  }
  if (request.returnMethod === "KEEP") throw unprocessable("A green return has nothing to ship.");
  const input = await buildReturnOrder(request, account, request.reference);
  const toShop = rupeesToShop(request.order);
  const shopCurrency = request.order.currency;
  const withShop = (rate: number) => (toShop === null ? null : Math.round(rate * toShop * 100) / 100);

  if (account.testMode) {
    return {
      shopCurrency,
      couriers: TEST_COURIERS.map((c, i) => ({ ...c, shopRate: withShop(c.rate), recommended: i === 0 })),
    };
  }

  let reply: api.ServiceabilityReply;
  try {
    reply = await api.checkServiceability(merchantId, {
      pickupPostcode: input.pickup_pincode,
      deliveryPostcode: input.shipping_pincode,
      weightKg: input.weight,
      declaredValue: input.sub_total,
      lengthCm: input.length,
      breadthCm: input.breadth,
      heightCm: input.height,
    });
  } catch (error) {
    throw friendly(error, "Shiprocket couldn't quote this pickup.");
  }
  const recommended =
    reply.data?.recommended_courier_company_id ?? reply.data?.shiprocket_recommended_courier_id ?? null;
  const couriers = (reply.data?.available_courier_companies ?? [])
    .flatMap((c): CourierQuote[] => {
      const rate = num(c.rate) ?? num(c.freight_charge);
      if (rate === null || !c.courier_company_id) return [];
      return [
        {
          courierId: c.courier_company_id,
          name: c.courier_name,
          rate,
          shopRate: withShop(rate),
          etd: c.etd || null,
          days: num(c.estimated_delivery_days),
          surface: c.is_surface ?? true,
          rating: num(c.rating),
          recommended: c.courier_company_id === recommended,
        },
      ];
    })
    .sort((a, b) => a.rate - b.rate);
  return { couriers, shopCurrency };
};

// ---------------------------------------------------------------------------
// Test mode — pretend pickups, since Shiprocket has no sandbox
// ---------------------------------------------------------------------------

/** Signs a test label's address, so the page can't be guessed. */
export const testLabelSignature = (shipmentId: string): string =>
  createHmac("sha256", env.JWT_SECRET).update(`test-label:${shipmentId}`).digest("hex").slice(0, 32);

const testLabelUrl = (shipmentId: string) =>
  `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/test-label/${shipmentId}?sig=${testLabelSignature(shipmentId)}`;

/** "2026-09-13 14:05:00", Indian time, as Shiprocket's own scans read. */
const istStamp = (at: Date): string =>
  at.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata", hour12: false }).replace("T", " ");

/**
 * A pretend booking. The addresses and phone numbers were checked the same
 * way a real one checks them — that is most of what test mode is for — and
 * then a made-up courier, AWB and label stand in for Shiprocket's. The
 * emails and the shopper's page can't tell the difference; the return page
 * can, and offers to simulate the pickup and the delivery.
 */
const bookTestLabel = async (
  request: LabelRequest,
  input: api.ReturnOrderInput,
  actorId: string | null,
  options: { email?: boolean; courierId?: number | null },
): Promise<ReturnShipment> => {
  const awb = `TEST${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
  const courier =
    TEST_COURIERS.find((c) => c.courierId === options.courierId)?.name ?? TEST_COURIERS[0].name;
  const pickup = new Date();
  pickup.setDate(pickup.getDate() + 1);
  pickup.setHours(14, 0, 0, 0);
  const saved = await saveShipment(request.id, {
    provider: "SHIPROCKET",
    isTest: true,
    status: "LABEL_CREATED",
    externalOrderId: `TEST-${input.order_id}`,
    externalShipmentId: `TEST-${input.order_id}`,
    externalStatus: "PICKUP SCHEDULED",
    externalStatusId: 4,
    carrier: courier,
    trackingNumber: awb,
    trackingUrl: null,
    labelUrl: null,
    pickupScheduledAt: pickup,
    pickupToken: "Test booking — no courier is coming",
    scans: [
      {
        date: istStamp(new Date()),
        activity: "Pickup scheduled (test mode)",
        location: "Test mode",
        status: "PICKUP SCHEDULED",
      },
    ],
    shippedAt: null,
    deliveredAt: null,
    lastError: null,
    lastTrackedAt: new Date(),
  });
  const shipment = await prisma.returnShipment.update({
    where: { id: saved.id },
    data: { labelUrl: testLabelUrl(saved.id) },
  });
  await event(
    request.id,
    actorId,
    "LABEL_GENERATED",
    `Test label made with ${courier} — test mode, nothing sent to Shiprocket — AWB ${awb}`,
    { ok: true, test: true, awb, courier },
  );
  if (options.email !== false) await notify(request.id, "LABEL_READY");
  return shipment;
};

/**
 * Moves a test parcel along by hand: collected, then delivered. Goes through
 * the same tracking path a real scan does, so the return follows.
 */
export const simulateTracking = async (
  merchantId: string,
  returnId: string,
  step: "PICKED_UP" | "DELIVERED",
): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
    include: trackedInclude,
  });
  if (!shipment) throw notFound("This return has no shipment.");
  if (!shipment.isTest) {
    throw unprocessable("Only a test-mode booking can be simulated; a real parcel reports through Shiprocket.");
  }
  if (["CANCELLED", "DELIVERED", "FAILED"].includes(shipment.status)) {
    throw unprocessable("That parcel is finished.");
  }
  const stamp = istStamp(new Date());
  const scan =
    step === "PICKED_UP"
      ? { statusId: 42, statusLabel: "PICKED UP", activity: "In Transit - Shipment picked up (simulated)" }
      : { statusId: 7, statusLabel: "DELIVERED", activity: "Delivered (simulated)" };
  await applyTracking(
    shipment,
    {
      statusId: scan.statusId,
      statusLabel: scan.statusLabel,
      courier: "Test courier",
      scans: [
        { date: stamp, activity: scan.activity, location: "Test mode", status: scan.statusLabel },
        ...normaliseScans(shipment.scans),
      ],
      pickedUpAt: step === "PICKED_UP" ? stamp : undefined,
      deliveredAt: step === "DELIVERED" ? stamp : undefined,
    },
    "poll",
  );
  return prisma.returnShipment.findUniqueOrThrow({ where: { id: shipment.id } });
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The test label, as a printable page. Null when the signature is wrong or
 * the shipment isn't a test one — a real label is Shiprocket's PDF.
 */
export const testLabelHtml = async (shipmentId: string, sig: string | undefined): Promise<string | null> => {
  if (!sig || !safeEqual(sig, testLabelSignature(shipmentId))) return null;
  const shipment = await prisma.returnShipment.findUnique({
    where: { id: shipmentId },
    include: { returnRequest: { include: labelInclude } },
  });
  if (!shipment?.isTest) return null;
  const request = shipment.returnRequest;
  const account = await getAccount(request.merchantId);
  const from = await shopperParty(request.merchantId, request.order, request.reference);
  const to = await destinationParty(
    request.merchantId,
    request.regionalPolicy?.destination ?? account?.destination ?? null,
    request.merchant.email,
  );
  const party = (p: Party) =>
    [
      `${p.firstName} ${p.lastName}`.trim(),
      p.address1,
      p.address2,
      `${p.city} ${p.state} ${p.pincode}`.replace(/\s+/g, " ").trim(),
      p.country,
      `Phone ${p.phone}`,
    ]
      .filter(Boolean)
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join("");
  const items = request.lineItems
    .filter((line) => !line.keepItem)
    .map((line) => {
      const title = line.orderLineItem?.title ?? "Item";
      const variant = line.orderLineItem?.variantTitle ? ` — ${line.orderLineItem.variantTitle}` : "";
      return `<li>${escapeHtml(`${line.quantity} × ${title}${variant}`)}</li>`;
    })
    .join("");
  const awb = shipment.trackingNumber ?? "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test return label ${escapeHtml(request.reference)}</title>
<style>
  body{margin:0;padding:24px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#111;background:#f4f4f5}
  .label{max-width:640px;margin:0 auto;background:#fff;border:2px solid #111;padding:24px}
  .banner{background:#fff3cd;border:1px solid #e0b33c;padding:10px 14px;font-weight:700;margin-bottom:20px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:20px}
  h2{margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#666}
  .awb{margin:20px 0 8px;font-size:22px;font-weight:700;letter-spacing:.06em}
  .bars{height:56px;background:repeating-linear-gradient(90deg,#111 0 2px,#fff 2px 4px,#111 4px 5px,#fff 5px 9px,#111 9px 12px,#fff 12px 14px);margin-bottom:20px}
  ul{margin:6px 0 0;padding-left:18px}
  .meta{color:#555;font-size:13px;margin-top:16px}
  @media print{body{background:#fff;padding:0}.label{border-width:1px}}
</style></head><body>
<div class="label">
  <div class="banner">TEST LABEL — not valid for shipping. Made in test mode; no courier is coming.</div>
  <div class="row">
    <div><h2>Pickup from</h2>${party(from)}</div>
    <div><h2>Deliver to</h2>${party(to)}</div>
  </div>
  <h2>AWB · Test courier</h2>
  <div class="awb">${escapeHtml(awb)}</div>
  <div class="bars" aria-hidden="true"></div>
  <h2>Return ${escapeHtml(request.reference)} · Order #${escapeHtml(request.order.orderNumber)}</h2>
  <ul>${items}</ul>
  <div class="meta">Parcel ${Number(account?.lengthCm ?? 0)} × ${Number(account?.breadthCm ?? 0)} × ${Number(account?.heightCm ?? 0)} cm, ${Number(account?.weightKg ?? 0)} kg · ${escapeHtml(request.merchant.name)}</div>
</div>
</body></html>`;
};

/**
 * Makes the label, resuming a half-made one.
 *
 * Booked once: a shipment that already has a label is left alone, and one
 * whose courier failed or was cancelled starts over under a fresh order id,
 * since Shiprocket won't reuse one. A shipment that stopped partway — order
 * made, no courier yet — carries on from there.
 *
 * `email` is off when the approval mail is about to go out anyway and will
 * carry the label itself.
 */
export const createReturnLabel = async (
  merchantId: string,
  returnId: string,
  actorId: string | null,
  /**
   * `courierId` is the merchant's pick from the quote; without one,
   * Shiprocket books its recommended courier.
   */
  options: { email?: boolean; courierId?: number | null } = {},
): Promise<ReturnShipment> => {
  const account = await getAccount(merchantId);
  if (!account) throw unprocessable("Connect Shiprocket under Settings → Shipping first.");
  const request = await loadForLabel(merchantId, returnId);
  if (!OPEN_FOR_LABEL.includes(request.status)) {
    throw unprocessable(
      request.status === "SUBMITTED"
        ? "Approve the return first; the label is made for an approved return."
        : "This return is no longer waiting for a parcel.",
    );
  }
  if (request.returnMethod === "KEEP") throw unprocessable("A green return has nothing to ship.");

  const existing = request.shipment;
  const madeBefore = Boolean(existing?.labelUrl);
  if (existing && madeBefore && !["FAILED", "CANCELLED"].includes(existing.status)) {
    throw unprocessable("This return already has a label.");
  }
  // Carry on from a half-made one; start over after a courier failure.
  const resume = existing && !madeBefore && existing.externalShipmentId ? existing : null;
  const orderId = madeBefore ? `${request.reference}-${Date.now().toString(36).slice(-4).toUpperCase()}` : request.reference;

  const fail = async (step: string, error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ merchantId, returnId, step, message }, "Shiprocket label step failed");
    await saveShipment(returnId, { status: "FAILED", lastError: `${step}: ${message}` });
    await event(returnId, actorId, "LABEL_GENERATED", `Couldn't make a return label — ${step}: ${message}`, {
      ok: false,
      step,
    });
    throw friendly(error, message);
  };

  // Test mode books a pretend pickup: the same checks, nothing sent.
  if (account.testMode) {
    let input: api.ReturnOrderInput;
    try {
      input = await buildReturnOrder(request, account, orderId);
    } catch (error) {
      return fail("checking addresses", error);
    }
    return bookTestLabel(request, input, actorId, options);
  }

  let shipmentId = resume?.externalShipmentId ?? null;
  let awb = resume?.trackingNumber ?? null;
  let courier = resume?.carrier ?? null;

  if (!shipmentId) {
    let input: api.ReturnOrderInput;
    try {
      input = await buildReturnOrder(request, account, orderId);
    } catch (error) {
      return fail("checking addresses", error);
    }
    try {
      const reply = await api.createReturnOrder(merchantId, input);
      if (!reply?.shipment_id) throw new ShiprocketError("Shiprocket made no shipment for the return.", 200, reply);
      shipmentId = String(reply.shipment_id);
      await saveShipment(returnId, {
        provider: "SHIPROCKET",
        status: "PENDING",
        externalOrderId: String(reply.order_id),
        externalShipmentId: shipmentId,
        externalStatus: reply.status ?? null,
        externalStatusId: reply.status_code ?? null,
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        labelUrl: null,
        pickupScheduledAt: null,
        pickupToken: null,
        scans: [],
        shippedAt: null,
        deliveredAt: null,
        lastError: null,
      });
    } catch (error) {
      return fail("creating the return order", error);
    }
  }

  if (!awb) {
    try {
      const reply = await api.assignAwb(merchantId, shipmentId, options.courierId ?? null);
      const data = reply?.response?.data;
      if (reply?.awb_assign_status !== 1 || !data?.awb_code) {
        throw new ShiprocketError(
          data?.awb_assign_error ?? "Shiprocket couldn't assign a courier to the pickup.",
          200,
          reply,
        );
      }
      awb = data.awb_code;
      courier = data.courier_name ?? null;
      await saveShipment(returnId, {
        carrier: courier,
        trackingNumber: awb,
        trackingUrl: trackingUrlFor(awb),
        pickupScheduledAt: parseShiprocketDate(data.pickup_scheduled_date),
        lastError: null,
      });
    } catch (error) {
      return fail("assigning a courier", error);
    }
  }

  let labelUrl: string;
  try {
    const reply = await api.generateLabel(merchantId, shipmentId);
    if (!reply?.label_url) {
      throw new ShiprocketError(reply?.response || "Shiprocket made no label.", 200, reply);
    }
    labelUrl = reply.label_url;
    await saveShipment(returnId, { labelUrl, status: "LABEL_CREATED", lastError: null });
  } catch (error) {
    return fail("printing the label", error);
  }

  // The pickup is asked for last, and a refusal here doesn't undo the label:
  // the parcel exists and can be booked again from the return.
  let pickupNote = "";
  try {
    const reply = await api.requestPickup(merchantId, shipmentId);
    const scheduled = reply?.response?.pickup_scheduled_date ?? reply?.pickup_scheduled_date;
    const token = reply?.response?.pickup_token_number ?? reply?.pickup_token_number;
    await saveShipment(returnId, {
      pickupScheduledAt: parseShiprocketDate(scheduled) ?? undefined,
      pickupToken: token ?? undefined,
    });
    if (scheduled) pickupNote = `, pickup ${scheduled}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate/i.test(message)) {
      await saveShipment(returnId, { lastError: `booking the pickup: ${message}` });
      pickupNote = ` — pickup not booked yet: ${message}`;
    }
  }

  await event(
    returnId,
    actorId,
    "LABEL_GENERATED",
    `Return label made with ${courier ?? "Shiprocket"}, AWB ${awb}${pickupNote}`,
    { ok: true, awb, courier, shipmentId },
  );
  if (options.email !== false) await notify(returnId, "LABEL_READY");
  return prisma.returnShipment.findUniqueOrThrow({ where: { returnRequestId: returnId } });
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
   * service. Absent, the store's setting decides and Shiprocket picks.
   */
  choice: { book?: boolean; courierId?: number | null } = {},
): Promise<void> => {
  try {
    if (choice.book === false) return;
    const account = await getAccount(merchantId);
    if (!account) return;
    if (!account.autoCreate && choice.book !== true) return;
    const request = await prisma.returnRequest.findFirst({
      where: { id: returnId, merchantId },
      select: { returnMethod: true, shipment: { select: { labelUrl: true } } },
    });
    if (request?.shipment?.labelUrl) return;
    if (request?.returnMethod !== "LABEL" && choice.book !== true) return;
    await createReturnLabel(merchantId, returnId, actorId, {
      email: false,
      courierId: choice.courierId ?? null,
    });
  } catch (error) {
    logger.warn({ merchantId, returnId, err: error }, "Automatic return label failed");
  }
};

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export interface TrackingUpdate {
  statusId?: number | null;
  statusLabel?: string | null;
  courier?: string | null;
  scans?: unknown;
  etd?: unknown;
  pickedUpAt?: unknown;
  deliveredAt?: unknown;
}

/** Later states never go back to earlier ones on an out-of-order scan. */
const RANK: Record<string, number> = {
  PENDING: 0,
  LABEL_CREATED: 1,
  IN_TRANSIT: 2,
  DELIVERED: 3,
  FAILED: 3,
  CANCELLED: 3,
};

type TrackedShipment = ReturnShipment & {
  returnRequest: { id: string; merchantId: string; status: ReturnStatus };
};

/**
 * Applies what the courier said to the parcel, and to the return behind it:
 * collected means the return is in transit; delivered means received, where
 * the store has asked for that.
 */
export const applyTracking = async (
  shipment: TrackedShipment,
  update: TrackingUpdate,
  source: "webhook" | "poll",
): Promise<void> => {
  const { returnRequest: request } = shipment;
  const outcome = outcomeOf(update.statusId ?? null, update.statusLabel ?? null);
  const proposed = shipmentStatusFor(outcome);
  const next =
    proposed && proposed !== shipment.status && RANK[proposed] >= RANK[shipment.status]
      ? proposed
      : null;
  const label = describeStatus(update.statusLabel);
  const labelChanged = Boolean(label && label !== describeStatus(shipment.externalStatus));

  const data: Prisma.ReturnShipmentUncheckedUpdateInput = {
    lastTrackedAt: new Date(),
    lastError: null,
    ...(update.statusLabel ? { externalStatus: update.statusLabel } : {}),
    ...(typeof update.statusId === "number" ? { externalStatusId: update.statusId } : {}),
    ...(update.courier ? { carrier: update.courier } : {}),
    ...(Array.isArray(update.scans) && update.scans.length ? { scans: normaliseScans(update.scans) as unknown as Prisma.InputJsonValue } : {}),
    ...(parseShiprocketDate(update.etd) ? { etd: parseShiprocketDate(update.etd) } : {}),
  };
  if (next) {
    data.status = next;
    if (next === "IN_TRANSIT" && !shipment.shippedAt) {
      data.shippedAt = parseShiprocketDate(update.pickedUpAt) ?? new Date();
    }
    if (next === "DELIVERED") {
      data.deliveredAt = parseShiprocketDate(update.deliveredAt) ?? new Date();
    }
  }
  await prisma.returnShipment.update({ where: { id: shipment.id }, data });

  if (labelChanged || next) {
    await event(
      request.id,
      null,
      "STATUS_CHANGED",
      `Parcel update from ${shipment.carrier ?? update.courier ?? "the courier"}: ${label ?? next}`,
      { shipment: true, source, status: next, externalStatus: update.statusLabel ?? null },
    );
  }

  // The return follows the parcel.
  if (next === "IN_TRANSIT" && request.status === "APPROVED") {
    await changeStatus({
      merchantId: request.merchantId,
      id: request.id,
      to: "IN_TRANSIT",
      message: `Picked up by ${update.courier ?? shipment.carrier ?? "the courier"}`,
    });
  } else if (next === "DELIVERED" && ["APPROVED", "IN_TRANSIT"].includes(request.status)) {
    const account = await getAccount(request.merchantId);
    if (account?.receiveOnDelivery) {
      await markReceived(request.merchantId, request.id, null);
    }
  }
};

const trackedInclude = {
  returnRequest: { select: { id: true, merchantId: true, status: true } },
} as const;

/** Asks Shiprocket about one parcel and applies the answer. */
export const refreshTracking = async (merchantId: string, returnId: string): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
    include: trackedInclude,
  });
  if (!shipment?.externalShipmentId) throw notFound("This return has no Shiprocket shipment.");
  if (shipment.isTest) {
    // Nothing to ask: a test parcel moves only when simulated from the return.
    return prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date() },
    });
  }
  let reply: api.TrackingReply;
  try {
    reply = await api.trackShipment(merchantId, shipment.externalShipmentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: `tracking: ${message}` },
    });
    throw friendly(error, message);
  }
  const t = reply?.tracking_data;
  const track = t?.shipment_track?.[0];
  if (!t || t.track_status === 0 || !track) {
    // Nothing scanned yet, which is normal right after booking.
    await prisma.returnShipment.update({
      where: { id: shipment.id },
      data: { lastTrackedAt: new Date(), lastError: null },
    });
    return prisma.returnShipment.findUniqueOrThrow({ where: { id: shipment.id } });
  }
  await applyTracking(
    shipment,
    {
      statusId: t.shipment_status ?? null,
      statusLabel: track.current_status ?? null,
      courier: track.courier_name ?? null,
      scans: t.shipment_track_activities,
      etd: t.etd ?? track.edd,
      pickedUpAt: track.pickup_date,
      deliveredAt: track.delivered_date,
    },
    "poll",
  );
  return prisma.returnShipment.findUniqueOrThrow({ where: { id: shipment.id } });
};

/** How long a parcel is left alone between polls. */
const POLL_AFTER_MS = 20 * 60 * 1000;

/**
 * One pass over every open Shiprocket parcel, for stores without the
 * webhook. Each is asked about on its own, so one refusal doesn't stall the
 * rest.
 */
export const runTrackingSweep = async (): Promise<{ checked: number; failed: number }> => {
  const due = await prisma.returnShipment.findMany({
    where: {
      provider: "SHIPROCKET",
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

/**
 * A tracking event from Shiprocket's webhook. The `x-api-key` header names
 * the store; the AWB (or Shiprocket's order id) names the parcel. Events for
 * parcels we didn't make — the store's forward shipments — are ignored.
 */
export const handleWebhook = async (
  apiKey: string | undefined,
  payload: unknown,
): Promise<"unauthorized" | "ignored" | "applied"> => {
  if (!apiKey) return "unauthorized";
  const account = await prisma.shiprocketAccount.findUnique({ where: { webhookSecret: apiKey } });
  if (!account) return "unauthorized";
  if (!payload || typeof payload !== "object") return "ignored";
  const p = payload as Record<string, unknown>;
  const awb = typeof p.awb === "string" || typeof p.awb === "number" ? String(p.awb) : "";
  const srOrderId = p.sr_order_id !== undefined && p.sr_order_id !== null ? String(p.sr_order_id) : "";
  if (!awb && !srOrderId) return "ignored";

  const shipment = await prisma.returnShipment.findFirst({
    where: {
      provider: "SHIPROCKET",
      returnRequest: { merchantId: account.merchantId },
      OR: [...(awb ? [{ trackingNumber: awb }] : []), ...(srOrderId ? [{ externalOrderId: srOrderId }] : [])],
    },
    include: trackedInclude,
  });
  if (!shipment) return "ignored";

  const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  await applyTracking(
    shipment,
    {
      statusId: num(p.shipment_status_id) ?? num(p.current_status_id),
      statusLabel: text(p.shipment_status) ?? text(p.current_status),
      courier: text(p.courier_name),
      scans: p.scans,
      etd: p.etd,
    },
    "webhook",
  );
  return "applied";
};

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

/**
 * Calls the courier off. Both the shipment and Shiprocket's order are
 * cancelled; a refusal on either is recorded rather than thrown, since the
 * merchant can finish the job in their Shiprocket panel.
 */
export const cancelLabel = async (
  merchantId: string,
  returnId: string,
  actorId: string | null,
): Promise<ReturnShipment> => {
  const shipment = await prisma.returnShipment.findFirst({
    where: { returnRequestId: returnId, returnRequest: { merchantId } },
  });
  if (!shipment || shipment.provider !== "SHIPROCKET") throw notFound("This return has no Shiprocket shipment.");
  if (["DELIVERED", "CANCELLED"].includes(shipment.status)) {
    throw unprocessable("That parcel can't be cancelled any more.");
  }
  const problems: string[] = [];
  // A test booking exists nowhere but here.
  if (shipment.trackingNumber && !shipment.isTest) {
    try {
      await api.cancelShipment(merchantId, shipment.trackingNumber);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (shipment.externalOrderId && !shipment.isTest) {
    try {
      await api.cancelOrder(merchantId, shipment.externalOrderId);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
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
      ? `Return label cancelled here; Shiprocket said: ${problems.join("; ")}`
      : `Return label cancelled${shipment.trackingNumber ? ` (AWB ${shipment.trackingNumber})` : ""}`,
    { ok: problems.length === 0, cancelled: true },
  );
  return updated;
};

/** When a return is cancelled, its parcel is too. Never throws. */
export const cancelLabelQuietly = async (merchantId: string, returnId: string, actorId: string | null) => {
  try {
    const shipment = await prisma.returnShipment.findFirst({
      where: { returnRequestId: returnId, provider: "SHIPROCKET", status: { in: ["PENDING", "LABEL_CREATED", "IN_TRANSIT"] } },
      select: { id: true },
    });
    if (shipment) await cancelLabel(merchantId, returnId, actorId);
  } catch (error) {
    logger.warn({ merchantId, returnId, err: error }, "Couldn't cancel the return's parcel");
  }
};
