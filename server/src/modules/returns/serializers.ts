import type {
  ExchangeDraftOrder,
  ExchangeItem,
  Order,
  OrderLineItem,
  ReturnEvent,
  ReturnFeedback,
  ReturnLineItem,
  ReturnReason,
  ReturnRequest,
  ReturnShipment,
} from "@prisma/client";
import { displayConverter, serializeMoney } from "../../lib/money.js";
import { STATUS_LABELS } from "./status.js";

type FullReturn = ReturnRequest & {
  lineItems: Array<
    ReturnLineItem & {
      reason: ReturnReason | null;
      orderLineItem: OrderLineItem | null;
    }
  >;
  order?: Order | null;
  exchangeItems?: ExchangeItem[];
  shipment?: ReturnShipment | null;
  events?: ReturnEvent[];
  feedback?: ReturnFeedback | null;
  exchangeDraft?: ExchangeDraftOrder | null;
};

/** The normalized postal address the confirmation page prints. */
export interface SerializedAddress {
  name: string | null;
  phone: string | null;
  /** Street through country, already ordered for display. */
  lines: string[];
}

/**
 * Flattens a stored shipping address into printable lines.
 *
 * Orders arrive from two places with two shapes — webhooks give REST's
 * snake_case (`address1`, `province_code`), the GraphQL backfill gives
 * camelCase — and rows predating either normalization are still in the table.
 * Reading both here keeps that mess out of the client.
 */
const serializeAddress = (value: unknown): SerializedAddress | null => {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  const str = (...keys: string[]): string | null => {
    for (const key of keys) {
      const found = a[key];
      if (typeof found === "string" && found.trim()) return found.trim();
    }
    return null;
  };

  const street = [str("address1"), str("address2")].filter(Boolean);
  const region = [
    str("city"),
    str("provinceCode", "province_code", "province"),
    str("zip", "postalCode", "postal_code"),
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [...street, region, str("country", "countryCode", "country_code")]
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) return null;

  const fullName = [str("firstName", "first_name"), str("lastName", "last_name")]
    .filter(Boolean)
    .join(" ");

  return {
    name: str("name") ?? (fullName || null),
    phone: str("phone"),
    lines,
  };
};

/**
 * Prisma Decimals serialize to strings by default, which quietly breaks
 * arithmetic on the client. Every response goes through these.
 */
export const serializeReturn = (
  request: FullReturn,
  /**
   * Which currency to render in. Storage and arithmetic are always shop
   * currency; this converts at the boundary using the order's own rate.
   */
  display: "SHOP" | "PRESENTMENT" = "SHOP",
) => {
  const fx = displayConverter(request.order, display, request.currency);
  return {
  id: request.id,
  reference: request.reference,
  status: request.status,
  statusLabel: STATUS_LABELS[request.status],
  resolution: request.resolution,
  orderId: request.orderId,
  customerEmail: request.customerEmail,
  customerName: request.customerName,
  customerNote: request.customerNote,
  rejectionReason: request.rejectionReason,
  currency: fx.currency,
  /** Always the shop currency, so the admin can say what the books hold. */
  shopCurrency: request.currency,
  totals: {
    itemsSubtotal: fx.money(request.itemsSubtotal),
    bonusCredit: fx.money(request.bonusCredit),
    restockingFee: fx.money(request.restockingFee),
    estimatedTotal: fx.money(request.estimatedTotal),
    settledTotal: fx.money(request.settledTotal),
  },
  flaggedAt: request.flaggedAt,
  flagReason: request.flagReason,
  submittedAt: request.submittedAt,
  reviewedAt: request.reviewedAt,
  receivedAt: request.receivedAt,
  resolvedAt: request.resolvedAt,
  order: request.order
    ? {
        orderNumber: request.order.orderNumber,
        placedAt: request.order.placedAt,
        shippingAddress: serializeAddress(request.order.shippingAddress),
      }
    : null,
  lineItems: request.lineItems.map((item) => ({
    id: item.id,
    orderLineItemId: item.orderLineItemId,
    /** Per-line, since one return can mix exchanges, refunds and credit. */
    resolution: item.resolution,
    title: item.orderLineItem?.title ?? "",
    variantTitle: item.orderLineItem?.variantTitle ?? null,
    imageUrl: item.orderLineItem?.imageUrl ?? null,
    sku: item.orderLineItem?.sku ?? null,
    quantity: item.quantity,
    unitPrice: fx.money(item.unitPrice),
    lineTotal: fx.money(item.lineTotal),
    reasonCode: item.reason?.code ?? null,
    reasonLabel: item.reason?.label ?? null,
    reasonNote: item.reasonNote,
    photoUrls: item.photoUrls,
    inspection: item.inspection,
    /** Null until inspected; drives the refund and the restock once set. */
    acceptedQuantity: item.acceptedQuantity,
    restock: item.restock,
    rejectionNote: item.rejectionNote,
    keepItem: item.keepItem,
  })),
  exchangeItems:
    request.exchangeItems?.map((item) => ({
      id: item.id,
      title: item.title,
      variantTitle: item.variantTitle,
      imageUrl: item.imageUrl,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: fx.money(item.unitPrice),
      priceDifference: fx.money(item.priceDifference),
    })) ?? [],
  shipment: request.shipment
    ? {
        carrier: request.shipment.carrier,
        trackingNumber: request.shipment.trackingNumber,
        trackingUrl: request.shipment.trackingUrl,
        labelUrl: request.shipment.labelUrl,
        status: request.shipment.status,
        shippedAt: request.shipment.shippedAt,
        deliveredAt: request.shipment.deliveredAt,
      }
    : null,
  events:
    request.events?.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    })) ?? [],
  feedback: request.feedback
    ? {
        easeScore: request.feedback.easeScore,
        repeatScore: request.feedback.repeatScore,
        comment: request.feedback.comment,
      }
    : null,
  exchangeDraft: request.exchangeDraft
    ? {
        name: request.exchangeDraft.name,
        status: request.exchangeDraft.status,
        /**
         * The checkout link is a bearer URL — anyone holding it can pay and
         * claim the order — so it is only ever serialized for the admin, never
         * on the shopper-facing portal responses.
         */
        invoiceUrl: request.exchangeDraft.invoiceUrl,
        /**
         * Not run through `fx` — these are stored in whatever currency the
         * customer was actually billed, which is what Shopify's invoice says.
         * Converting again would double-apply the rate.
         */
        currency: request.exchangeDraft.currency,
        itemsTotal: serializeMoney(request.exchangeDraft.itemsTotal),
        creditApplied: serializeMoney(request.exchangeDraft.creditApplied),
        balanceDue: serializeMoney(request.exchangeDraft.balanceDue),
        reservedUntil: request.exchangeDraft.reservedUntil,
        invoiceSentAt: request.exchangeDraft.invoiceSentAt,
        completedAt: request.exchangeDraft.completedAt,
      }
    : null,
  };
};

/** Trimmed shape for the admin list view. */
export const serializeReturnSummary = (
  request: ReturnRequest & { lineItems: ReturnLineItem[]; order?: Order | null },
  display: "SHOP" | "PRESENTMENT" = "SHOP",
) => {
  const fx = displayConverter(request.order, display, request.currency);
  return {
  id: request.id,
  reference: request.reference,
  status: request.status,
  statusLabel: STATUS_LABELS[request.status],
  resolution: request.resolution,
  customerEmail: request.customerEmail,
  customerName: request.customerName,
  currency: fx.currency,
  estimatedTotal: fx.money(request.estimatedTotal),
  itemCount: request.lineItems.reduce((sum, i) => sum + i.quantity, 0),
  submittedAt: request.submittedAt,
  };
};
