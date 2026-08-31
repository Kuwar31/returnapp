import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { unauthorized } from "../../lib/errors.js";
import { portalUrl } from "../../lib/portal-links.js";
import { prisma } from "../../lib/prisma.js";
import { signAdminToken } from "../../lib/tokens.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";

export const authRouter = Router();

const serializeMerchant = (m: {
  id: string;
  name: string;
  slug: string;
  currency: string;
}) => ({
  id: m.id,
  name: m.name,
  slug: m.slug,
  currency: m.currency,
  // Carried on the session so any screen can offer the link without a fetch of
  // its own, and so the store switcher can tell two same-named stores apart.
  portalUrl: portalUrl(m.slug),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  rateLimit({ windowMs: 15 * 60_000, max: 10 }),
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          include: { merchant: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    // Hash a dummy value when the user is missing so a wrong email and a wrong
    // password take the same amount of time.
    const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(password, hash);

    /**
     * A live store is part of the credential check, not a separate error.
     * Saying "your password is right but you have no stores" tells an attacker
     * the password was right.
     */
    const usable = (user?.memberships ?? []).filter(
      (m) => m.merchant.status === "ACTIVE",
    );
    if (!user || !ok || usable.length === 0) {
      throw unauthorized("That email and password don't match.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Oldest membership by default — for almost everyone that is their only
    // store, and for the rest it is the one they set up first.
    const active = usable[0];

    res.json({
      // Names the person only; which store they're looking at is decided by
      // the URL they're on, one request at a time.
      token: signAdminToken({ sub: user.id }),
      user: { id: user.id, email: user.email, name: user.name, role: active.role },
      merchant: serializeMerchant(active.merchant),
      /** Everything this account can reach, so the client can offer a switch. */
      stores: usable.map((m) => ({
        ...serializeMerchant(m.merchant),
        role: m.role,
      })),
    });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.admin!.sub },
      include: {
        memberships: {
          include: { merchant: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!user) throw unauthorized();

    const usable = user.memberships.filter(
      (m) => m.merchant.status === "ACTIVE",
    );
    /**
     * "Who am I", not "where am I" — the client calls this before it knows any
     * slugs, and it is the list of stores that tells it where it may go. The
     * active membership is whichever requireAuth settled on, which without a
     * store header is the oldest one.
     */
    const active = usable.find((m) => m.merchantId === req.admin!.merchantId);
    if (!active) throw unauthorized("You no longer have access to that store.");

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: active.role },
      merchant: serializeMerchant(active.merchant),
      stores: usable.map((m) => ({
        ...serializeMerchant(m.merchant),
        role: m.role,
      })),
    });
  }),
);

/**
 * There is deliberately no /switch any more.
 *
 * Moving between stores used to mean trading the token in for one issued
 * against a different merchant. Now the store rides on each request, taken
 * from the URL, so switching is a link — nothing to exchange, nothing global to
 * mutate, and two tabs can sit on two different stores at once.
 */
