export type ReturnStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "IN_TRANSIT"
  | "RECEIVED"
  | "RESOLVED"
  | "CANCELLED"
  | "EXPIRED";

export type ResolutionType =
  | "REFUND"
  | "STORE_CREDIT"
  | "GIFT_CARD"
  | "EXCHANGE"
  | "INSTANT_EXCHANGE"
  | "WARRANTY";

export interface PortalConfig {
  merchant: { slug: string; name: string; currency: string };
  branding: {
    headline: string;
    subheadline: string;
    logoUrl: string | null;
    /** Full-bleed backdrop; null falls back to a plain background. */
    heroImageUrl: string | null;
    accentColor: string;
    supportEmail: string | null;
    policyUrl: string | null;
  };
}

export interface EligibleLineItem {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  currency: string;
  returnableQuantity: number;
  eligible: boolean;
  ineligibleReason: string | null;
  /** Which reason group applies to this item, by its product type. */
  reasonGroupId?: string | null;
}

export interface ReturnReasonOption {
  id: string;
  label: string;
  requiresNote: boolean;
  requiresPhoto: boolean;
  /** Sub-reasons. A parent with children isn't selectable on its own. */
  children?: ReturnReasonOption[];
}

/** One merchant-configured set of reasons, keyed to certain product types. */
export interface ReasonGroup {
  id: string;
  reasons: ReturnReasonOption[];
}

export interface OrderSession {
  order: {
    id: string;
    orderNumber: string;
    email: string;
    customerName: string | null;
    currency: string;
    placedAt: string;
  };
  policy: {
    windowDays: number;
    bonusCreditPercent: number;
    restockingFeePercent: number;
  };
  reasonGroups: ReasonGroup[];
  eligibility: {
    withinWindow: boolean;
    windowDays: number;
    windowClosesAt: string | null;
    daysRemaining: number | null;
    items: EligibleLineItem[];
    hasEligibleItems: boolean;
    allowedResolutions: ResolutionType[];
  };
}

export interface QuoteLine {
  orderLineItemId: string;
  resolution: ResolutionType;
  itemsSubtotal: number;
  bonusCredit: number;
  exchangeValue: number;
  /** What this line pays out, after its own bonus and fees. */
  credited: number;
  /** What this line adds to the amount the shopper owes. */
  due: number;
}

export interface Quote {
  currency: string;
  itemsSubtotal: number;
  bonusCredit: number;
  restockingFee: number;
  estimatedTotal: number;
  amountDue: number;
  lines: QuoteLine[];
}

/** One variant a shopper can swap into. */
export interface ExchangeVariant {
  id: string;
  title: string;
  sku: string | null;
  price: number;
  available: boolean;
  imageUrl: string | null;
  options: Array<{ name: string; value: string }>;
}

export interface ExchangeOptions {
  product: { id: string; title: string } | null;
  variants: ExchangeVariant[];
  /** The variant the shopper already owns, so the picker can mark it. */
  currentVariantId: string | null;
  /**
   * What `variants[].price` is denominated in. Catalogue prices are converted
   * server-side so they match the quote they feed into — render with this, not
   * with the order's currency.
   */
  currency: string;
}

export interface ExchangeProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  minPrice: number;
  maxPrice: number;
  currency: string;
  variants: ExchangeVariant[];
}

/** A postal address flattened server-side into printable lines. */
export interface PostalAddress {
  name: string | null;
  phone: string | null;
  lines: string[];
}

export interface ReturnDetail {
  id: string;
  reference: string;
  status: ReturnStatus;
  statusLabel: string;
  resolution: ResolutionType;
  customerEmail: string;
  customerName: string | null;
  customerNote: string | null;
  rejectionReason: string | null;
  currency: string;
  totals: {
    itemsSubtotal: number;
    bonusCredit: number;
    restockingFee: number;
    estimatedTotal: number;
    settledTotal: number | null;
    /**
     * What the shopper owes when the replacement costs more than the credit.
     * The payout floors at zero in that case, so this is the only figure that
     * says a balance is outstanding.
     */
    amountDue: number;
  };
  submittedAt: string;
  reviewedAt: string | null;
  receivedAt: string | null;
  resolvedAt: string | null;
  order: {
    orderNumber: string;
    placedAt: string;
    shippingAddress: PostalAddress | null;
  } | null;
  lineItems: Array<{
    id: string;
    /** Per-line: one return can mix exchanges, refunds and credit. */
    resolution: ResolutionType;
    title: string;
    variantTitle: string | null;
    imageUrl: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    reasonCode: string | null;
    reasonLabel: string | null;
    reasonNote: string | null;
    photoUrls: string[];
    /** Null until inspected. Drives the refund and the restock once set. */
    acceptedQuantity: number | null;
    restock: boolean;
    rejectionNote: string | null;
    /** Credited without coming back — "change to keep". */
    keepItem: boolean;
  }>;
  /** What the shopper is getting instead, for exchanged lines. */
  exchangeItems: Array<{
    id: string;
    title: string;
    variantTitle: string | null;
    imageUrl: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: number;
    priceDifference: number;
  }>;
  shipment: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    labelUrl: string | null;
    status: string;
    shippedAt: string | null;
    deliveredAt: string | null;
  } | null;
  events: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
  }>;
  feedback: {
    easeScore: number | null;
    repeatScore: number | null;
    comment: string | null;
  } | null;
  /** The Shopify draft order carrying the exchange. Admin responses only. */
  exchangeDraft: ExchangeDraft | null;
  /**
   * Where to pay a balance owed on a native exchange, which has no draft order
   * of its own. Absent whenever nothing is owed.
   */
  exchangePayment?: { url: string; amount: number; currency: string } | null;
  /** Sidebar context, present on the admin detail response only. */
  shopper?: { orderCount: number; returnCount: number };
  /** Where the payout is destined — a return can pay several ways at once. */
  payout?: Array<{ resolution: ResolutionType; amount: number }>;
  flaggedAt?: string | null;
  flagReason?: string | null;
  policyName?: string | null;
  portalSlug?: string | null;
}

export type ExchangeDraftStatus =
  | "OPEN"
  | "INVOICE_SENT"
  | "COMPLETED"
  | "CANCELLED";

export interface ExchangeDraft {
  name: string | null;
  status: ExchangeDraftStatus;
  /** Bearer checkout link — never render this on the shopper-facing portal. */
  invoiceUrl: string | null;
  currency: string;
  itemsTotal: number;
  creditApplied: number;
  balanceDue: number;
  reservedUntil: string | null;
  invoiceSentAt: string | null;
  completedAt: string | null;
}

export interface ReturnSummary {
  id: string;
  reference: string;
  status: ReturnStatus;
  statusLabel: string;
  resolution: ResolutionType;
  customerEmail: string;
  customerName: string | null;
  currency: string;
  estimatedTotal: number;
  itemCount: number;
  submittedAt: string;
}

/** What resolving a return will pay out, per Shopify. */
export interface RefundPreview {
  reference: string;
  resolution: ResolutionType;
  currency: string;
  /** Our own computed figure, always present. */
  ourEstimate: number;
  /** Shopify's authoritative figure; null for credit/exchange or if unreachable. */
  shopifyRefund: { amount: number; currency: string } | null;
  alreadyRefunded: boolean;
  inShopify: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminSession {
  user: { id: string; email: string; name: string | null; role: string };
  merchant: { id: string; name: string; slug: string; currency: string };
}

export interface DashboardStats {
  /** What openValue is denominated in — follows the display setting. */
  currency: string;
  counts: {
    submitted: number;
    approved: number;
    inTransit: number;
    received: number;
    resolved: number;
    rejected: number;
  };
  openValue: number;
}

/** How the admin and portal render money. Storage is always shop currency. */
export type DisplayCurrency = "SHOP" | "PRESENTMENT";

/**
 * Which mechanism creates the replacement for an exchange.
 *
 * DRAFT_ORDER reserves stock at approval and collects any balance through a
 * checkout link; SHOPIFY_NATIVE puts the replacement on the original order so
 * revenue nets correctly. See the ExchangeMethod enum in schema.prisma.
 */
export type ExchangeMethod = "DRAFT_ORDER" | "SHOPIFY_NATIVE";

export interface StoreSettings {
  name: string;
  slug: string;
  /** The merchant's own books — what every figure is stored in. */
  currency: string;
  displayCurrency: DisplayCurrency;
  /** What PRESENTMENT resolves to, from the most recent order that has one. */
  presentmentCurrency: string | null;
  exchangeMethod: ExchangeMethod;
}

/** Whether Shopify settled a native exchange correctly, and what can be done. */
export interface ExchangeDiagnosis {
  /**
   * UNCOMMITTED — the replacement was never processed; the app can settle it.
   * UNSETTLED   — processed without netting; needs a refund from the order,
   *               which requires a scope this app doesn't hold.
   */
  state: "NOT_APPLICABLE" | "HEALTHY" | "UNCOMMITTED" | "UNSETTLED";
  summary: string;
  refundOwed: { amount: number; currency: string } | null;
  repairable: boolean;
  shopifyReturnName: string | null;
  orderOutstanding: { amount: number; currency: string } | null;
}
