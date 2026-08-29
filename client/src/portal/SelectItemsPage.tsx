import { useEffect, useMemo, useRef, useState } from "react";
import { Link, redirect, useNavigate, useParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import { money } from "../lib/format";
import type { OrderSession, Quote, ResolutionType } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { PortalStepper } from "./PortalLayout";
import { ItemDrawer, type ItemDecision } from "./ItemDrawer";
import {
  articleKey,
  exchangePriceIn,
  hydrateExchangeDetails,
  lineIdOf,
  loadDraft,
  saveDraft,
  toSelections,
} from "./draft";
import type { Route } from "./+types/SelectItemsPage";

/** Loads the order behind the portal token, bouncing to lookup if it's gone. */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getToken("portal")) {
    throw redirect(`/r/${params.slug}`);
  }
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
  REFUND: "Refund",
  STORE_CREDIT: "Store credit",
  GIFT_CARD: "Gift card",
  EXCHANGE: "Exchange",
  INSTANT_EXCHANGE: "Instant exchange",
};

export default function SelectItemsPage({ loaderData }: Route.ComponentProps) {
  const { order, reasonGroups, eligibility } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();

  /** Decisions keyed by article (`<lineId>#<n>`). Absent means "keeping it". */
  const [decisions, setDecisions] = useState<Record<string, ItemDecision>>(() =>
    loadDraft(order.id),
  );
  /** The article whose drawer is open, as an article key. */
  const [openArticle, setOpenArticle] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);


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
    if (hydrated.current || Object.keys(decisions).length === 0) return;
    hydrated.current = true;
    void hydrateExchangeDetails(decisions, (ids) =>
      api.get("/portal/session/exchange/variant-info", {
        auth: "portal",
        query: { ids: ids.join(",") },
      }),
    ).then((patched) => {
      if (!patched) return;
      setDecisions(patched);
      saveDraft(order.id, patched);
    });
  }, [decisions, order.id]);

  /** The payload that carried the amounts owns the currency — see ReviewPage. */
  const currency =
    quote?.currency ?? eligibility.items[0]?.currency ?? order.currency;
  const chosen = useMemo(() => toSelections(decisions), [decisions]);

  // Re-quote whenever a decision changes. Debounced because opening and closing
  // the drawer a few times shouldn't fire a request per keystroke.
  useEffect(() => {
    if (chosen.length === 0) {
      setQuote(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<Quote>("/portal/session/quote", { items: chosen }, { auth: "portal" })
        .then((q) => {
          setQuote(q);
          setError(null);
        })
        .catch((e) => {
          setQuote(null);
          setError(e instanceof Error ? e.message : null);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [chosen]);

  /**
   * Hands off to the review step. Nothing is submitted here — the shopper gets
   * a chance to check the whole return, and what they'd be paid, first.
   */
  const goToReview = () => {
    saveDraft(order.id, decisions);
    navigate(`/r/${slug}/review`);
  };

  // The drawer works on an article; the product it belongs to comes from its key.
  const openItem = openArticle
    ? (eligibility.items.find((i) => i.id === lineIdOf(openArticle)) ?? null)
    : null;
  const eligible = eligibility.items.filter((i) => i.eligible);
  const ineligible = eligibility.items.filter((i) => !i.eligible);
  const count = Object.keys(decisions).length;

  return (
    <>
      <PortalStepper current={1} />
      <div className="card portal__card portal__card--wide">
        <Link className="portal__back" to={`/r/${slug}`}>
          ← Look up a different order
        </Link>

        <h2 className="picker__heading">Select an item to return</h2>
        <p className="picker__sub">
          You'll have the opportunity to add more later.
        </p>
        {eligibility.withinWindow && eligibility.windowClosesAt && (
          <p className="picker__until">
            Returnable until{" "}
            {new Date(eligibility.windowClosesAt).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        )}

        <ErrorAlert message={error} />

        {/*
          Only when a window actually closed.
          An unshipped order has no window yet — `windowClosesAt` is null,
          because the clock starts at fulfilment — and announcing it as "outside
          the 30-day window" told shoppers their time had run out on an order
          that hadn't left the warehouse. Each item says why it isn't available
          on its own row, which is the accurate version of the same news.
        */}
        {!eligibility.withinWindow && eligibility.windowClosesAt && (
          <div className="alert alert--warn">
            This order is outside the {eligibility.windowDays}-day return window.
          </div>
        )}

        {/*
          One row per article, not per line.
          A shopper with three of the same board sees three rows, because each
          unit is returned for its own reason — grouping them behind a quantity
          picker forced one reason onto units that genuinely differ.
        */}
        {eligible.map((item) =>
          Array.from({ length: item.returnableQuantity }, (_, index) => {
            const key = articleKey(item.id, index);
            const decision = decisions[key];
            const numbered = item.returnableQuantity > 1;
            return (
              <div
                key={key}
                className={`pick-card${decision ? " is-chosen" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setOpenArticle(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenArticle(key);
                  }
                }}
              >
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
                  <div className="line-item__title">
                    {item.title}
                    {numbered && (
                      <span className="pick-card__nth">
                        {index + 1} of {item.returnableQuantity}
                      </span>
                    )}
                  </div>
                  <div className="line-item__meta">
                    {item.variantLabel ?? item.variantTitle}
                  </div>

                  {decision ? (
                    <div className="line-item__decision">
                      <strong>{RESOLUTION_LABEL[decision.resolution]}</strong>
                      {decision.reasonLabel && (
                        <div className="muted">{decision.reasonLabel}</div>
                      )}
                      {/*
                        The replacement, shown the way the returned item above
                        is shown. It used to be a run-on line of text, which
                        made the one thing the shopper is choosing harder to
                        read than the thing they already own.
                      */}
                      {decision.exchangeLabel && (
                        <div className="swap">
                          <div className="swap__caption">Exchanging for</div>
                          <div className="swap__item">
                            {decision.exchangeImageUrl ? (
                              <img
                                className="swap__thumb"
                                src={decision.exchangeImageUrl}
                                alt=""
                              />
                            ) : (
                              <div className="swap__thumb" />
                            )}
                            <div className="swap__body">
                              <div className="swap__title">
                                {decision.exchangeProductTitle ??
                                  decision.exchangeLabel}
                              </div>
                              {decision.exchangeVariantTitle && (
                                <div className="swap__variant">
                                  {decision.exchangeVariantTitle}
                                </div>
                              )}
                            </div>
                            {exchangePriceIn(decision, currency) !== null && (
                              <span className="swap__price">
                                {money(
                                  exchangePriceIn(decision, currency)!,
                                  currency,
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="pick-card__side">
                  <span className="pick-card__price">
                    {money(item.unitPrice, currency)}
                  </span>
                  {decision && (
                    <button
                      className="linkish"
                      // Stop the click reaching the card, which would reopen it.
                      onClick={(e) => {
                        e.stopPropagation();
                        setDecisions((prev) => {
                          const next = { ...prev };
                          delete next[key];
                          return next;
                        });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          }),
        )}

        {ineligible.length > 0 && (
          <>
            <p className="section-label">Unavailable for return</p>
            {ineligible.map((item) => (
              <div key={item.id} className="line-item is-disabled">
                {item.imageUrl ? (
                  <img className="line-item__thumb" src={item.imageUrl} alt={item.title} />
                ) : (
                  <div className="line-item__thumb" />
                )}
                <div className="line-item__body">
                  <div className="line-item__title">{item.title}</div>
                  <div className="line-item__meta">
                    {item.variantTitle && <>{item.variantTitle} · </>}
                    {money(item.unitPrice, currency)}
                  </div>
                  <div className="line-item__meta">{item.ineligibleReason}</div>
                </div>
              </div>
            ))}
          </>
        )}

        {quote && (
          <div className="totals">
            <div className="totals__row">
              <span>Item total</span>
              <span>{money(quote.itemsSubtotal, currency)}</span>
            </div>
            {quote.bonusCredit > 0 && (
              <div className="totals__row totals__row--credit">
                <span>Bonus credit</span>
                <span>+{money(quote.bonusCredit, currency)}</span>
              </div>
            )}
            {quote.restockingFee > 0 && (
              <div className="totals__row">
                <span>Restocking fee</span>
                <span>−{money(quote.restockingFee, currency)}</span>
              </div>
            )}
            {/*
              No payout figure here on purpose.

              This step is for choosing what comes back; what it settles to is
              the review step's job, and it changes with the credit option
              picked there. A running "You'll receive" alongside a per-item list
              invited the shopper to read it as final before they had chosen how
              they wanted paying.
            */}
          </div>
        )}
      </div>

      {/* Sticky bar mirrors Loop's: the running count and the way forward stay
          visible however far down the item list the shopper scrolls. */}
      {count > 0 && (
        <div className="portal__bar">
          <span className="portal__bar-label">
            {count} item{count === 1 ? "" : "s"} selected
          </span>
          <button className="btn" onClick={goToReview}>
            Continue with return
          </button>
        </div>
      )}

      {openItem && openArticle && (
        <ItemDrawer
          item={openItem}
          reasons={
            reasonGroups.find((g) => g.id === openItem.reasonGroupId)?.reasons ??
            reasonGroups[0]?.reasons ??
            []
          }
          allowedResolutions={eligibility.allowedResolutions as ResolutionType[]}
          currency={currency}
          initial={decisions[openArticle] ?? null}
          onCancel={() => setOpenArticle(null)}
          onConfirm={(decision) => {
            setDecisions((prev) => ({ ...prev, [openArticle]: decision }));
            setOpenArticle(null);
          }}
        />
      )}
    </>
  );
}
