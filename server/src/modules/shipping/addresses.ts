import { unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { defaultDestination } from "../settings/destinations.service.js";
import { readOrderPhone } from "../shopify/order.sync.js";

/**
 * The two ends of a return parcel, as any Indian courier wants them: the
 * shopper it's collected from and the store it's delivered to, each with a
 * ten-digit mobile number, a postcode and a state spelt out.
 */

/** Shopify sends Indian provinces as ISO codes; couriers want the name. */
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

export const stateName = (code: string | null): string | null => {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  return INDIAN_STATES[key] ?? code.trim();
};

export const countryName = (code: string | null): string | null => {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/**
 * A ten-digit Indian mobile number, which is the only kind the couriers will
 * call. Country code and a leading zero are stripped; anything else is left
 * for the caller to explain.
 */
export const indianMobile = (raw: string | null | undefined): string | null => {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
};

export interface Party {
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

/** Both names, as one line. */
export const fullName = (p: Party): string => `${p.firstName} ${p.lastName}`.trim();

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
        `The courier needs a 10-digit Indian mobile number for the pickup, and the order doesn't carry one. ${fix}`,
      );
  }
};

/** The shopper, from the order's shipping address in either of its shapes. */
export const shopperParty = async (
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
  const named =
    str(a, "name") ??
    [str(a, "firstName", "first_name"), str(a, "lastName", "last_name")].filter(Boolean).join(" ");
  const [firstName, ...rest] = (named || order.customerName || "Customer").split(/\s+/);
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
      `The order's phone number, ${raw}, isn't a 10-digit Indian mobile number, which the courier needs for the pickup. Add one on the return, then book again.`,
    );
  }
  return {
    firstName,
    lastName: rest.join(" "),
    address1,
    address2: str(a, "address2") ?? "",
    city,
    state: str(a, "province") ?? stateName(str(a, "provinceCode", "province_code")) ?? "",
    country:
      str(a, "country") ?? countryName(str(a, "countryCodeV2", "country_code", "countryCode")) ?? "India",
    pincode,
    phone,
    email: order.email,
  };
};

export interface DestinationLike {
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string | null;
  zip: string | null;
  countryCode: string;
  phone: string | null;
}

/** Where the parcel is going: the destination given, else the store default. */
export const destinationParty = async (
  merchantId: string,
  destination: DestinationLike | null,
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
      `Give the return destination "${d.name}" a 10-digit Indian mobile number — the courier needs one for the delivery.`,
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
