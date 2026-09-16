import type { Prisma, ShipmentProvider } from "@prisma/client";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { defaultDestination } from "../settings/destinations.service.js";

/**
 * What applies to every carrier: which one books labels, whether it does so
 * at approval, where parcels go, and the parcel defaults. Made on first
 * sight so a store always has a row to read.
 */

const include = { destination: true } as const;

export const getSettings = async (merchantId: string) =>
  prisma.shippingSettings.upsert({
    where: { merchantId },
    create: { merchantId },
    update: {},
    include,
  });

export type ShippingSettingsRow = Awaited<ReturnType<typeof getSettings>>;

export const serializeSettings = (s: ShippingSettingsRow) => ({
  provider: s.provider,
  autoCreate: s.autoCreate,
  receiveOnDelivery: s.receiveOnDelivery,
  /** Null means the store's default destination. */
  destinationId: s.destinationId,
  /** Null falls back to the store owner's address. */
  shippingEmail: s.shippingEmail,
  parcel: {
    lengthCm: Number(s.lengthCm),
    breadthCm: Number(s.breadthCm),
    heightCm: Number(s.heightCm),
    weightKg: Number(s.weightKg),
  },
});

export interface SettingsInput {
  provider?: ShipmentProvider | null;
  autoCreate?: boolean;
  receiveOnDelivery?: boolean;
  destinationId?: string | null;
  shippingEmail?: string | null;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
  weightKg?: number;
}

export const updateSettings = async (merchantId: string, input: SettingsInput) => {
  await getSettings(merchantId);
  if (input.destinationId) {
    const owned = await prisma.returnDestination.findFirst({
      where: { id: input.destinationId, merchantId },
      select: { id: true },
    });
    if (!owned) throw notFound("That destination isn't one of this store's.");
  }
  return prisma.shippingSettings.update({
    where: { merchantId },
    data: input as Prisma.ShippingSettingsUncheckedUpdateInput,
    include,
  });
};

/**
 * Where the courier delivers for this store: the destination chosen on the
 * Shipping page, else the store's default. A regional policy's own
 * destination outranks both, per return.
 */
export const deliveryDestination = async (merchantId: string) => {
  const settings = await getSettings(merchantId);
  return settings.destination ?? (await defaultDestination(merchantId));
};
