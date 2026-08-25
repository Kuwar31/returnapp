import { Prisma } from "@prisma/client";

export type Money = Prisma.Decimal;

export const toDecimal = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(value);

export const ZERO = toDecimal(0);

/** Rounds half-up to 2dp — the convention for customer-facing totals. */
export const round2 = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export const percentOf = (
  amount: Prisma.Decimal,
  percent: Prisma.Decimal.Value,
): Prisma.Decimal => round2(amount.mul(toDecimal(percent)).div(100));

/** Decimals don't survive JSON.stringify as numbers, so serialize explicitly. */
export const serializeMoney = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber();

export const formatMoney = (
  amount: Prisma.Decimal | number,
  currency: string,
): string => {
  const value = typeof amount === "number" ? amount : amount.toNumber();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};
