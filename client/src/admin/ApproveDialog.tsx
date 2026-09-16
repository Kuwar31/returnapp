import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { money } from "../lib/format";
import { DROP_OFF_PROVIDERS, type CourierQuote, type CourierQuotes, type ReturnDetail } from "../lib/types";
import { Modal } from "./Modal";

/**
 * Approving a return that asked for a label, as CWILL's drawer does it: the
 * method the customer chose, the courier services quoted for the pickup
 * with their rates, and one button that approves and books. The merchant
 * can also approve without booking and come back to it from the return.
 */

/** Two letters from the courier's name, for the avatar. */
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

export function ApproveDialog({
  detail,
  busy,
  onClose,
  onApprove,
}: {
  detail: ReturnDetail;
  busy: boolean;
  onClose: () => void;
  onApprove: (choice: { bookLabel: boolean; courierId: number | null }) => void;
}) {
  const [quotes, setQuotes] = useState<CourierQuotes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Null means "approve without booking". */
  const [courierId, setCourierId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get<CourierQuotes>(`/admin/returns/${detail.id}/label/couriers`, { auth: "admin" })
      .then((found) => {
        if (!active) return;
        setQuotes(found);
        setCourierId(found.couriers.find((c) => c.recommended)?.courierId ?? found.couriers[0]?.courierId ?? null);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Couldn't get courier rates."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [detail.id]);

  const chosen: CourierQuote | null = quotes?.couriers.find((c) => c.courierId === courierId) ?? null;

  return (
    <Modal
      title="Approve return"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || loading}
            onClick={() => onApprove({ bookLabel: chosen !== null, courierId: chosen?.courierId ?? null })}
          >
            {busy ? "Approving…" : chosen ? (quotes && DROP_OFF_PROVIDERS.includes(quotes.provider) ? "Approve & make label" : "Approve & book pickup") : "Approve"}
          </button>
        </>
      }
    >
      <div className="appr">
        <div className="appr__label">Method</div>
        <div className="appr__method">
          <span className="appr__method-icon" aria-hidden="true">
            🏷️
          </span>
          <span>
            <span className="appr__method-name">
              {detail.returnMethod?.name ?? "Ship with a return label"}
              <span className="chip appr__chip">Customer selected</span>
            </span>
            <span className="muted">A courier collects the parcel from the customer.</span>
          </span>
        </div>

        <div className="appr__label">Return label</div>
        <div className="appr__services">
          <div className="appr__services-head">Select service</div>
          {loading && <p className="muted appr__note">Checking which services can collect it…</p>}
          {error && (
            <div className="alert alert--error" style={{ margin: "10px 14px" }}>
              {error} You can still approve and book the pickup later from the return.
            </div>
          )}
          {quotes?.couriers.map((c) => (
            <label key={c.courierId} className={`svc__row appr__row${courierId === c.courierId ? " is-selected" : ""}`}>
              <span className="appr__logo" aria-hidden="true">
                {initials(c.name)}
              </span>
              <span className="svc__body">
                <span className="svc__name">
                  {c.name}
                  {c.recommended && <span className="chip svc__chip">Recommended</span>}
                </span>
                <span className="svc__meta">
                  {[
                    c.days !== null ? `Est. ${c.days} business day${c.days === 1 ? "" : "s"}` : null,
                    c.etd ? `by ${c.etd}` : null,
                    c.surface ? "Surface" : "Air",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="svc__price">
                <strong>{c.rate === null ? "Contract rate" : money(c.rate, c.currency)}</strong>
                {c.shopRate !== null && quotes.shopCurrency !== c.currency && (
                  <span className="muted">≈ {money(c.shopRate, quotes.shopCurrency)}</span>
                )}
              </span>
              <input
                type="radio"
                name="approve-courier"
                checked={courierId === c.courierId}
                onChange={() => setCourierId(c.courierId)}
              />
            </label>
          ))}
          {quotes && quotes.couriers.length === 0 && (
            <p className="muted appr__note">No courier serves this route at the moment.</p>
          )}
          {!loading && (
            <label className={`svc__row appr__row appr__row--none${courierId === null ? " is-selected" : ""}`}>
              <span className="appr__logo appr__logo--none" aria-hidden="true">
                –
              </span>
              <span className="svc__body">
                <span className="svc__name">Don't book a courier yet</span>
                <span className="svc__meta">Approve only; book the pickup later from the return.</span>
              </span>
              <input
                type="radio"
                name="approve-courier"
                checked={courierId === null}
                onChange={() => setCourierId(null)}
              />
            </label>
          )}
        </div>
      </div>
    </Modal>
  );
}
