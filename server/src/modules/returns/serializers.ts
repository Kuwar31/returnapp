import type {
  ExchangeItem,
  OrderLineItem,
  ReturnEvent,
  ReturnLineItem,
  ReturnReason,
  ReturnRequest,
  ReturnShipment,
} from "@prisma/client";
import { serializeMoney } from "../../lib/money.js";
import { STATUS_LABELS } from "./status.js";

type FullReturn = ReturnRequest & {
  lineItems: Array<
    ReturnLineItem & {
      reason: ReturnReason | null;
      orderLineItem: OrderLineItem | null;
    }
  >;
  exchangeItems?: ExchangeItem[];
  shipment?: ReturnShipment | null;
  events?: ReturnEvent[];
};

/**
 * Prisma Decimals serialize to strings by default, which quietly breaks
 * arithmetic on the client. Every response goes through these.
 */
export const serializeReturn = (request: FullReturn) => ({
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
  currency: request.currency,
  totals: {
    itemsSubtotal: serializeMoney(request.itemsSubtotal),
    bonusCredit: serializeMoney(request.bonusCredit),
    restockingFee: serializeMoney(request.restockingFee),
    shippingFee: serializeMoney(request.shippingFee),
    estimatedTotal: serializeMoney(request.estimatedTotal),
    settledTotal: serializeMoney(request.settledTotal),
  },
  submittedAt: request.submittedAt,
  reviewedAt: request.reviewedAt,
  receivedAt: request.receivedAt,
  resolvedAt: request.resolvedAt,
  lineItems: request.lineItems.map((item) => ({
    id: item.id,
    orderLineItemId: item.orderLineItemId,
    title: item.orderLineItem?.title ?? "",
    variantTitle: item.orderLineItem?.variantTitle ?? null,
    imageUrl: item.orderLineItem?.imageUrl ?? null,
    sku: item.orderLineItem?.sku ?? null,
    quantity: item.quantity,
    unitPrice: serializeMoney(item.unitPrice),
    lineTotal: serializeMoney(item.lineTotal),
    reasonCode: item.reason?.code ?? null,
    reasonLabel: item.reason?.label ?? null,
    reasonNote: item.reasonNote,
    photoUrls: item.photoUrls,
    inspection: item.inspection,
  })),
  exchangeItems:
    request.exchangeItems?.map((item) => ({
      id: item.id,
      title: item.title,
      variantTitle: item.variantTitle,
      imageUrl: item.imageUrl,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: serializeMoney(item.unitPrice),
      priceDifference: serializeMoney(item.priceDifference),
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
});

/** Trimmed shape for the admin list view. */
export const serializeReturnSummary = (
  request: ReturnRequest & { lineItems: ReturnLineItem[] },
) => ({
  id: request.id,
  reference: request.reference,
  status: request.status,
  statusLabel: STATUS_LABELS[request.status],
  resolution: request.resolution,
  customerEmail: request.customerEmail,
  customerName: request.customerName,
  currency: request.currency,
  estimatedTotal: serializeMoney(request.estimatedTotal),
  itemCount: request.lineItems.reduce((sum, i) => sum + i.quantity, 0),
  submittedAt: request.submittedAt,
});
