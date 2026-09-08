import type { ReturnDestination } from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { countryName } from "./regional-policies.service.js";

/**
 * The places returned goods are sent — the merchant's own addresses, one of
 * which is the default. A regional policy points at one; a policy without
 * one, and every order no policy claims, uses the default.
 */

export interface DestinationInput {
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string | null;
  zip: string | null;
  countryCode: string;
  phone: string | null;
  isDefault?: boolean;
  /** The Shopify Location to restock at, when the destination is one. */
  locationId: string | null;
}

/** The address as lines, ready to print: street, town, country. */
export const destinationLines = (d: ReturnDestination): string[] =>
  [
    d.address1,
    d.address2,
    [d.city, d.province, d.zip].filter(Boolean).join(" "),
    countryName(d.countryCode),
  ].filter((line): line is string => Boolean(line && line.trim()));

export const serializeDestination = (d: ReturnDestination) => ({
  id: d.id,
  name: d.name,
  address1: d.address1,
  address2: d.address2,
  city: d.city,
  province: d.province,
  zip: d.zip,
  countryCode: d.countryCode,
  phone: d.phone,
  isDefault: d.isDefault,
  locationId: d.locationId,
  /** One line, for the cards and the policy editor. */
  address: destinationLines(d).join(", "),
});

export const listDestinations = (merchantId: string) =>
  prisma.returnDestination.findMany({
    where: { merchantId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

export const defaultDestination = (merchantId: string) =>
  prisma.returnDestination.findFirst({ where: { merchantId, isDefault: true } });

const scalars = (input: DestinationInput) => ({
  name: input.name,
  address1: input.address1,
  address2: input.address2,
  city: input.city,
  province: input.province,
  zip: input.zip,
  countryCode: input.countryCode,
  phone: input.phone,
  locationId: input.locationId,
});

/**
 * The first destination is the default whether or not it was asked to be:
 * a store with one address has nowhere else to send anything. Asking for
 * the default moves it; there is always exactly one.
 */
export const createDestination = async (
  merchantId: string,
  input: DestinationInput,
) => {
  const count = await prisma.returnDestination.count({ where: { merchantId } });
  const isDefault = count === 0 || input.isDefault === true;
  return prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.returnDestination.updateMany({
        where: { merchantId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.returnDestination.create({
      data: { merchantId, ...scalars(input), isDefault },
    });
  });
};

export const updateDestination = async (
  merchantId: string,
  id: string,
  input: DestinationInput,
) => {
  const existing = await prisma.returnDestination.findFirst({
    where: { id, merchantId },
  });
  if (!existing) throw notFound("Destination not found.");
  // The default can only be moved, never switched off in place.
  if (existing.isDefault && input.isDefault === false) {
    throw unprocessable("Make another destination the default first.");
  }
  const becomesDefault = input.isDefault === true && !existing.isDefault;
  return prisma.$transaction(async (tx) => {
    if (becomesDefault) {
      await tx.returnDestination.updateMany({
        where: { merchantId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.returnDestination.update({
      where: { id },
      data: { ...scalars(input), ...(becomesDefault ? { isDefault: true } : {}) },
    });
  });
};

/**
 * Policies pointing at a deleted destination fall back to the default (the
 * relation nulls itself), so the default can't go while others remain — that
 * would leave those policies with nowhere to send anything.
 */
export const deleteDestination = async (merchantId: string, id: string) => {
  const existing = await prisma.returnDestination.findFirst({
    where: { id, merchantId },
    select: { isDefault: true },
  });
  if (!existing) throw notFound("Destination not found.");
  if (existing.isDefault) {
    const others = await prisma.returnDestination.count({
      where: { merchantId, id: { not: id } },
    });
    if (others > 0) {
      throw unprocessable("Make another destination the default before deleting this one.");
    }
  }
  await prisma.returnDestination.delete({ where: { id } });
};

/**
 * Where a shopper should send their parcel: the policy's destination when it
 * has one, else the store's default. Null when the store has set none up,
 * and the confirmation page keeps its own wording.
 */
export const destinationForShopper = async (
  merchantId: string,
  destinationId: string | null,
): Promise<{ name: string; lines: string[] } | null> => {
  const chosen = destinationId
    ? await prisma.returnDestination.findFirst({
        where: { id: destinationId, merchantId },
      })
    : null;
  const destination = chosen ?? (await defaultDestination(merchantId));
  return destination
    ? { name: destination.name, lines: destinationLines(destination) }
    : null;
};
