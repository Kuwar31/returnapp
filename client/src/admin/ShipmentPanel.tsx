import { Link } from "react-router";
import { dateTime } from "../lib/format";
import type { ReturnDetail, ShipmentStatus } from "../lib/types";

/**
 * The return label on the return page: the courier booked to collect the
 * parcel, where it is, and the ways to intervene — book it, book it again
 * after a refusal, ask for fresh tracking, or call the courier off.
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

  // Nothing to say for a closed return that never had a parcel, or a return
  // that isn't sending one.
  if (!shipment && (!open || keeping)) return null;

  const test = Boolean(shipment?.isTest);
  const canCreate = open && (!shipment || ["FAILED", "CANCELLED"].includes(shipment.status));
  const canCancel = Boolean(shipment && ["PENDING", "LABEL_CREATED", "IN_TRANSIT"].includes(shipment.status));
  const canRefresh = Boolean(shipment?.externalShipmentId && shipment.status !== "CANCELLED") && !test;
  // A test parcel only moves when told to.
  const canSimulatePickup = test && shipment?.status === "LABEL_CREATED";
  const canSimulateDelivery = test && ["LABEL_CREATED", "IN_TRANSIT"].includes(shipment?.status ?? "");

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

      <div className="actions" style={{ marginTop: 14 }}>
        {shipment?.labelUrl && shipment.status !== "CANCELLED" && (
          <a className="btn btn--sm" href={shipment.labelUrl} target="_blank" rel="noreferrer">
            Download label
          </a>
        )}
        {canCreate && (
          <button type="button" className="btn btn--sm" disabled={acting} onClick={() => onAct("label")}>
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
