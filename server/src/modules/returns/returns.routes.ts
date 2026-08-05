import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { serializeReturn, serializeReturnSummary } from "./serializers.js";
import * as returnsService from "./returns.service.js";

export const returnsRouter = Router();

const listQuerySchema = z.object({
  status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "APPROVED",
      "REJECTED",
      "IN_TRANSIT",
      "RECEIVED",
      "RESOLVED",
      "CANCELLED",
      "EXPIRED",
    ])
    .optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

returnsRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;
    const result = await returnsService.listReturns(req.admin!.merchantId, query);
    res.json({
      ...result,
      items: result.items.map(serializeReturnSummary),
    });
  }),
);

returnsRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    res.json(await returnsService.getDashboardStats(req.admin!.merchantId));
  }),
);

returnsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const request = await returnsService.getReturn(
      req.admin!.merchantId,
      req.params.id,
    );
    res.json(serializeReturn(request));
  }),
);

returnsRouter.post(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const updated = await returnsService.approveReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated));
  }),
);

const rejectSchema = z.object({
  reason: z.string().trim().min(1, "Tell the customer why").max(500),
});

returnsRouter.post(
  "/:id/reject",
  validate(rejectSchema),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.rejectReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.reason,
    );
    res.json(serializeReturn(updated));
  }),
);

returnsRouter.post(
  "/:id/receive",
  asyncHandler(async (req, res) => {
    const updated = await returnsService.markReceived(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated));
  }),
);

// Paying out money is owner/admin territory.
returnsRouter.post(
  "/:id/resolve",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.resolveReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated));
  }),
);

const noteSchema = z.object({
  message: z.string().trim().min(1).max(1000),
});

returnsRouter.post(
  "/:id/notes",
  validate(noteSchema),
  asyncHandler(async (req, res) => {
    const event = await returnsService.addNote(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.message,
    );
    res.status(201).json({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    });
  }),
);
