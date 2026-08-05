import type { ReturnStatus } from "../lib/types";

const TONES: Record<ReturnStatus, string> = {
  DRAFT: "neutral",
  SUBMITTED: "pending",
  APPROVED: "success",
  REJECTED: "danger",
  IN_TRANSIT: "info",
  RECEIVED: "info",
  RESOLVED: "success",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

export function StatusBadge({
  status,
  label,
}: {
  status: ReturnStatus;
  label: string;
}) {
  return <span className={`badge badge--${TONES[status]}`}>{label}</span>;
}
