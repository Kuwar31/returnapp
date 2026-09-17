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
  /** The state's name, as Indian carriers want it. */
  state: string;
  /** The state's code as the order had it — "KA", "CA" — for carriers abroad. */
  stateCode: string;
  country: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  pincode: string;
  phone: string;
  email: string;
  /** The business at this address, for carriers with a company line; blank for a shopper. */
  company: string;
}

/**
 * What a carrier needs of a phone number. Indian couriers dial a 10-digit
 * mobile for the pickup and refuse anything else; a drop-off label abroad
 * carries whatever number there is, or none.
 */
export type PhoneRule = "INDIAN_MOBILE" | "ANY";

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
  rule: PhoneRule,
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
  // A label that doesn't need a number goes without one.
  if (rule === "ANY") return "";
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
  rule: PhoneRule = "INDIAN_MOBILE",
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
  const raw = await shopperPhone(merchantId, order, a, rule);
  let phone: string;
  if (rule === "ANY") {
    phone = raw.replace(/[^\d+]/g, "");
  } else {
    const mobile = indianMobile(raw);
    if (!mobile) {
      throw unprocessable(
        `The order's phone number, ${raw}, isn't a 10-digit Indian mobile number, which the courier needs for the pickup. Add one on the return, then book again.`,
      );
    }
    phone = mobile;
  }
  const countryCode = str(a, "countryCodeV2", "country_code", "countryCode") ?? "IN";
  return {
    company: "",
    firstName,
    lastName: rest.join(" "),
    address1,
    address2: str(a, "address2") ?? "",
    city,
    state: str(a, "province") ?? stateName(str(a, "provinceCode", "province_code")) ?? "",
    stateCode: str(a, "provinceCode", "province_code") ?? str(a, "province") ?? "",
    country: str(a, "country") ?? countryName(countryCode) ?? "India",
    countryCode: countryCode.toUpperCase(),
    pincode,
    phone,
    email: order.email,
  };
};

export interface DestinationLike {
  name: string;
  company?: string | null;
  contactName?: string | null;
  email?: string | null;
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
  rule: PhoneRule = "INDIAN_MOBILE",
): Promise<Party> => {
  const d = destination ?? (await defaultDestination(merchantId));
  if (!d) {
    throw unprocessable(
      "Add a return destination under Return policies → Destinations first; it's where the courier delivers.",
    );
  }
  let phone: string;
  if (rule === "ANY") {
    phone = (d.phone ?? "").replace(/[^\d+]/g, "");
  } else {
    const mobile = indianMobile(d.phone);
    if (!mobile) {
      throw unprocessable(
        `Give the return destination "${d.name}" a 10-digit Indian mobile number — the courier needs one for the delivery.`,
      );
    }
    phone = mobile;
  }
  if (!d.zip) throw unprocessable(`Give the return destination "${d.name}" a postcode.`);
  return {
    // The contact on the label, else the location's name; the company beside it.
    firstName: d.contactName?.trim() || d.name,
    lastName: "",
    company: d.company?.trim() || (d.contactName?.trim() ? d.name : ""),
    address1: d.address1,
    address2: d.address2 ?? "",
    city: d.city,
    state: stateName(d.province) ?? "",
    stateCode: d.province ?? "",
    country: countryName(d.countryCode) ?? "India",
    countryCode: d.countryCode.toUpperCase(),
    pincode: d.zip,
    phone,
    email: d.email?.trim() || merchantEmail || "",
  };
};
