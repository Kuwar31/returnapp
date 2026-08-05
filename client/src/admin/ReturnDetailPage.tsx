import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { dateTime, money, shortDate, titleCase } from "../lib/format";
import type { ReturnDetail } from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";

export function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let active = true;
    api
      .get<ReturnDetail>(`/admin/returns/${id}`, { auth: "admin" })
      .then((data) => active && setDetail(data))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  /** Every action returns the updated record, so we just swap it in. */
  const act = async (path: string, body?: unknown) => {
    setActing(true);
    setError(null);
    try {
      const updated = await api.post<ReturnDetail>(
        `/admin/returns/${id}/${path}`,
        body,
        { auth: "admin" },
      );
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That action failed.");
    } finally {
      setActing(false);
    }
  };

  const reject = () => {
    const reason = window.prompt("Why are you declining this return?");
    if (reason?.trim()) void act("reject", { reason: reason.trim() });
  };

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!note.trim() || !detail) return;
    setActing(true);
    try {
      const event_ = await api.post<ReturnDetail["events"][number]>(
        `/admin/returns/${id}/notes`,
        { message: note.trim() },
        { auth: "admin" },
      );
      setDetail({ ...detail, events: [...detail.events, event_] });
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the note.");
    } finally {
      setActing(false);
    }
  };

  if (loading) return <Loading />;
  if (!detail) {
    return (
      <>
        <ErrorAlert message={error ?? "Return not found."} />
        <Link className="btn btn--secondary btn--sm" to="/admin/returns">
          Back to returns
        </Link>
      </>
    );
  }

  const { totals } = detail;

  return (
    <>
      <div className="admin__header">
        <div>
          <Link className="subtle" to="/admin/returns">
            ← All returns
          </Link>
          <h1 style={{ marginTop: 6 }}>{detail.reference}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {detail.customerName ?? detail.customerEmail} ·{" "}
            {titleCase(detail.resolution)} · Submitted{" "}
            {shortDate(detail.submittedAt)}
          </p>
        </div>
        <StatusBadge status={detail.status} label={detail.statusLabel} />
      </div>

      <ErrorAlert message={error} />

      <div className="detail-grid">
        <div>
          <div className="panel">
            <h2>Items</h2>
            {detail.lineItems.map((item) => (
              <div className="line-item" key={item.id}>
                {item.imageUrl ? (
                  <img
                    className="line-item__thumb"
                    src={item.imageUrl}
                    alt={item.title}
                  />
                ) : (
                  <div className="line-item__thumb" />
                )}
                <div className="line-item__body">
                  <div className="line-item__title">{item.title}</div>
                  <div className="line-item__meta">
                    {item.variantTitle && <>{item.variantTitle} · </>}
                    {item.sku && <>{item.sku} · </>}Qty {item.quantity} ·{" "}
                    {money(item.lineTotal, detail.currency)}
                  </div>
                  {item.reasonLabel && (
                    <div className="line-item__meta">
                      Reason: {item.reasonLabel}
                      {item.reasonNote && ` — "${item.reasonNote}"`}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {detail.customerNote && (
              <div className="alert alert--info" style={{ marginTop: 16 }}>
                <strong>Customer note:</strong> {detail.customerNote}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Activity</h2>
            <ul className="event-list">
              {detail.events.map((event) => (
                <li key={event.id}>
                  <div>{event.message}</div>
                  <div className="subtle">{dateTime(event.createdAt)}</div>
                </li>
              ))}
            </ul>

            <form onSubmit={addNote} style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="note">Add an internal note</label>
                <textarea
                  id="note"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Only your team sees this"
                />
              </div>
              <button
                className="btn btn--secondary btn--sm"
                type="submit"
                disabled={acting || !note.trim()}
              >
                Add note
              </button>
            </form>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>Summary</h2>
            <dl style={{ margin: 0 }}>
              <div className="kv">
                <dt>Items</dt>
                <dd>{money(totals.itemsSubtotal, detail.currency)}</dd>
              </div>
              {totals.bonusCredit > 0 && (
                <div className="kv">
                  <dt>Bonus credit</dt>
                  <dd>+{money(totals.bonusCredit, detail.currency)}</dd>
                </div>
              )}
              {totals.restockingFee > 0 && (
                <div className="kv">
                  <dt>Restocking fee</dt>
                  <dd>−{money(totals.restockingFee, detail.currency)}</dd>
                </div>
              )}
              {totals.shippingFee > 0 && (
                <div className="kv">
                  <dt>Return shipping</dt>
                  <dd>−{money(totals.shippingFee, detail.currency)}</dd>
                </div>
              )}
              <div className="kv" style={{ fontWeight: 700 }}>
                <dt>Total</dt>
                <dd>
                  {money(
                    totals.settledTotal ?? totals.estimatedTotal,
                    detail.currency,
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="panel">
            <h2>Actions</h2>
            <div className="actions">
              {detail.status === "SUBMITTED" && (
                <>
                  <button
                    className="btn btn--sm"
                    disabled={acting}
                    onClick={() => void act("approve")}
                  >
                    Approve
                  </button>
                  <button
                    className="btn btn--secondary btn--sm"
                    disabled={acting}
                    onClick={reject}
                  >
                    Decline
                  </button>
                </>
              )}
              {(detail.status === "APPROVED" ||
                detail.status === "IN_TRANSIT") && (
                <button
                  className="btn btn--sm"
                  disabled={acting}
                  onClick={() => void act("receive")}
                >
                  Mark received
                </button>
              )}
              {detail.status === "RECEIVED" && (
                <button
                  className="btn btn--sm"
                  disabled={acting}
                  onClick={() => void act("resolve")}
                >
                  Resolve &amp; pay out
                </button>
              )}
              {["RESOLVED", "REJECTED", "CANCELLED", "EXPIRED"].includes(
                detail.status,
              ) && <p className="muted">This return is closed.</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
