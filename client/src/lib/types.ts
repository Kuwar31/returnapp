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
  merchant: {
    slug: string;
    name: string;
    currency: string;
    /** Whether the recommendation screen runs before the resolution choice. */
    aiExchange: boolean;
  };
  branding: PortalBranding;
}

/** One recommended replacement, and where it came from. */
export interface ExchangeRecommendation extends ExchangeProduct {
  /** The exchange group it was drawn from, when one applies. */
  ruleId: string | null;
  /** How the group settles the price gap; DIFFERENCE when no group. */
  pricing: "EVEN" | "DIFFERENCE";
  /** The item being returned itself, offered in its other options. */
  sameProduct: boolean;
  /** The option to open on — the one that answers the reason, when one does. */
  recommendedVariantId: string | null;
  /** Why that option, for the line under the card. Null when it's a guess. */
  rationale: {
    kind: "SIZE_UP" | "SIZE_DOWN" | "SHORTER" | "LONGER" | "COLOR" | "REPLACEMENT" | "HISTORY";
    from?: string;
  } | null;
}

export interface ExchangeRecommendations {
  /** Best first; the shopper can step through the rest. */
  candidates: ExchangeRecommendation[];
  /** The variant they already own, never offered back to them. */
  currentVariantId: string | null;
}

/** A detail from the order a shopper can prove it's theirs with. */
export type LookupCriterion = "EMAIL" | "ZIP" | "PHONE";

/** Everything a merchant can change about how their portal looks and reads. */
export interface PortalBranding {
  headline: string;
  subheadline: string;
  logoUrl: string | null;
  /** A second wordmark for white cards, where a pale logo would vanish. */
  lightLogoUrl: string | null;
  logoWidth: number;
  faviconUrl: string | null;
  /** Full-bleed backdrop; null falls back to the background colour. */
  heroImageUrl: string | null;
  accentColor: string;
  backgroundColor: string;
  textTone: "DARK" | "LIGHT";
  cornerRadius: "SHARP" | "CURVED" | "ROUNDED";
  headingFont: string;
  headingColor: string;
  bodyFont: string;
  bodyColor: string;
  /** Null means the accent colour. */
  buttonColor: string | null;
  buttonTextColor: string;
  suggestionColor: string;
  /**
   * What the shopper enters beside their order number. Several means one
   * field that accepts any of them, not one field each.
   */
  lookupCriteria: LookupCriterion[];
  orderNumberLabel: string;
  emailLabel: string;
  zipLabel: string;
  phoneLabel: string;
  lookupHelpText: string | null;
  startButtonLabel: string;
  footerHeading: string | null;
  footerText: string | null;
  supportEmail: string | null;
  policyUrl: string | null;
  /** Recommendation-screen copy; null falls back to the app's translation. */
  aiSwitchLabel: string | null;
  aiDetailsTitle: string | null;
  aiSimilarTitle: string | null;
  aiPriceCaption: string | null;
  aiPrimaryLabel: string | null;
  aiSecondaryLabel: string | null;
  searchEngineVisible: boolean;
  /** BCP-47 code for the language the app's own strings render in. */
  locale: string;
}

export interface EligibleLineItem {
  id: string;
  title: string;
  variantTitle: string | null;
  /**
   * Display-ready variant, e.g. "Size: 37". Shopify's variantTitle is only the
   * value, which renders as a bare "1" with nothing saying what it measures.
   */
  variantLabel?: string | null;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  currency: string;
  returnableQuantity: number;
  eligible: boolean;
  ineligibleReason: string | null;
  /**
   * The same reason as a translation key, so the portal can say it in the
   * shopper's language. The English above is what the admin shows.
   */
  ineligibleCode: string | null;
  ineligibleVars: Record<string, string | number> | null;
  /** What this item may become — narrower than the order's when tagged. */
  allowedResolutions: ResolutionType[];
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
    /** Where the order shipped, and where a replacement will go. */
    shippingAddress?: PostalAddress | null;
  };
  policy: {
    windowDays: number;
    bonusCreditPercent: number;
    restockingFeePercent: number;
  };
  reasonGroups: ReasonGroup[];
  /** How a size swap's price gap is settled, for what the picker promises. */
  variantExchangeDifference?: VariantExchangeDifference;
  /**
   * The store's "shop now" offer, already in this order's display currency.
   * `enabled: false` on its own when the merchant has it switched off.
   */
  shopNow?:
    | { enabled: false }
    | { enabled: true; mode: ShopNowMode; bonus: number; currency: string };
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
  /**
   * What the replacements cost. Server-reported rather than added up from the
   * browser's own copy of the prices, which can be stale.
   */
  purchaseSubtotal: number;
  /** What the store covered so the shopper didn't have to. Zero unless absorbing. */
  absorbedDifference: number;
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
  product: {
    id: string;
    title: string;
    /** Every shot of the product, hero first, for the swap screen's gallery. */
    images: string[];
  } | null;
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

/**
 * "Advanced exchanges": the lists a returned item may be swapped into, when
 * the merchant has narrowed them. Null when no rule applies, which means the
 * whole catalogue is on offer.
 */
export interface AdvancedExchange {
  /** Every group that matched — all of them are offered. */
  ruleIds: string[];
  showProductTitles: boolean;
  currency: string;
  /** One option per matching exchange group, in the merchant's order. */
  options: Array<{
    /** The group's id; sent back with a pick so the server prices it. */
    id: string;
    /** The group's name, as the shopper reads it. */
    label: string;
    /** EVEN settles any price gap flat; DIFFERENCE charges or credits it. */
    pricing: "EVEN" | "DIFFERENCE";
    /** Whether the shopper may leave a note with the pick. */
    allowNote: boolean;
    /** A few real products, so the card shows what's behind it. */
    preview: Array<{ id: string; title: string; imageUrl: string | null }>;
  }>;
}

/** One of the merchant's collections, for the browse rail. */
export interface ExchangeCollection {
  id: string;
  title: string;
}

export interface ExchangeProduct {
  id: string;
  title: string;
  /** Plain-text description, capped, for the recommendation card. */
  description?: string | null;
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
  /**
   * The region's own return steps and destination, on the shopper's status
   * page. Empty and null when no regional policy set them.
   */
  instructions?: string[];
  returnTo?: { name: string; lines: string[] } | null;
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
    /** Where it goes back on the shelf; null means the store's default. */
    restockLocationId: string | null;
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
    /** Settled flat by the exchange group it came through. */
    evenExchange: boolean;
    /** What the shopper wrote with the pick, when the group allowed it. */
    note: string | null;
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
  orderNumber: string | null;
  shopNow: boolean;
  flagged: boolean;
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
  /** How many rows each status tab would show under the other filters. */
  counts?: Record<string, number>;
}

export interface AdminSession {
  user: { id: string; email: string; name: string | null; role: string };
  merchant: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    /** Shareable portal address; see StoreSettings.portalUrl. */
    portalUrl: string;
  };
  /**
   * Every store this account can reach, with the role held at each. One person
   * often runs several Shopify stores; role is per store, so the same login can
   * own one and assist on another.
   */
  stores?: Array<{
    id: string;
    name: string;
    slug: string;
    currency: string;
    portalUrl: string;
    role: string;
  }>;
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

/** Where a shopper spends their return credit under "shop now". */
export type ShopNowMode = "RETURNS_PAGE" | "STOREFRONT";

/**
 * How a price gap between two variants of the same product is settled.
 *
 * The gap is often not a real difference: the returned line was charged at the
 * order's own exchange rate while the catalogue is priced at today's, so the
 * same item in another size can look worth a little more or less than itself.
 */
/** How a credit bonus is expressed: a share of the return, or a flat sum. */
export type BonusType = "PERCENT" | "FIXED";

export type VariantExchangeDifference =
  | "SAME_PRICE_ONLY"
  | "CHARGE"
  | "ABSORB";

/** One lifecycle email, as the settings page describes it. */
export interface NotificationSetting {
  kind:
    | "SUBMITTED"
    | "APPROVED"
    | "EDITED"
    | "DECLINED"
    | "REMINDER"
    | "EXPIRING"
    | "EXPIRED"
    | "RECEIVED"
    | "RESOLVED";
  label: string;
  description: string;
  enabled: boolean;
}

export interface NotificationSender {
  name: string;
  /** The platform's verified address. Shown, not editable — see the panel. */
  address: string;
  replyTo: string | null;
}

export interface NotificationSettings {
  notifications: NotificationSetting[];
  sender: NotificationSender;
}

export interface StoreSettings {
  name: string;
  slug: string;
  shopNowEnabled: boolean;
  shopNowMode: ShopNowMode;
  /** A flat sweetener on top of the policy's percentage. Null for none. */
  shopNowBonusAmount: number | null;
  shopNowBonusType: BonusType;
  /** Null falls back to the policy's percentage below. */
  exchangeBonusValue: number | null;
  exchangeBonusType: BonusType;
  variantExchangeDifference: VariantExchangeDifference;
  /**
   * The full, shareable portal address. Built server-side from
   * PORTAL_BASE_URL: the admin can be open somewhere the portal isn't served
   * from, so the client must not assemble this from its own origin.
   */
  portalUrl: string;
  /**
   * The same portal through Shopify's app proxy, so it renders inside the
   * store's own theme. Null until a Shopify store is connected.
   */
  storefrontUrl: string | null;
  /** The merchant's own books — what every figure is stored in. */
  currency: string;
  displayCurrency: DisplayCurrency;
  /** What PRESENTMENT resolves to, from the most recent order that has one. */
  presentmentCurrency: string | null;
  exchangeMethod: ExchangeMethod;
  /**
   * Where returned stock goes back on the shelf by default. A Shopify
   * Location id; null means wherever each order was fulfilled from.
   */
  restockLocationId: string | null;
  /** The recommendation screen after a shopper gives their reason. */
  aiExchangeEnabled: boolean;
  /** Shopify Locations whose stock counts for exchanges; empty means all. */
  inventoryLocationIds?: string[];
}

/** A place the store keeps stock, as Shopify lists it. */
export interface ShopLocation {
  id: string;
  name: string;
  fulfillsOnlineOrders: boolean;
  /** The postal address on one line; null when Shopify holds none. */
  address?: string | null;
}

export interface ShopLocations {
  locations: ShopLocation[];
  /** The store's default restock location; null means "where it shipped from". */
  defaultLocationId: string | null;
}

// ---------------------------------------------------------------------------
// Return policies — per-region overlays on the store policy
// ---------------------------------------------------------------------------

export type WindowStart = "ORDER_DATE" | "FULFILLMENT" | "DELIVERY";

/** The outcomes a regional policy decides; an instant exchange follows EXCHANGE. */
export type OutcomeKey = "REFUND" | "EXCHANGE" | "STORE_CREDIT" | "GIFT_CARD";

/**
 * How a handling fee is worked out. FLAT is once per return; PERCENT a share
 * of each item; PRODUCT_TAG reads the amount from the returned products' own
 * tags, once per return, with `value` as the fallback for untagged items.
 */
export type FeeType = "FLAT" | "PERCENT" | "PRODUCT_TAG";

export interface RegionalOutcome {
  enabled: boolean;
  /** Days from the start event; null is an unlimited window. */
  windowDays: number | null;
  /** Null charges nothing for this outcome. */
  fee: { type: FeeType; value: number } | null;
}

/** A place returned goods are sent — the merchant's own address. */
export interface ReturnDestination {
  id: string;
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string | null;
  zip: string | null;
  countryCode: string;
  phone: string | null;
  isDefault: boolean;
  /** The Shopify Location to restock at, when the destination is one. */
  locationId: string | null;
  /** One line, ready to print. */
  address: string;
}

export interface RegionalPolicy {
  id: string;
  /** Internal; shoppers never see it. */
  name: string;
  /** ISO 3166-1 alpha-2 codes of the countries this policy covers. */
  countries: string[];
  /** Where returns go; null means the store's default destination. */
  destinationId: string | null;
  /** Shopify Locations whose stock counts for exchanges; empty defers to the store's. */
  inventoryLocationIds: string[];
  allowInstantExchange: boolean;
  allowAdvancedExchange: boolean;
  /** The shipping line put on outbound exchange orders; null keeps the app's own. */
  exchangeShippingMethod: string | null;
  windowStartsFrom: WindowStart;
  /** Approve on submission, without the store-wide threshold. */
  bypassReview: boolean;
  /** Numbered steps on the confirmation page; empty keeps the portal's wording. */
  instructions: string[];
  sortOrder: number;
  outcomes: Record<OutcomeKey, RegionalOutcome>;
}

/** The store policy the regions overlay, as much of it as the page shows. */
export interface StorePolicySummary {
  id: string;
  name: string;
  returnWindowDays: number;
  windowStartsFrom: WindowStart;
  allowRefund: boolean;
  allowStoreCredit: boolean;
  allowGiftCard: boolean;
  allowExchange: boolean;
  allowInstantExchange: boolean;
  restockingFeePercent: number;
  autoApprove: boolean;
  autoApproveUnder: number | null;
}

export interface RegionalPoliciesResponse {
  policies: RegionalPolicy[];
  /** Null only for a store that has no policy yet. */
  base: StorePolicySummary | null;
  locations: ShopLocation[];
  /** The store's default restock location; null means "where it shipped from". */
  defaultLocationId: string | null;
  /** The store-wide exchange inventory locations; empty means all. */
  inventoryLocationIds: string[];
  destinations: ReturnDestination[];
  /** The shop currency, for labelling a flat fee. */
  currency: string;
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
