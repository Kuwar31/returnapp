import type { Prisma, ReturnStatus } from "@prisma/client";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { toDecimal } from "../../lib/money.js";
import { generateCreditCode } from "./reference.js";
import { assertTransition, STATUS_LABELS } from "./status.js";

const detailInclude = {
  lineItems: { include: { reason: true, orderLineItem: true } },
  exchangeItems: true,
  shipment: true,
  events: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.ReturnRequestInclude;

export const listReturns = async (
  merchantId: string,
  filters: {
    status?: ReturnStatus;
    search?: string;
    page: number;
    pageSize: number;
  },
) => {
  const where: Prisma.ReturnRequestWhereInput = {
    merchantId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search
      ? {
          OR: [
            { reference: { contains: filters.search, mode: "insensitive" } },
            { customerEmail: { contains: filters.search, mode: "insensitive" } },
            { customerName: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: { lineItems: true },
      orderBy: { submittedAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
  ]);

  return { total, items, page: filters.page, pageSize: filters.pageSize };
};

export const getReturn = async (merchantId: string, id: string) => {
  const request = await prisma.returnRequest.findFirst({
    where: { id, merchantId },
    include: detailInclude,
  });
  if (!request) throw notFound("Return request not found.");
  return request;
};

/**
 * Single entry point for status changes: validates the transition, writes the
 * new status, and appends a timeline event in one transaction.
 */
export const changeStatus = async ({
  merchantId,
  id,
  to,
  actorId,
  message,
  extraData = {},
}: {
  merchantId: string;
  id: string;
  to: ReturnStatus;
  actorId?: string;
  message?: string;
  extraData?: Prisma.ReturnRequestUpdateInput;
}) => {
  const current = await getReturn(merchantId, id);
  assertTransition(current.status, to);

  return prisma.$transaction(async (tx) => {
    // Write the event before the final read, so the returned payload already
    // contains it — the admin UI renders this response directly.
    await tx.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId: actorId ?? null,
        type: "STATUS_CHANGED",
        message: message ?? `Status changed to ${STATUS_LABELS[to]}`,
        metadata: { from: current.status, to },
      },
    });

    return tx.returnRequest.update({
      where: { id },
      data: { status: to, ...extraData },
      include: detailInclude,
    });
  });
};

export const approveReturn = (
  merchantId: string,
  id: string,
  actorId: string,
) =>
  changeStatus({
    merchantId,
    id,
    to: "APPROVED",
    actorId,
    message: "Return approved",
    extraData: { reviewedAt: new Date(), reviewedBy: { connect: { id: actorId } } },
  });

export const rejectReturn = (
  merchantId: string,
  id: string,
  actorId: string,
  reason: string,
) =>
  changeStatus({
    merchantId,
    id,
    to: "REJECTED",
    actorId,
    message: `Return declined: ${reason}`,
    extraData: {
      reviewedAt: new Date(),
      reviewedBy: { connect: { id: actorId } },
      rejectionReason: reason,
    },
  });

export const markReceived = (
  merchantId: string,
  id: string,
  actorId: string,
) =>
  changeStatus({
    merchantId,
    id,
    to: "RECEIVED",
    actorId,
    message: "Items received at the warehouse",
    extraData: { receivedAt: new Date() },
  });

/**
 * Closes out a return. Store-credit resolutions mint a credit code here;
 * refunds and exchanges will hand off to the payment/commerce integration
 * once those are wired up.
 */
export const resolveReturn = async (
  merchantId: string,
  id: string,
  actorId: string,
) => {
  const current = await getReturn(merchantId, id);
  assertTransition(current.status, "RESOLVED");

  const amount = toDecimal(current.estimatedTotal);

  // Issuing the credit and closing the return must succeed or fail together,
  // otherwise a resolved return could exist with no credit behind it.
  return prisma.$transaction(async (tx) => {
    await tx.returnEvent.create({
      data: {
        returnRequestId: id,
        actorId,
        type: "STATUS_CHANGED",
        message: `Resolved as ${current.resolution.toLowerCase().replace(/_/g, " ")}`,
        metadata: { from: current.status, to: "RESOLVED" },
      },
    });

    if (current.resolution === "STORE_CREDIT") {
      await tx.storeCredit.create({
        data: {
          merchantId,
          returnRequestId: id,
          code: generateCreditCode(),
          customerEmail: current.customerEmail,
          amount,
          balance: amount,
          currency: current.currency,
        },
      });
      await tx.returnEvent.create({
        data: {
          returnRequestId: id,
          actorId,
          type: "CREDIT_ISSUED",
          message: `Store credit issued for ${current.currency} ${amount.toFixed(2)}`,
        },
      });
    }

    return tx.returnRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), settledTotal: amount },
      include: detailInclude,
    });
  });
};

export const addNote = async (
  merchantId: string,
  id: string,
  actorId: string,
  message: string,
) => {
  await getReturn(merchantId, id);
  return prisma.returnEvent.create({
    data: { returnRequestId: id, actorId, type: "NOTE_ADDED", message },
  });
};

export const getDashboardStats = async (merchantId: string) => {
  const [byStatus, pendingValue] = await Promise.all([
    prisma.returnRequest.groupBy({
      by: ["status"],
      where: { merchantId },
      _count: { _all: true },
    }),
    prisma.returnRequest.aggregate({
      where: {
        merchantId,
        status: { in: ["SUBMITTED", "APPROVED", "IN_TRANSIT", "RECEIVED"] },
      },
      _sum: { estimatedTotal: true },
    }),
  ]);

  const counts = Object.fromEntries(
    byStatus.map((row) => [row.status, row._count._all]),
  ) as Partial<Record<ReturnStatus, number>>;

  return {
    counts: {
      submitted: counts.SUBMITTED ?? 0,
      approved: counts.APPROVED ?? 0,
      inTransit: counts.IN_TRANSIT ?? 0,
      received: counts.RECEIVED ?? 0,
      resolved: counts.RESOLVED ?? 0,
      rejected: counts.REJECTED ?? 0,
    },
    openValue: pendingValue._sum.estimatedTotal
      ? toDecimal(pendingValue._sum.estimatedTotal).toNumber()
      : 0,
  };
};
