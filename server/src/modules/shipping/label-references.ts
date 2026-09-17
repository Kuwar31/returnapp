/**
 * Label references — AfterShip's "Customize label references": up to three
 * fields printed in a label's reference slots, for carriers that have
 * them, so a warehouse can read what a parcel is before opening it.
 */

export type LabelReferenceType = "RMA_ID" | "ORDER_NUMBER" | "PRODUCT_TITLE" | "RETURN_VALUE" | "CUSTOM";

export interface LabelReference {
  type: LabelReferenceType;
  /** CUSTOM only. */
  text?: string;
}

export const LABEL_REFERENCE_TYPES: LabelReferenceType[] = ["RMA_ID", "ORDER_NUMBER", "PRODUCT_TITLE", "RETURN_VALUE", "CUSTOM"];
export const MAX_LABEL_REFERENCES = 3;

/** What was stored, checked, since it's JSON. */
export const readLabelReferences = (value: unknown): LabelReference[] => {
  if (!Array.isArray(value)) return [];
  const out: LabelReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    if (typeof type !== "string" || !LABEL_REFERENCE_TYPES.includes(type as LabelReferenceType)) continue;
    const text = (item as { text?: unknown }).text;
    out.push({ type: type as LabelReferenceType, ...(typeof text === "string" && text.trim() ? { text: text.trim().slice(0, 35) } : {}) });
    if (out.length === MAX_LABEL_REFERENCES) break;
  }
  return out;
};

/** The references as text, in order, for a return. Empty when none are set. */
export const renderLabelReferences = (
  references: LabelReference[],
  request: {
    reference: string;
    currency: string;
    itemsSubtotal: { toString(): string } | number | string;
    order: { orderNumber: string };
    lineItems: Array<{ keepItem: boolean; orderLineItem: { title: string } | null }>;
  },
): string[] =>
  references
    .map((r) => {
      switch (r.type) {
        case "RMA_ID":
          return request.reference;
        case "ORDER_NUMBER":
          return `#${request.order.orderNumber}`;
        case "PRODUCT_TITLE": {
          const titles = request.lineItems.filter((l) => !l.keepItem).map((l) => l.orderLineItem?.title ?? "Item");
          return [...new Set(titles)].join(", ");
        }
        case "RETURN_VALUE":
          return `${Number(request.itemsSubtotal.toString()).toFixed(2)} ${request.currency}`;
        case "CUSTOM":
          return r.text ?? "";
      }
    })
    .map((s) => s.trim().slice(0, 35))
    .filter(Boolean);
