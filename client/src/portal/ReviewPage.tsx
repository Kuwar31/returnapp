import { useEffect, useRef, useState } from "react";
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
  exchangePriceIn,
  hydrateExchangeDetails,
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

/** The destinations a trade-down's leftover can go to. */
type SurplusMethod = "REFUND" | "STORE_CREDIT" | "GIFT_CARD";

export default function ReviewPage({ loaderData }: Route.ComponentProps) {
  const { order, policy, eligibility } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<Draft>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Where a trade-down's leftover should go. Only used when there is one. */
  const [surplusMethod, setSurplusMethod] = useState<SurplusMethod>("REFUND");

  /**
   * Read from whatever payload the amounts on screen came from, never from the
   * order. The server may render in the customer's presentment currency, and
   * labelling converted figures with the shop's currency is how this page once
   * showed a euro subtotal under a rupee sign.
   */
  const currency = quote?.currency ?? eligibility.items[0]?.currency ?? order.currency;
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


  /**
   * Tops up exchange details a draft saved before these fields existed is
   * missing, so a stale selection heals itself instead of showing a grey box.
   *
   * Guarded to run once. Keying it off the missing image alone would never
   * settle for a variant that genuinely has no picture: the top-up would leave
   * the field null, the draft would still look stale, and the effect would
   * refetch on every render.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || Object.keys(draft).length === 0) return;
    hydrated.current = true;
    void hydrateExchangeDetails(draft, (ids) =>
      api.get("/portal/session/exchange/variant-info", {
        auth: "portal",
        query: { ids: ids.join(",") },
      }),
    ).then((patched) => {
      if (!patched) return;
      setDraft(patched);
      saveDraft(order.id, patched);
    });
  }, [draft, order.id]);

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
        { items: toSelections(draft), exchangeSurplusMethod: surplusMethod },
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

  /** What they end up with once credits and charges meet — see SelectItemsPage. */
  const net = quote ? quote.estimatedTotal - quote.amountDue : 0;

  /**
   * A trade-down leaves the shopper owed money even though every line is an
   * exchange. That leftover deserves the same choice a plain refund gets, so
   * the credit options appear for it too — driven by their own state, since
   * there is no non-exchange line whose resolution could carry the answer.
   */
  const surplus =
    returning.length === 0 && exchanges.length > 0 && quote
      ? quote.estimatedTotal
      : 0;
  const choosingForSurplus = surplus > 0;

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
                    {(item.variantLabel ?? item.variantTitle) && (
                      <div className="muted">
                        {item.variantLabel ?? item.variantTitle}
                      </div>
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
                      {/* Was always a blank square — the picture is in the
                          draft now, same as the returned items opposite. */}
                      {d.exchangeImageUrl ? (
                        <img
                          src={d.exchangeImageUrl}
                          alt={d.exchangeProductTitle ?? ""}
                        />
                      ) : (
                        <div className="review__tile-blank" />
                      )}
                      <div className="review__tile-title">
                        {d.exchangeProductTitle ?? d.exchangeLabel}
                      </div>
                      {d.exchangeVariantTitle && (
                        <div className="muted">{d.exchangeVariantTitle}</div>
                      )}
                      {exchangePriceIn(d, currency) !== null && (
                        <div className="muted">
                          {money(exchangePriceIn(d, currency)!, currency)}
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
                        {[item?.variantLabel ?? item?.variantTitle, d.reasonLabel]
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
                    {/* Same picture the tile opposite shows — this row was the
                        last place still rendering a permanent grey square. */}
                    {d.exchangeImageUrl ? (
                      <img src={d.exchangeImageUrl} alt="" />
                    ) : (
                      <span className="summary__blank" />
                    )}
                    <span className="summary__label">
                      {d.exchangeProductTitle ?? d.exchangeLabel}
                      {d.exchangeVariantTitle && (
                        <span className="muted">{d.exchangeVariantTitle}</span>
                      )}
                    </span>
                    <span>
                      {exchangePriceIn(d, currency) !== null
                        ? money(exchangePriceIn(d, currency)!, currency)
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

            {(returning.length > 0 || choosingForSurplus) && (
              <div className="summary__section">
                <h3 className="summary__subheading">
                  {choosingForSurplus
                    ? "How would you like the difference?"
                    : "Credit options"}
                </h3>
                {(eligibility.allowedResolutions as ResolutionType[])
                  .filter((r) => !EXCHANGE_RESOLUTIONS.includes(r))
                  .map((r) => {
                    const selected = choosingForSurplus
                      ? surplusMethod === r
                      : payout === r;
                    const bonus =
                      r !== "REFUND" && policy.bonusCreditPercent > 0;
                    return (
                      <button
                        key={r}
                        type="button"
                        className={`payout-card${selected ? " is-selected" : ""}`}
                        onClick={() =>
                          choosingForSurplus
                            ? setSurplusMethod(r as SurplusMethod)
                            : choosePayout(r)
                        }
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

            {/* Components first, bottom line last — see SelectItemsPage. */}
            {quote && quote.amountDue > 0 && quote.estimatedTotal > 0 && (
              <>
                <div className="summary__line">
                  <span>Refund for your returns</span>
                  <span>{money(quote.estimatedTotal, currency)}</span>
                </div>
                <div className="summary__line">
                  <span>Cost of your exchange</span>
                  <span>−{money(quote.amountDue, currency)}</span>
                </div>
              </>
            )}

            {!quote ? (
              <div className="summary__total">
                <span>Total estimated refund</span>
                <strong>—</strong>
              </div>
            ) : net >= 0 ? (
              <div className="summary__total">
                <span>Total estimated refund</span>
                <strong>{money(net, currency)}</strong>
              </div>
            ) : (
              <div className="summary__total summary__total--due">
                <span>To pay for your exchange</span>
                <strong>{money(-net, currency)}</strong>
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
