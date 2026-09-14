import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { dateTime, money } from "../lib/format";
import type { CourierQuotes, ReturnDetail, ShipmentStatus } from "../lib/types";

/**
 * The return label on the return page: the courier booked to collect the
 * parcel, where it is, and the ways to intervene — pick a service and book
 * it, book it again after a refusal, ask for fresh tracking, or call the
 * courier off.
 *
 * Before a booking, the panel quotes the courier services Shiprocket offers
 * for this pickup, priced, so the merchant chooses with the cost in view —
 * as CWILL's approval drawer does. Without a choice, Shiprocket's own
 * recommendation is booked.
 */

const STATUS_COPY: Record<ShipmentStatus, string> = {
  PENDING: "Booking",
  LABEL_CREATED: "Pickup booked",
  IN_TRANSIT: "On its way",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const OPEN: ReturnDetail["status"][] = ["APPROVED", "IN_TRANSIT"];

export function ShipmentPanel({
  detail,
  acting,
  onAct,
  settingsPath,
}: {
  detail: ReturnDetail;
  acting: boolean;
  onAct: (path: string, body?: unknown) => void;
  /** Where Shiprocket is connected, for the hint when it isn't. */
  settingsPath: string;
}) {
  const shipment = detail.shipment;
  const open = OPEN.includes(detail.status);
  const askedForLabel = detail.returnMethod?.kind === "LABEL";
  const keeping = detail.returnMethod?.kind === "KEEP";
  const test = Boolean(shipment?.isTest);

  // Before approval the choosing happens in the approval dialog instead.
  const pending = false;
  const canCreate = open && (!shipment || ["FAILED", "CANCELLED"].includes(shipment.status));
  const canCancel = Boolean(shipment && ["PENDING", "LABEL_CREATED", "IN_TRANSIT"].includes(shipment.status));
  const canRefresh = Boolean(shipment?.externalShipmentId && shipment.status !== "CANCELLED") && !test;
  // A test parcel only moves when told to.
  const canSimulatePickup = test && shipment?.status === "LABEL_CREATED";
  const canSimulateDelivery = test && ["LABEL_CREATED", "IN_TRANSIT"].includes(shipment?.status ?? "");
  const wantsQuote = (canCreate || pending) && !keeping;

  const [quotes, setQuotes] = useState<CourierQuotes | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [courierId, setCourierId] = useState<number | null>(null);
  /** After a failed booking the list is folded away: the choice was made already. */
  const [choosing, setChoosing] = useState(false);

  const loadQuotes = async () => {
    setQuoting(true);
    setQuoteError(null);
    try {
      const found = await api.get<CourierQuotes>(`/admin/returns/${detail.id}/label/couriers`, {
        auth: "admin",
      });
      setQuotes(found);
      // Keep the merchant's pick if it's still offered; else the recommendation.
      // The service chosen last time first, then the recommendation.
      setCourierId((prev) => {
        const offered = (id: number | null | undefined) =>
          id !== null && id !== undefined && found.couriers.some((c) => c.courierId === id) ? id : null;
        return (
          offered(prev) ??
          offered(shipment?.courierId) ??
          found.couriers.find((c) => c.recommended)?.courierId ??
          found.couriers[0]?.courierId ??
          null
        );
      });
    } catch (e) {
      setQuotes(null);
      setQuoteError(e instanceof Error ? e.message : "Couldn't get courier rates.");
    } finally {
      setQuoting(false);
    }
  };

  useEffect(() => {
    if (wantsQuote) void loadQuotes();
    // Quotes are for this return, in the states where a booking is possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, wantsQuote]);

  // Nothing to say for a closed return that never had a parcel, or a return
  // that isn't sending one.
  if (!shipment && !open && !pending) return null;
  if (!shipment && keeping) return null;

  return (
    <div className="panel">
      <div className="panel__head">
        <h2>Return label</h2>
        {shipment && (
          <span className={`chip ship-chip ship-chip--${shipment.status.toLowerCase()}`}>
            {STATUS_COPY[shipment.status]}
            {test && " · Test"}
          </span>
        )}
      </div>

      {test && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Booked in test mode: nothing was sent to Shiprocket and no courier is
          coming. The customer got the usual email and sees the usual page.
          Move the parcel along with the buttons below.
        </p>
      )}

      {!shipment && (
        <p className="muted" style={{ marginBottom: 12 }}>
          {askedForLabel
            ? "The customer asked for a return label. Book a Shiprocket courier to collect the parcel from their address."
            : "Book a Shiprocket courier to collect the parcel from the customer's address instead of leaving the shipping to them."}{" "}
          Needs Shiprocket connected under <Link to={settingsPath}>Shipping</Link>.
        </p>
      )}

      {shipment && (
        <>
          {shipment.lastError && (
            <div className="alert alert--error" style={{ marginBottom: 12 }}>
              {shipment.lastError}
            </div>
          )}
          <dl style={{ margin: 0 }}>
            {shipment.carrier && (
              <div className="kv">
                <dt>Courier</dt>
                <dd>{shipment.carrier}</dd>
              </div>
            )}
            {shipment.trackingNumber && (
              <div className="kv">
                <dt>AWB</dt>
                <dd>
                  {shipment.trackingUrl ? (
                    <a href={shipment.trackingUrl} target="_blank" rel="noreferrer">
                      {shipment.trackingNumber}
                    </a>
                  ) : (
                    shipment.trackingNumber
                  )}
                </dd>
              </div>
            )}
            {shipment.pickupScheduledAt && (
              <div className="kv">
                <dt>Pickup</dt>
                <dd>
                  {dateTime(shipment.pickupScheduledAt)}
                  {shipment.pickupToken && <span className="muted"> · {shipment.pickupToken}</span>}
                </dd>
              </div>
            )}
            {shipment.statusLabel && (
              <div className="kv">
                <dt>Shiprocket says</dt>
                <dd>
                  {shipment.statusLabel}
                  {shipment.lastTrackedAt && (
                    <span className="muted"> · checked {dateTime(shipment.lastTrackedAt)}</span>
                  )}
                </dd>
              </div>
            )}
            {shipment.etd && (
              <div className="kv">
                <dt>Expected</dt>
                <dd>{dateTime(shipment.etd)}</dd>
              </div>
            )}
            {shipment.deliveredAt && (
              <div className="kv">
                <dt>Delivered</dt>
                <dd>{dateTime(shipment.deliveredAt)}</dd>
              </div>
            )}
          </dl>

          {shipment.scans.length > 0 && (
            <ol className="scans">
              {shipment.scans.slice(0, 6).map((scan, i) => (
                <li key={`${scan.date}-${i}`} className="scans__item">
                  <span className="scans__date">{scan.date.slice(0, 16)}</span>
                  <span>
                    {scan.activity}
                    {scan.location && <span className="muted"> · {scan.location}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/*
        The services and their prices, so the choice is made with the cost
        in view. Shiprocket quotes in rupees; the store's own figure is shown
        beside it when the order's exchange rate makes one possible.
      */}
      {wantsQuote && shipment && !choosing && (
        <p className="settings-row__hint" style={{ marginTop: 12 }}>
          Book again uses{" "}
          {quotes?.couriers.find((c) => c.courierId === courierId)?.name ?? "Shiprocket's recommended courier"}.{" "}
          <button type="button" className="link-btn" onClick={() => setChoosing(true)}>
            Choose a different service
          </button>
        </p>
      )}

      {wantsQuote && (!shipment || choosing) && (
        <div className="svc">
          <div className="svc__head">
            <span className="field-label">Select service</span>
            <button type="button" className="link-btn" disabled={quoting} onClick={() => void loadQuotes()}>
              {quoting ? "Getting rates…" : quotes ? "Refresh rates" : "Get rates"}
            </button>
          </div>
          {quoteError && (
            <div className="alert alert--error" style={{ marginBottom: 10 }}>
              {quoteError}
            </div>
          )}
          {quotes && quotes.couriers.length === 0 && (
            <p className="muted">No courier serves this route at the moment.</p>
          )}
          {quotes?.couriers.map((c) => (
            <label
              key={c.courierId}
              className={`svc__row${courierId === c.courierId ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="courier"
                checked={courierId === c.courierId}
                onChange={() => setCourierId(c.courierId)}
              />
              <span className="svc__body">
                <span className="svc__name">
                  {c.name}
                  {c.recommended && <span className="chip svc__chip">Recommended</span>}
                </span>
                <span className="svc__meta">
                  {[
                    c.days !== null ? `Est. ${c.days} day${c.days === 1 ? "" : "s"}` : null,
                    c.etd ? `by ${c.etd}` : null,
                    c.surface ? "Surface" : "Air",
                    c.rating !== null ? `★ ${c.rating}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="svc__price">
                <strong>{money(c.rate, "INR")}</strong>
                {c.shopRate !== null && quotes.shopCurrency !== "INR" && (
                  <span className="muted">≈ {money(c.shopRate, quotes.shopCurrency)}</span>
                )}
              </span>
            </label>
          ))}
          {pending && (
            <p className="settings-row__hint" style={{ marginTop: 10 }}>
              Approve the return to book the pickup. If labels are booked
              automatically at approval, Shiprocket's recommended courier is
              used; to choose one here, turn that off under Shipping.
            </p>
          )}
        </div>
      )}

      <div className="actions" style={{ marginTop: 14 }}>
        {shipment?.labelUrl && shipment.status !== "CANCELLED" && (
          <a className="btn btn--sm" href={shipment.labelUrl} target="_blank" rel="noreferrer">
            Download label
          </a>
        )}
        {canCreate && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={acting}
            onClick={() => onAct("label", { courierId })}
          >
            {shipment ? "Book again" : "Create return label"}
          </button>
        )}
        {canRefresh && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={acting}
            onClick={() => onAct("label/refresh")}
          >
            Refresh tracking
          </button>
        )}
        {canSimulatePickup && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={acting}
            onClick={() => onAct("label/simulate", { step: "PICKED_UP" })}
          >
            Simulate pickup
          </button>
        )}
        {canSimulateDelivery && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={acting}
            onClick={() => onAct("label/simulate", { step: "DELIVERED" })}
          >
            Simulate delivery
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={acting}
            onClick={() => {
              if (window.confirm("Call the courier off? The customer will have to send the parcel themselves.")) {
                onAct("label/cancel");
              }
            }}
          >
            Cancel pickup
          </button>
        )}
      </div>
    </div>
  );
}
