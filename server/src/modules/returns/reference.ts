import { customAlphabet } from "nanoid";

// No vowels (avoids accidental words) and no 0/O/1/I (avoids misreading over
// the phone or from a printed packing slip).
const nanoid = customAlphabet("23456789BCDFGHJKLMNPQRSTVWXYZ", 6);

export const generateReference = (): string => `R-${nanoid()}`;

export const generateCreditCode = (): string => `CREDIT-${nanoid()}${nanoid()}`;
