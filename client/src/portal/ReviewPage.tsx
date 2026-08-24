import { useEffect, useState } from "react";
import { redirect, useNavigate, useParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import { money } from "../lib/format";
import type {
  OrderSession,
  Quote,
  ResolutionType,
  ReturnDetail,
} from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { PortalStepper } from "./PortalLayout";
import {
  clearDraft,
  lineIdOf,
  loadDraft,
  saveDraft,
  toSelections,
  type Draft,
} from "./draft";
import type { Route } from "./+types/ReviewPage";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getToken("portal")) throw redirect(`/r/${params.slug}`);
  try {
    return await api.get<OrderSession>("/portal/session/order", {
      auth: "portal",
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      throw redirect(`/r/${params.slug}`);
    }
    throw e;
  }
}

const RESOLUTION_LABEL: Record<string, string> = {
  REFUND: "Refund to original payment method",
  STORE_CREDIT: "Store credit",
  GIFT_CARD: "Gift card",
  EXCHANGE: "Exchange",
  INSTANT_EXCHANGE: "Instant exchange",
};

const RESOLUTION_BLURB: Record<string, string> = {
  REFUND:
    "Receive a refund (minus applicable fees) to your original payment method once your return is approved",
  STORE_CREDIT:
    "Added to your account balance to spend whenever you like, once your return is approved",
  GIFT_CARD:
    "Receive a gift card code via email once your return has been approved",
};

const RESOLUTION_ICON: Record<string, string> = {
  REFUND: "▭",
  STORE_CREDIT: "✦",
  GIFT_CARD: "◈",
};

const EXCHANGE_RESOLUTIONS = ["EXCHANGE", "INSTANT_EXCHANGE"];

export default function ReviewPage({ loaderData }: Route.ComponentProps) {
  const { order, policy, eligibility } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<Draft>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const currency = order.currency;
  const itemById = new Map(eligibility.items.map((i) => [i.id, i]));
  /** Draft keys are articles (`<lineId>#<n>`), so resolve through the line. */
  const itemFor = (key: string) => itemById.get(lineIdOf(key));

  // Nothing chosen means the shopper landed here directly or reloaded after
  // submitting — send them back rather than showing an empty review.
  useEffect(() => {
    const stored = loadDraft(order.id);
    if (Object.keys(stored).length === 0) {
      navigate(`/r/${slug}/items`, { replace: true });
      return;
    }
    setDraft(stored);
  }, [order.id, slug, navigate]);

  useEffect(() => {
    const items = toSelections(draft);
    if (items.length === 0) return;
    api
      .post<Quote>("/portal/session/quote", { items }, { auth: "portal" })
      .then(setQuote)
      .catch((e) => setError(e instanceof Error ? e.message : null));
  }, [draft]);

  const remove = (id: string) => {
    const next = { ...draft };
    delete next[id];
    if (Object.keys(next).length === 0) {
      navigate(`/r/${slug}/items`);
      return;
    }
    setDraft(next);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<ReturnDetail>(
        "/portal/session/returns",
        { items: toSelections(draft) },
        { auth: "portal" },
      );
      clearDraft(order.id);
      navigate(
        `/r/${slug}/status/${created.reference}?email=${encodeURIComponent(
          created.customerEmail,
        )}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  const entries = Object.entries(draft);
  const exchanges = entries.filter(([, d]) => d.exchangeVariantId);
  const returning = entries.filter(
    ([, d]) => !EXCHANGE_RESOLUTIONS.includes(d.resolution),
  );

  /** The payout currently applied to every non-exchange line. */
  const payout =
    returning.length > 0 ? returning[0][1].resolution : null;

  /**
   * Applies one payout to all returned lines.
   *
   * Exchanges are left alone — they're compensated by the replacement itself,
   * not by a payout, so a credit choice has nothing to say about them.
   */
  const choosePayout = (resolution: ResolutionType) => {
    const next: Draft = { ...draft };
    for (const [id, d] of entries) {
      if (EXCHANGE_RESOLUTIONS.includes(d.resolution)) continue;
      next[id] = { ...d, resolution };
    }
    setDraft(next);
    saveDraft(order.id, next);
  };

  return (
    <>
      <PortalStepper current={2} />
      <div className="review">
        <div className="review__main">
          <h1>Review your return</h1>

          <ErrorAlert message={error} />

          <div className="card review__card">
            <h2>Send back your return</h2>
            <p className="muted">Handling fees may apply.</p>
            <div className="review__ship">
              <span className="review__ship-icon" aria-hidden="true">
                🚚
              </span>
              <div>
                <div className="review__ship-title">Box and ship it</div>
                <p className="muted">
                  We'll email instructions once your return is approved. Pack the
                  items securely and send them back to us.
                </p>
              </div>
            </div>
          </div>

          <div className="card review__card">
            <h2>What you're sending back</h2>
            <div className="review__grid">
              {entries.map(([id]) => {
                const item = itemFor(id);
                if (!item) return null;
                return (
                  <div key={id} className="review__tile">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.title} />
                    ) : (
                      <div className="review__tile-blank" />
                    )}
                    <div className="review__tile-title">{item.title}</div>
                    {item.variantTitle && (
                      <div className="muted">{item.variantTitle}</div>
                    )}
                    <button className="linkish" onClick={() => remove(id)}>
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>

            {exchanges.length > 0 && (
              <>
                <h2 style={{ marginTop: 28 }}>What you're getting</h2>
                <div className="review__grid">
                  {exchanges.map(([id, d]) => (
                    <div key={`x-${id}`} className="review__tile">
                      <div className="review__tile-blank" />
                      <div className="review__tile-title">
                        {d.exchangeLabel}
                      </div>
                      {d.exchangePrice !== null && (
                        <div className="muted">
                          {money(d.exchangePrice, currency)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="card review__card">
            <h2>Your details</h2>
            <div className="review__kv">
              <span className="muted">Email</span>
              <span>{order.email}</span>
            </div>
            {order.customerName && (
              <div className="review__kv">
                <span className="muted">Name</span>
                <span>{order.customerName}</span>
              </div>
            )}
            <div className="review__kv">
              <span className="muted">Order</span>
              <span>#{order.orderNumber}</span>
            </div>
          </div>
        </div>

        <aside className="review__aside">
          <div className="card review__summary">
            <h2>Return summary</h2>

            <div className="summary__section">
              <div className="summary__heading">
                <span>Returning ({entries.length})</span>
                <span>{quote ? money(quote.itemsSubtotal, currency) : "—"}</span>
              </div>
              {entries.map(([id, d]) => {
                const item = itemFor(id);
                const line = quote?.lines.find(
                  (l) => l.orderLineItemId === id,
                );
                return (
                  <div key={id} className="summary__row">
                    {item?.imageUrl ? (
                      <img src={item.imageUrl} alt="" />
                    ) : (
                      <span className="summary__blank" />
                    )}
                    <span className="summary__label">
                      {item?.title}
                      <span className="muted">
                        {[item?.variantTitle, d.reasonLabel]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span>
                      {line ? money(line.itemsSubtotal, currency) : ""}
                    </span>
                  </div>
                );
              })}
            </div>

            {exchanges.length > 0 && (
              <div className="summary__section">
                <div className="summary__heading">
                  <span>Exchanging for ({exchanges.length})</span>
                  <span>
                    {quote
                      ? money(
                          quote.lines.reduce(
                            (s, l) => s + l.exchangeValue,
                            0,
                          ),
                          currency,
                        )
                      : "—"}
                  </span>
                </div>
                {exchanges.map(([id, d]) => (
                  <div key={`sx-${id}`} className="summary__row">
                    <span className="summary__blank" />
                    <span className="summary__label">{d.exchangeLabel}</span>
                    <span>
                      {d.exchangePrice !== null
                        ? money(d.exchangePrice, currency)
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {quote && (
              <div className="summary__section">
                {quote.bonusCredit > 0 && (
                  <div className="summary__line summary__line--credit">
                    <span>Bonus credit</span>
                    <span>+{money(quote.bonusCredit, currency)}</span>
                  </div>
                )}
                {quote.restockingFee > 0 && (
                  <div className="summary__line">
                    <span>Restocking fee</span>
                    <span>−{money(quote.restockingFee, currency)}</span>
                  </div>
                )}
              </div>
            )}

            {returning.length > 0 && (
              <div className="summary__section">
                <h3 className="summary__subheading">Credit options</h3>
                {(eligibility.allowedResolutions as ResolutionType[])
                  .filter((r) => !EXCHANGE_RESOLUTIONS.includes(r))
                  .map((r) => {
                    const selected = payout === r;
                    const bonus =
                      r !== "REFUND" && policy.bonusCreditPercent > 0;
                    return (
                      <button
                        key={r}
                        type="button"
                        className={`payout-card${selected ? " is-selected" : ""}`}
                        onClick={() => choosePayout(r)}
                        aria-pressed={selected}
                      >
                        <span className="payout-card__icon" aria-hidden="true">
                          {RESOLUTION_ICON[r] ?? "•"}
                        </span>
                        <span className="payout-card__body">
                          <span className="payout-card__title">
                            {RESOLUTION_LABEL[r]}
                          </span>
                          {bonus && (
                            <span className="payout-card__bonus">
                              +{policy.bonusCreditPercent}% bonus
                            </span>
                          )}
                          <span className="payout-card__blurb">
                            {RESOLUTION_BLURB[r]}
                          </span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}

            <div className="summary__total">
              <span>Total estimated refund</span>
              <strong>
                {quote ? money(quote.estimatedTotal, currency) : "—"}
              </strong>
            </div>

            {quote && quote.amountDue > 0 && (
              <div className="summary__total summary__total--due">
                <span>To pay for your exchange</span>
                <strong>{money(quote.amountDue, currency)}</strong>
              </div>
            )}

            <button
              className="btn btn--block"
              onClick={submit}
              disabled={submitting || !quote}
            >
              {submitting ? "Submitting…" : "Submit return"}
            </button>
            <button
              className="btn btn--secondary btn--block"
              style={{ marginTop: 10 }}
              onClick={() => navigate(`/r/${slug}/items`)}
            >
              Go back
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}
