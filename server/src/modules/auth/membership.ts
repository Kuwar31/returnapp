import { prisma } from "../../lib/prisma.js";

export interface ResolvedMembership {
  merchantId: string;
  slug: string;
  role: "OWNER" | "ADMIN" | "AGENT";
}

/**
 * Which store a request acts on, and what the caller may do there.
 *
 * This is the authorisation check for every admin route, so it reads the
 * membership from the database rather than trusting anything the client sent.
 * The slug arrives in a header the browser controls; all it can do is name a
 * store, and naming one you don't belong to is indistinguishable from naming
 * one that doesn't exist.
 *
 * A short cache keeps this off the hot path — it runs on every admin request,
 * and a round trip to the database for a row that changes when someone is
 * invited or removed isn't worth paying for each time. The cost is that
 * revoking access takes up to the TTL to bite, which is why it is seconds
 * rather than minutes.
 */
const TTL_MS = 15_000;

const cache = new Map<
  string,
  { value: ResolvedMembership | null; expires: number }
>();

export const resolveMembership = async (
  userId: string,
  slug: string | null,
): Promise<ResolvedMembership | null> => {
  const key = `${userId}:${slug ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      merchant: { status: "ACTIVE", ...(slug ? { slug } : {}) },
    },
    include: { merchant: { select: { id: true, slug: true } } },
    /**
     * With no slug, fall back to the oldest membership. Requests that aren't
     * about a particular store still need one resolved — /auth/me is the main
     * case, and it is what the client calls before it knows any slugs at all.
     */
    orderBy: { createdAt: "asc" },
  });

  const value: ResolvedMembership | null = membership
    ? {
        merchantId: membership.merchantId,
        slug: membership.merchant.slug,
        role: membership.role,
      }
    : null;

  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
};

/** Called when a membership is granted, so a new store is reachable at once. */
export const clearMembershipCache = (userId?: string): void => {
  if (!userId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) cache.delete(key);
  }
};
