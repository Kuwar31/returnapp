import type { PackingSlipBarcode, Prisma } from "@prisma/client";
import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { safeEqual } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { getSettings } from "../shipping/shipping.settings.js";
import { serializeAddress } from "./serializers.js";

/**
 * The packing slip: a printable page the shopper puts in the parcel, with
 * the items coming back and a barcode the warehouse scans — Loop's
 * "Generate packing slips". Whether one exists, and what it shows, comes
 * from the return's regional policy, else the store's shipping settings.
 *
 * Reached from the status page and the return page by a signed link, the
 * way labels are, since neither a shopper's nor a merchant's session can
 * open a new tab with a header.
 */

export interface PackingSlipSettings {
  packingSlips: boolean;
  packingSlipTaxInclusive: boolean;
  packingSlipBarcode: boolean;
  packingSlipBarcodeSource: PackingSlipBarcode;
}

const settingsFor = async (merchantId: string, region: PackingSlipSettings | null): Promise<PackingSlipSettings> =>
  region ?? (await getSettings(merchantId));

const signature = (returnId: string) =>
  createHmac("sha256", env.JWT_SECRET).update(`packing-slip:${returnId}`).digest("hex").slice(0, 32);

const packingSelect = {
  packingSlips: true,
  packingSlipTaxInclusive: true,
  packingSlipBarcode: true,
  packingSlipBarcodeSource: true,
} as const;

/**
 * The slip's link for a live return whose policy makes one; null when the
 * return has nothing to pack — cancelled, expired, or a green return.
 */
export const packingSlipUrlFor = async (merchantId: string, returnId: string): Promise<string | null> => {
  const request = await prisma.returnRequest.findFirst({
    where: { id: returnId, merchantId },
    select: { status: true, returnMethod: true, regionalPolicy: { select: packingSelect } },
  });
  if (!request) return null;
  if (["CANCELLED", "EXPIRED"].includes(request.status) || request.returnMethod === "KEEP") return null;
  const settings = await settingsFor(merchantId, request.regionalPolicy);
  if (!settings.packingSlips) return null;
  // The store says which return methods get a slip; a return with no method counts as a label one.
  const store = await getSettings(merchantId);
  if (!store.packingSlipMethods.includes(request.returnMethod ?? "LABEL")) return null;
  return `${env.APP_URL.replace(/\/+$/, "")}/api/shipping/packing-slip/${returnId}?sig=${signature(returnId)}`;
};

// ---------------------------------------------------------------------------
// Code 128, subset B — the barcode the warehouse scanner reads
// ---------------------------------------------------------------------------

/** Bar and space widths for values 0–106; the stop pattern has a seventh bar. */
const CODE128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

/** The symbol values for `text`, checksum included, or null for characters subset B can't carry. */
export const code128Values = (text: string): number[] | null => {
  const values = [START_B];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return null;
    values.push(code - 32);
  }
  const check = values.reduce((sum, v, i) => sum + v * Math.max(i, 1), 0) % 103;
  return [...values, check, STOP];
};

/** The barcode as an SVG, bars only; the text goes under it in HTML. */
export const code128Svg = (text: string, height = 56): string | null => {
  const values = code128Values(text);
  if (!values) return null;
  const rects: string[] = [];
  let x = 10; // quiet zone
  for (const value of values) {
    const widths = CODE128[value];
    for (let i = 0; i < widths.length; i++) {
      const w = Number(widths[i]);
      if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
      x += w;
    }
  }
  const width = x + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * 2}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="${escape(text)}">${rects.join("")}</svg>`;
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const escape = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (value: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};

const slipInclude = {
  order: true,
  merchant: { select: { name: true } },
  lineItems: { include: { orderLineItem: true } },
  regionalPolicy: { select: { ...packingSelect, destination: true } },
  routingRule: { select: { methods: { where: { kind: "LABEL" }, select: { destination: true } } } },
} satisfies Prisma.ReturnRequestInclude;

/** The slip as HTML, or null when the link is wrong or the policy makes none. */
export const packingSlipHtml = async (returnId: string, sig: string | undefined): Promise<string | null> => {
  if (!sig || !safeEqual(sig, signature(returnId))) return null;
  const request = await prisma.returnRequest.findUnique({ where: { id: returnId }, include: slipInclude });
  if (!request) return null;
  const settings = await settingsFor(request.merchantId, request.regionalPolicy);
  if (!settings.packingSlips) return null;
  const shipping = await getSettings(request.merchantId);
  const destination =
    request.routingRule?.methods[0]?.destination ??
    request.regionalPolicy?.destination ??
    shipping.destination ??
    (await prisma.returnDestination.findFirst({ where: { merchantId: request.merchantId, isDefault: true } })) ??
    (await prisma.returnDestination.findFirst({ where: { merchantId: request.merchantId } }));

  const currency = request.currency;
  const taxesIn = request.order.taxesIncluded;
  const inclusive = settings.packingSlipTaxInclusive;
  /** The unit price as the slip should show it: with tax, or without, whichever way the store prices. */
  const unitShown = (price: number, tax: number) =>
    taxesIn === inclusive ? price : inclusive ? price + tax : Math.max(price - tax, 0);

  const items = request.lineItems
    .filter((line) => !line.keepItem)
    .map((line) => {
      const product = line.orderLineItem;
      const unit = unitShown(Number(line.unitPrice), Number(product?.unitTax ?? 0));
      return {
        title: product?.title ?? "Item",
        variant: product?.variantTitle ?? "",
        sku: product?.sku ?? "",
        quantity: line.quantity,
        unit,
        total: unit * line.quantity,
      };
    });
  const total = items.reduce((sum, i) => sum + i.total, 0);

  const barcodeText = settings.packingSlipBarcode
    ? settings.packingSlipBarcodeSource === "ORDER_NUMBER"
      ? request.order.orderNumber
      : request.reference
    : null;
  const barcode = barcodeText ? code128Svg(barcodeText) : null;

  const shopper = serializeAddress(request.order.shippingAddress);
  const shipTo = destination
    ? [destination.name, destination.address1, destination.address2, [destination.city, destination.province, destination.zip].filter(Boolean).join(" "), destination.countryCode]
    : [];
  const placed = request.order.placedAt.toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packing slip · ${escape(request.reference)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 24px; font: 14px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; background: #fff; }
  .slip { max-width: 720px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 14px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .store { font-size: 16px; font-weight: 600; }
  .meta { text-align: right; font-size: 13px; color: #333; }
  .meta strong { color: #111; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 22px 0; }
  .cols h2 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #666; }
  address { font-style: normal; white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #666; border-bottom: 1px solid #111; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .muted { color: #666; font-size: 13px; }
  tfoot td { border-bottom: 0; font-weight: 600; }
  .barcode { margin: 28px auto 0; text-align: center; }
  .barcode svg { max-width: 100%; height: 56px; }
  .barcode div { font-family: ui-monospace, Menlo, monospace; letter-spacing: .12em; margin-top: 4px; }
  .note { margin-top: 26px; font-size: 13px; color: #444; }
  .print { position: fixed; top: 14px; right: 14px; padding: 9px 16px; border: 0; border-radius: 8px; background: #111; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  @media print { .print { display: none; } body { padding: 0; } }
  @page { margin: 16mm; }
</style>
</head>
<body>
<button class="print" type="button" onclick="window.print()">Print</button>
<div class="slip">
  <div class="top">
    <div>
      <h1>Packing slip</h1>
      <div class="store">${escape(request.merchant.name)}</div>
    </div>
    <div class="meta">
      <div><strong>Return</strong> ${escape(request.reference)}</div>
      <div><strong>Order</strong> #${escape(request.order.orderNumber)}</div>
      <div><strong>Ordered</strong> ${escape(placed)}</div>
    </div>
  </div>

  <div class="cols">
    <div>
      <h2>From</h2>
      <address>${escape([shopper?.name ?? request.customerName, ...(shopper?.lines ?? [])].filter(Boolean).join("\n") || request.customerEmail)}</address>
    </div>
    <div>
      <h2>Ship to</h2>
      <address>${escape(shipTo.filter(Boolean).join("\n") || "See your return label")}</address>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Item</th><th>SKU</th><th class="num">Qty</th><th class="num">Price${inclusive ? "" : " (ex. tax)"}</th><th class="num">Total</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (i) => `<tr>
        <td>${escape(i.title)}${i.variant ? `<div class="muted">${escape(i.variant)}</div>` : ""}</td>
        <td class="muted">${escape(i.sku)}</td>
        <td class="num">${i.quantity}</td>
        <td class="num">${escape(money(i.unit, currency))}</td>
        <td class="num">${escape(money(i.total, currency))}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
    <tfoot>
      <tr><td colspan="4">Total${inclusive ? " (incl. tax)" : " (ex. tax)"}</td><td class="num">${escape(money(total, currency))}</td></tr>
    </tfoot>
  </table>

  ${barcode ? `<div class="barcode">${barcode}<div>${escape(barcodeText)}</div></div>` : ""}

  <p class="note">Put this slip inside the parcel with the items above, then attach the return label to the outside.</p>
</div>
</body>
</html>`;
};
