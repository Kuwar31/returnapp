import { Router } from "express";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { portalUrl } from "../../lib/portal-links.js";
import { prisma } from "../../lib/prisma.js";
import { signPortalToken } from "../../lib/tokens.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { serializeAddress } from "../returns/serializers.js";
import { syncOrderByNumber } from "../shopify/order.sync.js";

/**
 * "Find an order": the merchant's way into a shopper's return.
 *
 * A customer who writes in rather than using the portal still needs a return
 * raised, and the merchant knows only a name, an email or an order number.
 * This finds the orders and hands back a link that opens the portal already
 * signed in to one of them — for the merchant to walk through on the
 * shopper's behalf, or to send to the shopper to finish themselves.
 */
export const ordersRouter = Router();

const searchSchema = z.object({
  by: z.enum(["name", "email", "number"]),
  q: z.string().trim().min(1).max(200),
});

/** How long a link made here stays good: long enough to be emailed and opened. */
const RETURN_LINK_TTL = "7d";

/** The Shopify admin page for an order, when the store is connected. */
const shopifyOrderUrl = (
  domain: string | null,
  externalId: string | null,
): string | null => {
  const id = externalId?.split("/").pop();
  return domain && id && /^\d+$/.test(id)
    ? `https://${domain}/admin/orders/${id}`
    : null;
};

ordersRouter.get(
  "/search",
  validate(searchSchema, "query"),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const { by, q } = req.query as z.infer<typeof searchSchema>;

    /**
     * Searching by number reads Shopify first, as the portal's lookup does:
     * an order placed since the last backfill should still be findable, and
     * the number is the one thing precise enough to fetch by.
     */
    const number = q.replace(/^#/, "");
    if (by === "number") await syncOrderByNumber(merchantId, number);

    const where =
      by === "number"
        ? { orderNumber: number }
        : by === "email"
          ? { email: { contains: q, mode: "insensitive" as const } }
          : { customerName: { contains: q, mode: "insensitive" as const } };

    const [orders, merchant] = await Promise.all([
      prisma.order.findMany({
        where: { merchantId, ...where },
        orderBy: { placedAt: "desc" },
        take: 200,
        include: {
          lineItems: { select: { quantity: true } },
          returnRequests: { select: { id: true, status: true, reference: true } },
        },
      }),
      prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { domain: true },
      }),
    ]);

    /**
     * Grouped by customer, as Loop shows them: the merchant is looking for a
     * person, and one person tends to have several orders. Most recent
     * customer first, their orders newest first.
     */
    const byEmail = new Map<
      string,
      { name: string | null; email: string; orders: typeof orders }
    >();
    for (const order of orders) {
      const key = order.email.toLowerCase();
      const group = byEmail.get(key) ?? {
        name: order.customerName,
        email: order.email,
        orders: [],
      };
      if (!group.name && order.customerName) group.name = order.customerName;
      group.orders.push(order);
      byEmail.set(key, group);
    }

    res.json({
      customers: [...byEmail.values()].map((group) => ({
        name: group.name,
        email: group.email,
        orderCount: group.orders.length,
        orders: group.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          placedAt: order.placedAt,
          itemCount: order.lineItems.reduce((n, l) => n + l.quantity, 0),
          shippingAddress: serializeAddress(order.shippingAddress),
          shopifyUrl: shopifyOrderUrl(merchant.domain, order.externalId),
          /** Returns already raised on it, so the merchant isn't surprised later. */
          returns: order.returnRequests
            .filter((r) => r.status !== "CANCELLED")
            .map((r) => ({ id: r.id, reference: r.reference, status: r.status })),
        })),
      })),
    });
  }),
);

/**
 * A link that opens the portal signed in to one order, skipping the lookup.
 *
 * The same session a shopper would get by proving the order themselves —
 * scoped to that order, nothing more — so opening it lets the merchant, or
 * the shopper it's sent to, start a return exactly as the portal always
 * does. Minted fresh each time it's asked for; nothing is stored.
 */
ordersRouter.post(
  "/:id/return-link",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, merchantId },
      select: { id: true, email: true, merchant: { select: { slug: true } } },
    });
    if (!order) throw notFound("Order not found.");

    const token = signPortalToken(
      { merchantId, orderId: order.id, email: order.email },
      RETURN_LINK_TTL,
    );
    res.json({
      url: `${portalUrl(order.merchant.slug)}/start?token=${encodeURIComponent(token)}`,
      expiresInDays: 7,
    });
  }),
);
