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
  | "EXCHANGE"
  | "INSTANT_EXCHANGE"
  | "WARRANTY";

export interface PortalConfig {
  merchant: { slug: string; name: string; currency: string };
  branding: {
    headline: string;
    subheadline: string;
    logoUrl: string | null;
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
}

export interface ReturnReasonOption {
  code: string;
  label: string;
  requiresNote: boolean;
  requiresPhoto: boolean;
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
    returnShippingFee: number;
    waiveShippingOnCredit: boolean;
  };
  reasons: ReturnReasonOption[];
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

export interface Quote {
  itemsSubtotal: number;
  bonusCredit: number;
  restockingFee: number;
  shippingFee: number;
  estimatedTotal: number;
  amountDue: number;
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
    shippingFee: number;
    estimatedTotal: number;
    settledTotal: number | null;
  };
  submittedAt: string;
  reviewedAt: string | null;
  receivedAt: string | null;
  resolvedAt: string | null;
  lineItems: Array<{
    id: string;
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
  }>;
  events: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
  }>;
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
