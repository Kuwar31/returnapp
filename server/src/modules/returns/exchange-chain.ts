import { prisma } from "../../lib/prisma.js";

/**
 * How many exchanges an order is removed from an original purchase.
 *
 * 0 is something the shopper actually bought. 1 is the order created when they
 * exchanged it. 2 is the order created when they exchanged *that*, and so on.
 *
 * Walked rather than stored on the order, because the link already exists and
 * a stored counter is a second copy of the same fact — one that would be wrong
 * for every order created before the column did. `ExchangeDraftOrder` records
 * the Shopify order its draft became, so each step is an exact join rather
 * than a guess from tags or naming.
 *
 * Only the draft-order exchange route builds a new order. A native exchange
 * puts the replacement on the original order instead, so its generation is a
 * property of the line rather than the order, and is handled where lines are
 * evaluated.
 */
export const exchangeGeneration = async (
  merchantId: string,
  orderId: string,
): Promise<number> => {
  let currentId: string | null = orderId;
  let generation = 0;

  /**
   * A hard stop rather than a `while (true)`.
   *
   * The chain is data a merchant's own actions build, and a cycle — however it
   * arose — would otherwise hang the request that asked. Ten is far past any
   * real exchange chain, so hitting it means something is wrong, and the safe
   * answer to "how deep is this" is "deeper than any limit you set".
   */
  const MAX_DEPTH = 10;

  while (currentId && generation < MAX_DEPTH) {
    const order: { externalId: string | null } | null =
      await prisma.order.findFirst({
        where: { id: currentId, merchantId },
        select: { externalId: true },
      });
    if (!order?.externalId) return generation;

    const draft: { returnRequest: { orderId: string } } | null =
      await prisma.exchangeDraftOrder.findFirst({
        where: {
          externalOrderId: order.externalId,
          returnRequest: { merchantId },
        },
        select: { returnRequest: { select: { orderId: true } } },
      });
    // No draft produced this order, so it's where the chain started.
    if (!draft) return generation;

    generation += 1;
    currentId = draft.returnRequest.orderId;
  }

  return generation;
};

/**
 * Whether an item at this depth may be exchanged again.
 *
 * An original purchase always may. Anything further along needs the merchant
 * to have opened the chain, and stops at the limit they set — where "1" means
 * one exchange *of* an exchange, matching how the setting reads.
 */
export const canExchangeAgain = (
  generation: number,
  policy: { allowExchangeOfExchange: boolean; sequentialExchangeLimit: number | null },
): boolean => {
  if (generation <= 0) return true;
  if (!policy.allowExchangeOfExchange) return false;
  return (
    policy.sequentialExchangeLimit === null ||
    generation <= policy.sequentialExchangeLimit
  );
};
