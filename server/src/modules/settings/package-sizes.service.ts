import type { LengthUnit, MassUnit, PackageSize } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Package sizes — AfterShip's shape: named dimensions and the empty
 * package's weight, in whatever units the merchant thinks in, one of them
 * the default. Carriers are given centimetres and kilograms.
 */

export interface PackageSizeInput {
  name: string;
  length: number;
  width: number;
  height: number;
  unit: LengthUnit;
  weight: number;
  massUnit: MassUnit;
  isDefault?: boolean;
}

const CM_PER_IN = 2.54;
const KG_PER_LB = 0.45359237;

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** The size as carriers want it. */
export const metric = (p: PackageSize) => {
  const len = (v: Prisma.Decimal) => (p.unit === "IN" ? round(Number(v) * CM_PER_IN, 2) : Number(v));
  return {
    lengthCm: len(p.length),
    breadthCm: len(p.width),
    heightCm: len(p.height),
    weightKg: p.massUnit === "LB" ? round(Number(p.weight) * KG_PER_LB, 3) : Number(p.weight),
  };
};

export const serializePackageSize = (p: PackageSize) => ({
  id: p.id,
  name: p.name,
  length: Number(p.length),
  width: Number(p.width),
  height: Number(p.height),
  unit: p.unit,
  weight: Number(p.weight),
  massUnit: p.massUnit,
  isDefault: p.isDefault,
  /** One line, for lists and selects: "30 × 20 × 10 cm, 0.2 kg". */
  summary: `${Number(p.length)} × ${Number(p.width)} × ${Number(p.height)} ${p.unit.toLowerCase()}, ${Number(p.weight)} ${p.massUnit.toLowerCase()}`,
});

export const listPackageSizes = (merchantId: string) =>
  prisma.packageSize.findMany({ where: { merchantId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

export const defaultPackageSize = (merchantId: string) =>
  prisma.packageSize.findFirst({ where: { merchantId, isDefault: true } });

const scalars = (input: PackageSizeInput) => ({
  name: input.name,
  length: new Prisma.Decimal(input.length),
  width: new Prisma.Decimal(input.width),
  height: new Prisma.Decimal(input.height),
  unit: input.unit,
  weight: new Prisma.Decimal(input.weight),
  massUnit: input.massUnit,
});

/** The first size is the default whether or not it was asked to be; there's always exactly one. */
export const createPackageSize = async (merchantId: string, input: PackageSizeInput) => {
  const count = await prisma.packageSize.count({ where: { merchantId } });
  const isDefault = count === 0 || input.isDefault === true;
  return prisma.$transaction(async (tx) => {
    if (isDefault) await tx.packageSize.updateMany({ where: { merchantId, isDefault: true }, data: { isDefault: false } });
    return tx.packageSize.create({ data: { merchantId, ...scalars(input), isDefault } });
  });
};

export const updatePackageSize = async (merchantId: string, id: string, input: PackageSizeInput) => {
  const existing = await prisma.packageSize.findFirst({ where: { id, merchantId } });
  if (!existing) throw notFound("Package size not found.");
  if (existing.isDefault && input.isDefault === false) {
    throw unprocessable("Make another package size the default first.");
  }
  const becomesDefault = input.isDefault === true && !existing.isDefault;
  return prisma.$transaction(async (tx) => {
    if (becomesDefault) await tx.packageSize.updateMany({ where: { merchantId, isDefault: true }, data: { isDefault: false } });
    return tx.packageSize.update({ where: { id }, data: { ...scalars(input), ...(becomesDefault ? { isDefault: true } : {}) } });
  });
};

/** The default can't go while others remain: labels need a size to fall back on. */
export const deletePackageSize = async (merchantId: string, id: string) => {
  const existing = await prisma.packageSize.findFirst({ where: { id, merchantId } });
  if (!existing) throw notFound("Package size not found.");
  if (existing.isDefault) {
    const others = await prisma.packageSize.count({ where: { merchantId, id: { not: id } } });
    if (others > 0) throw unprocessable("Make another package size the default first.");
  }
  await prisma.packageSize.delete({ where: { id } });
};
