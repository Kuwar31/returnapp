/**
 * When a return that was approved but never arrived gets chased, and when it
 * closes. Measured in days from approval.
 *
 * On their own, with nothing imported, because both the sweep that applies
 * them and the settings page that describes them need the same numbers — and
 * having each import the other is a cycle that leaves whichever module loads
 * second reading undefined constants.
 */
export const REMINDER_DAYS = 15;
export const EXPIRING_DAYS = 21;
export const EXPIRE_DAYS = 30;
