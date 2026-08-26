import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../lib/api";
import { dateTime, money, shortDate, titleCase } from "../lib/format";
import type {
  ExchangeDiagnosis,
  ExchangeDraft,
  RefundPreview,
  ReturnDetail,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";

/** Where a payout lands, in the words a merchant would use to a customer. */
const PAYOUT_LABEL: Record<string, string> = {
  REFUND: "To original payment method",
  STORE_CREDIT: "To store credit",
  GIFT_CARD: "To gift card",
  EXCHANGE: "As an exchange",
  INSTANT_EXCHANGE: "As an instant exchange",
  WARRANTY: "As a warranty replacement",
};

const EXCHANGE_STATUS_COPY: Record<ExchangeDraft["status"], string> = {
  OPEN: "Draft open — stock reserved",
  INVOICE_SENT: "Invoice sent — awaiting payment",
  COMPLETED: "Paid — ready to fulfil",
  CANCELLED: "Cancelled",
};

/**
 * The exchange's draft order.
 *
 * Shown to the merchant only. The invoice URL is a bearer link — whoever holds
 * it can complete the order — so it never reaches the shopper-facing portal,
 * which is why the portal's serializer leaves this field out entirely.
 */
function ExchangePanel({
  draft,
  acting,
  onResend,
}: {
  draft: ExchangeDraft;
  acting: boolean;
  onResend: () => void;
}) {
  const owed = draft.balanceDue > 0;
  const settled = draft.status === "COMPLETED" || draft.status === "CANCELLED";

  return (
    <div className="panel">
      <h2>Exchange {draft.name ?? ""}</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        {EXCHANGE_STATUS_COPY[draft.status]}
      </p>

      <dl style={{ margin: 0 }}>
        <div className="kv">
          <dt>Replacement items</dt>
          <dd>{money(draft.itemsTotal, draft.currency)}</dd>
        </div>
        <div className="kv">
          <dt>Return credit</dt>
          <dd>−{money(draft.creditApplied, draft.currency)}</dd>
        </div>
        <div className="kv" style={{ fontWeight: 700 }}>
          <dt>{owed ? "Customer owes" : "Balance"}</dt>
          <dd>{money(draft.balanceDue, draft.currency)}</dd>
        </div>
        {draft.reservedUntil && !settled && (
          <div className="kv">
            <dt>Stock reserved until</dt>
            <dd>{shortDate(draft.reservedUntil)}</dd>
          </div>
        )}
        {draft.invoiceSentAt && (
          <div className="kv">
            <dt>Invoice sent</dt>
            <dd>{shortDate(draft.invoiceSentAt)}</dd>
          </div>
        )}
      </dl>

      {owed && !settled && (
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn--secondary btn--sm"
            disabled={acting}
            onClick={onResend}
          >
            {draft.invoiceSentAt ? "Re-send invoice" : "Send invoice"}
          </button>
          {draft.invoiceUrl && (
            <a
              className="btn btn--secondary btn--sm"
              href={draft.invoiceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open checkout link
            </a>
          )}
        </div>
      )}
    </div>
  );
}

type LineItem = ReturnDetail["lineItems"][number];

interface InspectionPatch {
  acceptedQuantity?: number | null;
  restock?: boolean;
  rejectionNote?: string | null;
  keepItem?: boolean;
}

/**
 * One returned line, decided on its own.
 *
 * Every item in a return is judged independently — six items can end up six
 * different ways — so the accept/reject controls live per row rather than on
 * the return as a whole. The unit picker only appears when a line has more than
 * one of the same thing, because that's the only time the question arises.
 */
function InspectionRow({
  item,
  currency,
  disabled,
  onChange,
}: {
  item: LineItem;
  currency: string;
  disabled: boolean;
  onChange: (patch: InspectionPatch) => void;
}) {
  const [note, setNote] = useState(item.rejectionNote ?? "");
  const accepted = item.acceptedQuantity;
  const inspected = accepted !== null;
  const rejected = accepted === 0;
  const partial = inspected && accepted > 0 && accepted < item.quantity;

  const state = rejected
    ? { label: "Rejected", tone: "danger" }
    : item.keepItem
      ? { label: "Keeping", tone: "info" }
      : partial
        ? { label: `${accepted} of ${item.quantity}`, tone: "pending" }
        : inspected
          ? { label: "Accepted", tone: "success" }
          : { label: "Returning", tone: "neutral" };

  return (
    <div
      className={`ritem${rejected ? " ritem--rejected" : ""}${
        partial ? " ritem--partial" : ""
      }`}
    >
      <div className="ritem__head">
        {item.imageUrl ? (
          <img className="ritem__thumb" src={item.imageUrl} alt={item.title} />
        ) : (
          <div className="ritem__thumb" />
        )}

        <div className="ritem__body">
          <div className="ritem__title">
            {item.title}
            <span className="ritem__ext" aria-hidden>
              ↗
            </span>
          </div>
          {item.variantTitle && (
            <div className="ritem__meta">{item.variantTitle}</div>
          )}
          {item.sku && <div className="ritem__meta">SKU: {item.sku}</div>}
          <div className="ritem__meta">Quantity: {item.quantity}</div>
        </div>

        <div className="ritem__right">
          <span className={`badge badge--${state.tone}`}>{state.label}</span>
          <span className="ritem__price">{money(item.lineTotal, currency)}</span>
          <label className="ritem__restock" title="Put back into inventory">
            <input
              type="checkbox"
              checked={item.restock}
              disabled={disabled || rejected || item.keepItem}
              onChange={(e) => onChange({ restock: e.target.checked })}
            />
            Restock
          </label>
        </div>
      </div>

      <div className="ritem__actions">
        <button
          type="button"
          className="ritem__action"
          disabled={disabled}
          onClick={() =>
            onChange({ acceptedQuantity: inspected && !rejected ? null : item.quantity })
          }
        >
          {inspected && !rejected ? "Undo accept" : "Accept"}
        </button>
        <button
          type="button"
          className="ritem__action ritem__action--danger"
          disabled={disabled}
          onClick={() => onChange({ acceptedQuantity: rejected ? null : 0 })}
        >
          {rejected ? "Undo reject" : "Reject"}
        </button>

        {/* Only meaningful for a multi-unit line: how many of the same item. */}
        {item.quantity > 1 && !rejected && (
          <span className="ritem__units">
            Accept
            <span className="unit-picker" role="group" aria-label="Units accepted">
              {Array.from({ length: item.quantity + 1 }, (_, n) => (
                <button
                  key={n}
                  type="button"
                  className={`unit${accepted === n ? " is-selected" : ""}`}
                  disabled={disabled}
                  aria-pressed={accepted === n}
                  onClick={() => onChange({ acceptedQuantity: n })}
                >
                  {n}
                </button>
              ))}
            </span>
            of {item.quantity}
          </span>
        )}

        <button
          type="button"
          className={`ritem__action ritem__action--right${
            item.keepItem ? " is-active" : ""
          }`}
          disabled={disabled || rejected}
          title="Credit the customer without asking for the item back"
          onClick={() => onChange({ keepItem: !item.keepItem })}
        >
          {item.keepItem ? "✓ Keeping item" : "Change to keep"}
        </button>
      </div>

      {item.reasonLabel && (
        <div className="ritem__reason">
          <div className="ritem__reason-label">Customer return reason</div>
          <div className="muted">
            {item.reasonLabel}
            {item.reasonNote && ` / ${item.reasonNote}`}
          </div>
        </div>
      )}

      {(partial || rejected) && (
        <div className="ritem__note">
          <input
            type="text"
            placeholder="Why? (visible to your team only)"
            value={note}
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (item.rejectionNote ?? "")) {
                onChange({ rejectionNote: note.trim() || null });
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [diagnosis, setDiagnosis] = useState<ExchangeDiagnosis | null>(null);

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

  // Ask Shopify what it would actually pay out, so the button can show the
  // real figure rather than our estimate. Non-critical: failure just means the
  // button reads "Process & refund" without an amount.
  useEffect(() => {
    let active = true;
    api
      .get<RefundPreview>(`/admin/returns/${id}/refund-preview`, {
        auth: "admin",
      })
      .then((data) => active && setPreview(data))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id, detail?.status]);

  /**
   * Whether Shopify settled this return's exchange correctly.
   *
   * Read-only and non-critical — a failure just means no banner. Only returns
   * with a native exchange come back as anything other than NOT_APPLICABLE, so
   * this stays silent on everything else.
   */
  useEffect(() => {
    let active = true;
    api
      .get<ExchangeDiagnosis>(`/admin/returns/${id}/exchange/diagnose`, {
        auth: "admin",
      })
      .then((data) => active && setDiagnosis(data))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id, detail?.status]);

  const repairExchange = async () => {
    setActing(true);
    setError(null);
    try {
      const updated = await api.post<
        ReturnDetail & { diagnosis: ExchangeDiagnosis }
      >(`/admin/returns/${id}/exchange/repair`, undefined, { auth: "admin" });
      setDetail(updated);
      setDiagnosis(updated.diagnosis);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The repair failed.");
    } finally {
      setActing(false);
    }
  };

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

  /**
   * Cancelling withdraws the request rather than judging it, and it is a
   * one-way door in the status machine — so it confirms first.
   */
  const cancel = () => {
    if (!window.confirm("Cancel this return? This can't be undone.")) return;
    const reason = window.prompt("Reason (optional)") ?? undefined;
    void act("cancel", { reason: reason?.trim() || undefined });
  };

  const flag = () => {
    if (detail?.flaggedAt) {
      void act("flag");
      return;
    }
    const reason = window.prompt("Why flag this return? (optional)") ?? undefined;
    void act("flag", { reason: reason?.trim() || undefined });
  };

  /**
   * Records an inspection decision. The server returns the whole return with
   * its money recomputed, so the summary and the refund button update together
   * with the units — there's no moment where they disagree.
   */
  const inspect = async (lineItemId: string, patch: InspectionPatch) => {
    setActing(true);
    setError(null);
    try {
      const updated = await api.patch<ReturnDetail>(
        `/admin/returns/${id}/line-items/${lineItemId}`,
        patch,
        { auth: "admin" },
      );
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update that item.");
    } finally {
      setActing(false);
    }
  };

  /** Loop's "Restock all" — one call per line, applied in sequence. */
  const restockAll = async (restock: boolean) => {
    if (!detail) return;
    for (const line of detail.lineItems) {
      if (line.restock !== restock) {
        await inspect(line.id, { restock });
      }
    }
  };

  /**
   * Restocks and refunds in one step. Confirmed first because it moves real
   * money and Shopify will not reverse it automatically.
   */
  const processAndRefund = () => {
    const amount = preview?.shopifyRefund
      ? money(preview.shopifyRefund.amount, preview.shopifyRefund.currency)
      : money(detail?.totals.estimatedTotal ?? 0, detail?.currency ?? "USD");
    const verb =
      detail?.resolution === "REFUND"
        ? `refund ${amount} to the customer`
        : `close this return out at ${amount}`;
    if (window.confirm(`Restock the items and ${verb}? This can't be undone.`)) {
      void act("process");
    }
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
  const closed = ["RESOLVED", "REJECTED", "CANCELLED", "EXPIRED"].includes(
    detail.status,
  );
  const allRestocked = detail.lineItems.every((li) => li.restock);

  // Units the merchant has actually signed off. An uninspected line counts at
  // what the shopper asked for, matching what the server will pay.
  const acceptedUnits = detail.lineItems.reduce(
    (n, li) => n + (li.acceptedQuantity ?? li.quantity),
    0,
  );

  return (
    <>
      <Link className="subtle" to="/admin/returns">
        ← Returns
      </Link>

      <div className="rhead">
        <h1 className="rhead__title">
          Returns / <span>{detail.reference}</span>
        </h1>
        <div className="rhead__meta">
          <span className="chip">{detail.currency}</span>
          Created {dateTime(detail.submittedAt)}
          {detail.policyName && <> · Return policy: {detail.policyName}</>}
        </div>
      </div>

      {/* Actions get their own row rather than crowding the title: they are
          the decisions this page exists for, and several are destructive. */}
      <div className="rbar">
        <div className="rbar__left">
          {/*
            Always rendered, disabled when the status machine won't allow them.
            Hiding a button as it becomes unavailable makes the toolbar jump
            around and leaves the merchant unsure whether it ever existed.
          */}
          <button
            className="btn btn--secondary btn--sm"
            disabled={acting || detail.status !== "SUBMITTED"}
            onClick={reject}
          >
            Reject Return
          </button>
          <button
            className="btn btn--secondary btn--sm"
            disabled={acting || closed}
            onClick={cancel}
          >
            Cancel Return
          </button>
          <button
            className={`btn btn--secondary btn--sm${detail.flaggedAt ? " is-flagged" : ""}`}
            disabled={acting}
            onClick={flag}
            title={detail.flagReason ?? undefined}
          >
            {detail.flaggedAt ? "⚑ Flagged" : "Flag Return"}
          </button>
          {!closed && detail.status !== "SUBMITTED" && (
            <button
              className="btn btn--secondary btn--sm"
              disabled={acting || detail.status === "RECEIVED"}
              onClick={() => void act("receive")}
            >
              Mark received
            </button>
          )}
          <StatusBadge status={detail.status} label={detail.statusLabel} />
        </div>

        <div className="rbar__right">
          {detail.status === "SUBMITTED" && (
            <button
              className="btn btn--sm"
              disabled={acting}
              onClick={() => void act("approve")}
            >
              Approve return
            </button>
          )}
          {["APPROVED", "IN_TRANSIT", "RECEIVED"].includes(detail.status) && (
            <button className="btn btn--sm" disabled={acting} onClick={processAndRefund}>
              {preview?.shopifyRefund
                ? `Process return · ${money(
                    preview.shopifyRefund.amount,
                    preview.shopifyRefund.currency,
                  )}`
                : "Process return"}
            </button>
          )}
        </div>
      </div>

      {detail.status === "SUBMITTED" && (
        <div className="notice">
          <span className="notice__icon" aria-hidden>⚠</span>
          <div>
            <strong>This return is waiting on you</strong>
            <div className="notice__body">
              Approve or reject it so the customer knows what to send back.
            </div>
          </div>
        </div>
      )}

      <ErrorAlert message={error} />

      {/*
        Only ever rendered for a return whose exchange Shopify settled wrong.
        Two outcomes, and the difference matters to the merchant: one the app
        can put right itself, the other needs a refund from the order because
        Shopify has already finished with the return.
      */}
      {diagnosis &&
        (diagnosis.state === "UNCOMMITTED" || diagnosis.state === "UNSETTLED") && (
          <div className="alert alert--warn repair">
            <div className="repair__body">
              <strong>
                {diagnosis.state === "UNCOMMITTED"
                  ? "This exchange was never completed in Shopify"
                  : "This exchange was charged without crediting the return"}
              </strong>
              <p>{diagnosis.summary}</p>
              {diagnosis.refundOwed && (
                <p>
                  Shopify prices the refund owed at{" "}
                  <strong>
                    {money(
                      diagnosis.refundOwed.amount,
                      diagnosis.refundOwed.currency,
                    )}
                  </strong>
                  .
                </p>
              )}
              {diagnosis.state === "UNSETTLED" && diagnosis.orderOutstanding && (
                <p>
                  Refund{" "}
                  <strong>
                    {money(
                      diagnosis.refundOwed?.amount ??
                        diagnosis.orderOutstanding.amount,
                      diagnosis.refundOwed?.currency ??
                        diagnosis.orderOutstanding.currency,
                    )}
                  </strong>{" "}
                  on order {diagnosis.shopifyReturnName?.split("-")[0]} in Shopify
                  and release the hold on the replacement. This app issues refunds
                  through the return itself, which Shopify has already closed, so
                  it can't do it from here.
                </p>
              )}
            </div>
            {diagnosis.repairable && (
              <button
                className="btn btn--sm"
                disabled={acting}
                onClick={() => void repairExchange()}
              >
                {acting ? "Settling…" : "Settle exchange"}
              </button>
            )}
          </div>
        )}

      {/* The one banner Loop leads with: a return nobody has touched that is
          running out of window. Only shown while it can still be acted on. */}
      {detail.status === "SUBMITTED" && (
        <div className="alert alert--warn rbanner">
          <strong>This return is waiting on you</strong>
          <div>
            Approve or reject it so the customer knows what to send back.
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div>
          <div className="panel">
            <div className="panel__head">
              <h2 className="dot-head">
                <span
                  className={`dot dot--${closed ? "done" : "open"}`}
                  aria-hidden
                />
                Return credits
              </h2>
              <label className="restock-all">
                <input
                  type="checkbox"
                  checked={allRestocked}
                  disabled={acting || closed}
                  onChange={(e) => void restockAll(e.target.checked)}
                />
                Restock all
              </label>
            </div>

            {detail.lineItems.map((item) => (
              <InspectionRow
                key={item.id}
                item={item}
                currency={detail.currency}
                disabled={acting || closed}
                onChange={(patch) => void inspect(item.id, patch)}
              />
            ))}

            {detail.customerNote && (
              <div className="alert alert--info" style={{ marginTop: 16 }}>
                <strong>Customer note:</strong> {detail.customerNote}
              </div>
            )}
          </div>

          {detail.exchangeItems.length > 0 && (
            <div className="panel">
              <div className="panel__head">
                <h2 className="dot-head">
                  <span className="dot dot--open" aria-hidden />
                  Purchased
                </h2>
                {detail.exchangeDraft?.name && (
                  <span className="subtle">
                    Exchange order {detail.exchangeDraft.name}
                  </span>
                )}
              </div>
              {detail.exchangeItems.map((item) => (
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
                      {item.sku && <>{item.sku} · </>}Qty {item.quantity}
                    </div>
                  </div>
                  <span className="line-item__price">
                    {money(item.unitPrice * item.quantity, detail.currency)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/*
            Loop puts the money in the main column, not the sidebar — it is the
            conclusion of the item list above it, and reads as the bottom of
            that argument rather than as reference material beside it.
          */}
          <div className="panel">
            <h2 className="dot-head">
              <span
                className={`dot dot--${totals.estimatedTotal > 0 ? "open" : "done"}`}
                aria-hidden
              />
              {closed ? "Settled" : "Returned"}
            </h2>

            <div className="tot">
              <div className="tot__head">
                <span>Return credit</span>
                <span>({money(totals.itemsSubtotal, detail.currency)})</span>
              </div>
              <div className="tot__row">
                <span>Number of items</span>
                <span className="tot__count">{acceptedUnits}</span>
                <span>{money(totals.itemsSubtotal, detail.currency)}</span>
              </div>
              {totals.bonusCredit > 0 && (
                <div className="tot__row">
                  <span>Bonus credit</span>
                  <span className="tot__count" />
                  <span>+{money(totals.bonusCredit, detail.currency)}</span>
                </div>
              )}
              {totals.restockingFee > 0 && (
                <div className="tot__row">
                  <span>Restocking fee</span>
                  <span className="tot__count" />
                  <span>−{money(totals.restockingFee, detail.currency)}</span>
                </div>
              )}

              {detail.exchangeItems.length > 0 && (
                <>
                  <div className="tot__head tot__head--spaced">
                    <span>Purchased</span>
                    <span>
                      {money(
                        detail.exchangeItems.reduce(
                          (n, i) => n + i.unitPrice * i.quantity,
                          0,
                        ),
                        detail.currency,
                      )}
                    </span>
                  </div>
                  <div className="tot__row">
                    <span>Number of items</span>
                    <span className="tot__count">
                      {detail.exchangeItems.reduce((n, i) => n + i.quantity, 0)}
                    </span>
                    <span>
                      {money(
                        detail.exchangeItems.reduce(
                          (n, i) => n + i.unitPrice * i.quantity,
                          0,
                        ),
                        detail.currency,
                      )}
                    </span>
                  </div>
                </>
              )}

              <div className="tot__grand">
                <span>{closed ? "Settled total" : "Total refund"}</span>
                <span>
                  {money(
                    totals.settledTotal ?? totals.estimatedTotal,
                    detail.currency,
                  )}
                </span>
              </div>

              {/*
                An upgrade pays out nothing — the credit is spent on the
                replacement — so the total above is legitimately zero. Without
                this row that zero reads as a bug rather than as "they owe us".
              */}
              {totals.amountDue > 0 && (
                <div className="tot__grand tot__grand--due">
                  <span>Customer owes</span>
                  <span>{money(totals.amountDue, detail.currency)}</span>
                </div>
              )}

              {/*
                How the money actually leaves. Worth stating explicitly: with
                per-line resolutions one return can refund one item, credit
                another and gift-card a third, and "Total refund" alone hides
                that the customer is getting three different things.
              */}
              {detail.payout && detail.payout.length > 0 && (
                <div className="payout">
                  {detail.payout.map((p) => (
                    <div className="payout__row" key={p.resolution}>
                      <span className="payout__label">
                        {PAYOUT_LABEL[p.resolution] ?? titleCase(p.resolution)}
                      </span>
                      <span className="payout__amount">
                        {money(p.amount, detail.currency)}
                      </span>
                    </div>
                  ))}
                  {closed && (
                    <div className="payout__note">
                      Issued {shortDate(detail.resolvedAt ?? detail.submittedAt)}
                    </div>
                  )}
                </div>
              )}
            </div>
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
          {detail.portalSlug && (
            <a
              className="panel panel--link"
              href={`/r/${detail.portalSlug}/status/${detail.reference}?email=${encodeURIComponent(detail.customerEmail)}`}
              target="_blank"
              rel="noreferrer"
            >
              Return status page ↗
            </a>
          )}

          <div className="panel">
            <h2>Shopper info</h2>
            <div className="shopper__name">
              {detail.customerName ?? "Customer"}
            </div>
            <a className="shopper__email" href={`mailto:${detail.customerEmail}`}>
              {detail.customerEmail}
            </a>
            {detail.shopper && (
              <>
                <div className="shopper__stats">
                  <strong>{detail.shopper.orderCount}</strong> orders ·{" "}
                  <strong>{detail.shopper.returnCount}</strong> returns
                </div>
                {/*
                  Deliberately counts rather than a rate. One order can carry
                  several returns, so the ratio runs past 100% and reads as a
                  bug — the raw pair is both honest and easier to judge.
                */}
              </>
            )}
          </div>

          {detail.order?.shippingAddress && (
            <div className="panel">
              <h2>Shipping address</h2>
              <div className="muted">
                {detail.order.shippingAddress.name && (
                  <>
                    {detail.order.shippingAddress.name}
                    <br />
                  </>
                )}
                {detail.order.shippingAddress.lines.join(", ")}
                {detail.order.shippingAddress.phone && (
                  <>
                    <br />
                    {detail.order.shippingAddress.phone}
                  </>
                )}
              </div>
            </div>
          )}

          {detail.shipment && (
            <div className="panel">
              <h2>Return method</h2>
              <dl style={{ margin: 0 }}>
                <div className="kv">
                  <dt>Shipment status</dt>
                  <dd>{titleCase(detail.shipment.status)}</dd>
                </div>
                {detail.shipment.carrier && (
                  <div className="kv">
                    <dt>Carrier</dt>
                    <dd>{detail.shipment.carrier}</dd>
                  </div>
                )}
                {detail.shipment.trackingNumber && (
                  <div className="kv">
                    <dt>Tracking</dt>
                    <dd>
                      {detail.shipment.trackingUrl ? (
                        <a
                          href={detail.shipment.trackingUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {detail.shipment.trackingNumber}
                        </a>
                      ) : (
                        detail.shipment.trackingNumber
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {detail.exchangeDraft ? (
            <ExchangePanel
              draft={detail.exchangeDraft}
              acting={acting}
              onResend={() => void act("exchange/invoice")}
            />
          ) : (
            detail.exchangeItems.length > 0 &&
            !closed && (
              <div className="panel">
                <h2>Exchange</h2>
                <p className="muted" style={{ marginBottom: 12 }}>
                  No exchange order exists for this return. That happens when
                  the automatic attempt at approval failed — check the activity
                  log for the reason.
                </p>
                <button
                  className="btn btn--secondary btn--sm"
                  disabled={acting}
                  onClick={() => void act("exchange/retry")}
                >
                  Create exchange order
                </button>
              </div>
            )
          )}

        </div>
      </div>
    </>
  );
}
