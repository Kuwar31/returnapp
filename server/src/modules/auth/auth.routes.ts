import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { unauthorized } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { signAdminToken } from "../../lib/tokens.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";

export const authRouter = Router();

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
    const user = await prisma.user.findFirst({
      where: { email },
      include: { merchant: true },
    });

    // Hash a dummy value when the user is missing so a wrong email and a wrong
    // password take the same amount of time.
    const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinva";
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok || user.merchant.status !== "ACTIVE") {
      throw unauthorized("That email and password don't match.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signAdminToken({
      sub: user.id,
      merchantId: user.merchantId,
      role: user.role,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      merchant: {
        id: user.merchant.id,
        name: user.merchant.name,
        slug: user.merchant.slug,
        currency: user.merchant.currency,
      },
    });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.admin!.sub },
      include: { merchant: true },
    });
    if (!user) throw unauthorized();

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      merchant: {
        id: user.merchant.id,
        name: user.merchant.name,
        slug: user.merchant.slug,
        currency: user.merchant.currency,
      },
    });
  }),
);
