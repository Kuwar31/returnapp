import { useState } from "react";
import { data, Link, useParams, useRevalidator } from "react-router";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/format";
import type { ReturnDetail, ReturnStatus } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { PortalStepper, usePortal } from "./PortalLayout";
import type { Route } from "./+types/StatusPage";

/**
 * The status page is reachable straight from the confirmation email, so it
 * authenticates on reference + email rather than a portal session.
 */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const email = new URL(request.url).searchParams.get("email");
  if (!email) {
    throw data("This status link is missing its email address.", {
      status: 400,
    });
  }
  return api.get<ReturnDetail>(`/portal/returns/${params.reference}`, {
    query: { slug: params.slug!, email },
  });
}

/**
 * The headline and the "what happens next" card, per status.
 *
 * Written as one table rather than nested ternaries because these are the only
 * words most shoppers will read, and it should be obvious at a glance that
 * every status says something sensible.
 */
const NEXT_STEP: Record<
  ReturnStatus,
  { heading: string; title: string; body: string }
> = {
  DRAFT: {
    heading: "Your return is saved",
    title: "You haven't submitted this yet",
    body: "Pick up where you left off whenever you're ready.",
  },
  SUBMITTED: {
    heading: "Your return has been submitted",
    title: "We're reviewing your request",
    body: "You'll hear from us by email once the store has reviewed it, usually within one business day. Nothing to send back just yet.",
  },
  APPROVED: {
    heading: "Your return has been approved",
    title: "Your return label is on the way",
    body: "We'll email your return label within 24 hours. If you have any questions or don't receive your email, please reach out to us.",
  },
  REJECTED: {
    heading: "Your return wasn't approved",
    title: "This request has been declined",
    body: "Please get in touch if you think this was a mistake — we're happy to take another look.",
  },
  IN_TRANSIT: {
    heading: "Your return is on its way",
    title: "We're waiting for your parcel",
    body: "Once it reaches our warehouse we'll check the items over and settle your return.",
  },
  RECEIVED: {
    heading: "We've got your return",
    title: "Your items are being checked",
    body: "We're inspecting everything now. Your refund or credit follows shortly after.",
  },
  RESOLVED: {
    heading: "Your return is complete",
    title: "All settled",
    body: "Everything has been processed. Thanks for shopping with us.",
  },
  CANCELLED: {
    heading: "Your return was cancelled",
    title: "Nothing more to do",
    body: "This request has been cancelled. You can start a new return any time while the window is open.",
  },
  EXPIRED: {
    heading: "This return has expired",
    title: "The window has closed",
    body: "We didn't receive your items in time. Please contact us if you'd still like to send them back.",
  },
};

/** A card header that toggles its own body, like Loop's disclosure rows. */
function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card confirm__card confirm__card--flush">
      <button
        type="button"
        className="confirm__disclosure"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className={`confirm__caret${open ? " is-open" : ""}`} aria-hidden>
          ▲
        </span>
      </button>
      {open && <div className="confirm__panel">{children}</div>}
    </div>
  );
}

/** A 1–5 rating row. Controlled so a saved score comes back selected. */
function ScoreRow({
  value,
  onChange,
  lowLabel,
  highLabel,
  name,
}: {
  value: number | null;
  onChange: (score: number) => void;
  lowLabel: string;
  highLabel: string;
  name: string;
}) {
  return (
    <>
      <div className="survey__scores" role="radiogroup" aria-label={name}>
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            role="radio"
            aria-checked={value === score}
            className={`survey__score${value === score ? " is-selected" : ""}`}
            onClick={() => onChange(score)}
          >
            {score}
          </button>
        ))}
      </div>
      <div className="survey__ends">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </>
  );
}

export default function StatusPage({ loaderData }: Route.ComponentProps) {
  const detail = loaderData;
  const { slug } = useParams();
  const revalidator = useRevalidator();
  const { branding, merchant } = usePortal();

  const [showDetails, setShowDetails] = useState(true);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ease, setEase] = useState<number | null>(
    detail.feedback?.easeScore ?? null,
  );
  const [repeat, setRepeat] = useState<number | null>(
    detail.feedback?.repeatScore ?? null,
  );
  const [comment, setComment] = useState(detail.feedback?.comment ?? "");
  const [thanked, setThanked] = useState(Boolean(detail.feedback));

  const currency = detail.currency;
  const copy = NEXT_STEP[detail.status];
  const auth = { slug: slug!, email: detail.customerEmail };

  const finished = detail.status === "RESOLVED";
  const cancellable = detail.status === "SUBMITTED";
  const dead = detail.status === "CANCELLED" || detail.status === "EXPIRED";
  const payout = detail.totals.settledTotal ?? detail.totals.estimatedTotal;

  // Asking someone to box up items is only useful while the return is live.
  const showPacking = !dead && detail.lineItems.length > 0;

  /**
   * The three-step progress list — but only the steps that can still happen.
   * A declined return stops at review, and a cancelled one has no progress to
   * show at all, so neither should be left staring at "waiting for the store".
   */
  const timeline = dead
    ? []
    : [
        {
          title: "Request submitted",
          detail: shortDate(detail.submittedAt),
          done: true,
        },
        {
          title: "Store review",
          detail:
            detail.status === "REJECTED"
              ? (detail.rejectionReason ?? "Declined")
              : detail.reviewedAt
                ? `Approved ${shortDate(detail.reviewedAt)}`
                : "Waiting for the store to review",
          done: Boolean(detail.reviewedAt),
        },
        ...(detail.status === "REJECTED"
          ? []
          : [
              {
                title: "Resolved",
                detail: finished
                  ? shortDate(detail.resolvedAt ?? detail.submittedAt)
                  : "Once your items arrive back with us",
                done: finished,
              },
            ]),
      ];

  const creditSubtotal = detail.totals.itemsSubtotal;
  const purchaseSubtotal = detail.exchangeItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  // Upgrades are the only thing the shopper can still owe; a trade-down for
  // something cheaper is already netted off the payout above.
  const amountDue = detail.exchangeItems.reduce(
    (sum, item) => sum + Math.max(0, item.priceDifference) * item.quantity,
    0,
  );

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/portal/returns/${detail.reference}/cancel`, undefined, {
        query: auth,
      });
      setConfirmingCancel(false);
      revalidator.revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/portal/returns/${detail.reference}/feedback`,
        {
          easeScore: ease ?? undefined,
          repeatScore: repeat ?? undefined,
          comment: comment.trim() || undefined,
        },
        { query: auth },
      );
      setThanked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PortalStepper current={2} />

      <div className="confirm">
        <div className="confirm__main">
          <h1 className="confirm__heading">{copy.heading}</h1>

          <ErrorAlert message={error} />

          <div className="card confirm__card">
            <div className="confirm__eyebrow">
              <span>
                {detail.order ? `Order #${detail.order.orderNumber}` : "Return"}
              </span>
              <span>{detail.reference}</span>
            </div>
            <h2 className="confirm__card-title">{copy.title}</h2>
            <p className="muted confirm__card-body">
              {detail.status === "REJECTED" && detail.rejectionReason
                ? detail.rejectionReason
                : copy.body}
              {branding.supportEmail && detail.status !== "REJECTED" && (
                <>
                  {" "}
                  Questions? Email{" "}
                  <a href={`mailto:${branding.supportEmail}`}>
                    {branding.supportEmail}
                  </a>
                  .
                </>
              )}
            </p>

            {timeline.length > 0 && (
              <ul className="timeline confirm__timeline">
                {timeline.map((step) => (
                  <li key={step.title} className={step.done ? "is-done" : ""}>
                    <span className="timeline__marker" />
                    <div>
                      <div className="timeline__title">{step.title}</div>
                      <div className="timeline__desc">{step.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Nothing to pack once the request is off the table. */}
          {showPacking && (
          <Section title="Pack these items. Use the original packaging if possible.">
            <div className="confirm__grid">
              {detail.lineItems.map((item) => (
                <div key={item.id} className="confirm__tile">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.title} />
                  ) : (
                    <div className="confirm__tile-blank" />
                  )}
                  <div className="confirm__tile-title">{item.title}</div>
                  {item.variantTitle && (
                    <div className="muted">{item.variantTitle}</div>
                  )}
                  {item.quantity > 1 && (
                    <div className="muted">Qty {item.quantity}</div>
                  )}
                  <div className="muted">
                    {money(item.lineTotal, currency)}
                  </div>
                </div>
              ))}
            </div>
          </Section>
          )}

          <div className="card confirm__card">
            <h2 className="confirm__card-title">Edit your return</h2>

            <button
              type="button"
              className="confirm__action"
              onClick={() => setConfirmingCancel((v) => !v)}
              disabled={!cancellable}
              aria-expanded={confirmingCancel}
            >
              <span className="confirm__action-icon" aria-hidden>
                🗑
              </span>
              <span className="confirm__action-label">Cancel return</span>
              <span
                className={`confirm__caret${confirmingCancel ? " is-open" : ""}`}
                aria-hidden
              >
                ▲
              </span>
            </button>

            {!cancellable && (
              <p className="muted confirm__note">
                {detail.status === "CANCELLED"
                  ? "This return has been cancelled."
                  : "This return has already been reviewed, so it can't be cancelled here. Contact the store if you need to change it."}
              </p>
            )}

            {confirmingCancel && cancellable && (
              <div className="confirm__cancel">
                <p className="muted">
                  This withdraws your request. Nothing will be refunded and you
                  can start again while the return window is open.
                </p>
                <button
                  className="btn btn--danger"
                  onClick={cancel}
                  disabled={busy}
                >
                  {busy ? "Cancelling…" : "Yes, cancel this return"}
                </button>
              </div>
            )}
          </div>

          <Section title="Customer information" defaultOpen={false}>
            <h3 className="confirm__subhead">Contact info</h3>
            <p className="muted">{detail.customerEmail}</p>
            {detail.order?.shippingAddress?.phone && (
              <p className="muted">{detail.order.shippingAddress.phone}</p>
            )}

            {detail.order?.shippingAddress && (
              <>
                <h3 className="confirm__subhead">Shipping address</h3>
                <p className="muted">
                  {detail.order.shippingAddress.name && (
                    <>
                      {detail.order.shippingAddress.name}
                      <br />
                    </>
                  )}
                  {detail.order.shippingAddress.lines.join(", ")}
                </p>
              </>
            )}
          </Section>

          <Link className="confirm__restart" to={`/r/${slug}`}>
            Start another return
          </Link>
        </div>

        <aside className="confirm__aside">
          <div className="card confirm__summary">
            <div className="confirm__summary-head">
              <h2>Return summary</h2>
              <button
                type="button"
                className="linkish"
                onClick={() => setShowDetails((v) => !v)}
              >
                Details{" "}
                <span className={`confirm__caret${showDetails ? " is-open" : ""}`}>
                  ▲
                </span>
              </button>
            </div>

            {showDetails && (
              <>
                <div className="summary__section">
                  <div className="summary__heading">
                    <span>Return credits ({detail.lineItems.length})</span>
                    <span>({money(creditSubtotal, currency)})</span>
                  </div>
                  {detail.lineItems.map((item) => (
                    <div key={item.id} className="summary__row">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" />
                      ) : (
                        <span className="summary__blank" />
                      )}
                      <span className="summary__label">
                        {item.title}
                        <span className="muted">
                          {[
                            item.variantTitle,
                            item.quantity > 1 ? `Qty ${item.quantity}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span>{money(item.lineTotal, currency)}</span>
                    </div>
                  ))}
                  <div className="summary__line">
                    <span className="muted">Credit subtotal</span>
                    <span className="muted">
                      {money(creditSubtotal, currency)}
                    </span>
                  </div>
                  {detail.totals.bonusCredit > 0 && (
                    <div className="summary__line summary__line--credit">
                      <span>Bonus credit</span>
                      <span>+{money(detail.totals.bonusCredit, currency)}</span>
                    </div>
                  )}
                  {detail.totals.restockingFee > 0 && (
                    <div className="summary__line">
                      <span className="muted">Restocking fee</span>
                      <span className="muted">
                        −{money(detail.totals.restockingFee, currency)}
                      </span>
                    </div>
                  )}
                </div>

                {detail.exchangeItems.length > 0 && (
                  <div className="summary__section">
                    <div className="summary__heading">
                      <span>Purchasing ({detail.exchangeItems.length})</span>
                      <span>{money(purchaseSubtotal, currency)}</span>
                    </div>
                    {detail.exchangeItems.map((item) => (
                      <div key={item.id} className="summary__row">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt="" />
                        ) : (
                          <span className="summary__blank" />
                        )}
                        <span className="summary__label">
                          {item.title}
                          <span className="muted">
                            {[
                              item.variantTitle,
                              item.quantity > 1 ? `Qty ${item.quantity}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span>
                          {money(item.unitPrice * item.quantity, currency)}
                        </span>
                      </div>
                    ))}
                    <div className="summary__line">
                      <span className="muted">Purchase subtotal</span>
                      <span className="muted">
                        {money(purchaseSubtotal, currency)}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="summary__total confirm__total">
              <span>{finished ? "You received" : "Total estimated refund"}</span>
              <strong>{money(payout, currency)}</strong>
            </div>

            {amountDue > 0 && (
              <div className="summary__total summary__total--due">
                <span>To pay for your exchange</span>
                <strong>{money(amountDue, currency)}</strong>
              </div>
            )}
          </div>

          <div className="card survey">
            {thanked ? (
              <>
                <h2 className="survey__title">Thanks for the feedback</h2>
                <p className="muted">
                  We read every response — it's how the returns experience gets
                  better.
                </p>
                <button
                  type="button"
                  className="linkish survey__edit"
                  onClick={() => setThanked(false)}
                >
                  Change my answers
                </button>
              </>
            ) : (
              <>
                <h2 className="survey__title">How was your returns experience?</h2>
                <ScoreRow
                  name="Returns experience"
                  value={ease}
                  onChange={setEase}
                  lowLabel="Very difficult"
                  highLabel="Very easy"
                />

                <h2 className="survey__title">
                  How likely are you to buy from {merchant.name} again?
                </h2>
                <ScoreRow
                  name="Likelihood to buy again"
                  value={repeat}
                  onChange={setRepeat}
                  lowLabel="Not likely at all"
                  highLabel="Very likely"
                />

                <textarea
                  className="survey__comment"
                  placeholder="Tell us more (optional)"
                  rows={4}
                  maxLength={2000}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />

                <button
                  className="btn btn--block"
                  onClick={sendFeedback}
                  disabled={
                    busy || (ease === null && repeat === null && !comment.trim())
                  }
                >
                  {busy ? "Sending…" : "Submit"}
                </button>
              </>
            )}
          </div>

          {branding.supportEmail && (
            <p className="confirm__help">
              Questions?
              <br />
              Contact us at{" "}
              <a href={`mailto:${branding.supportEmail}`}>
                {branding.supportEmail}
              </a>{" "}
              and we'll get straight back to you.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  const { slug } = useParams();
  return (
    <div className="card portal__card">
      <h2>We couldn't find that return</h2>
      <p className="muted" style={{ margin: "8px 0 20px" }}>
        The reference and email don't match, or the link has expired.
      </p>
      <Link className="btn btn--secondary btn--block" to={`/r/${slug}`}>
        Back to returns
      </Link>
    </div>
  );
}
