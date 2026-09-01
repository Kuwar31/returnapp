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
import {
  clearDraft,
  exchangePriceIn,
  hydrateExchangeDetails,
  cartTotal,
  clearCart,
  lineIdOf,
  loadCart,
  loadDraft,
  loadSubmitted,
  rememberSubmitted,
  saveDraft,
  toSelections,
  toShopSelections,
  type CartLine,
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
  /** The "shop now" basket, if the shopper filled one. */
  const [cart] = useState<CartLine[]>(() => loadCart(order.id));
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Where a trade-down's leftover should go. Only used when there is one. */
  const [surplusMethod, setSurplusMethod] = useState<SurplusMethod>("REFUND");
  /** The "checkout opens in a new page" confirmation, for an upsell exchange. */
  const [payPrompt, setPayPrompt] = useState(false);

  /**
   * A basket turns every returned line into an exchange: the value is pooled
   * and spent, so nothing is being refunded. The server enforces the same rule,
   * which is why the resolutions are rewritten here rather than hoped for.
   */
  const shopping = cart.length > 0;
  const shopPayload = shopping
    ? { shopItems: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) }
    : {};
  // Effects can't depend on a fresh object, so depend on what it says instead.
  const shopPayloadKey = cart
    .map((l) => `${l.variantId}x${l.quantity}`)
    .join(",");

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

  /**
   * Nothing chosen means the shopper landed here directly, reloaded after
   * submitting, or came back from the exchange checkout. If they have already
   * submitted, their summary is what they're looking for — sending them to the
   * item picker showed them their own items greyed out as "already returned",
   * which reads like the return never went through.
   */
  useEffect(() => {
    const stored = loadDraft(order.id);
    if (Object.keys(stored).length === 0) {
      const submitted = loadSubmitted(order.id);
      navigate(
        submitted
          ? `/r/${slug}/status/${submitted.reference}` +
              `?email=${encodeURIComponent(submitted.email)}`
          : `/r/${slug}/items`,
        { replace: true },
      );
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
      .post<Quote>(
        "/portal/session/quote",
        { items: shopping ? toShopSelections(draft) : items, ...shopPayload },
        { auth: "portal" },
      )
      .then(setQuote)
      .catch((e) => setError(e instanceof Error ? e.message : null));
  }, [draft, shopping, shopPayloadKey]);

  const remove = (id: string) => {
    const next = { ...draft };
    delete next[id];
    if (Object.keys(next).length === 0) {
      navigate(`/r/${slug}/items`);
      return;
    }
    setDraft(next);
  };

  const submit = async (payFirst = false) => {
    setSubmitting(true);
    setError(null);
    setPayPrompt(false);

    /**
     * The tab is opened on the click itself, before any awaiting.
     *
     * Browsers only allow a popup while a user gesture is still on the stack,
     * and the checkout URL doesn't exist until the return has been created —
     * so a blank tab is claimed now and pointed at the link once it arrives.
     */
    const checkoutTab = payFirst ? window.open("", "_blank") : null;

    try {
      const created = await api.post<ReturnDetail>(
        "/portal/session/returns",
        {
          items: shopping ? toShopSelections(draft) : toSelections(draft),
          ...shopPayload,
          exchangeSurplusMethod: surplusMethod,
        },
        { auth: "portal" },
      );
      clearDraft(order.id);
      clearCart(order.id);
      // Before the checkout tab is pointed anywhere: from here on, any return
      // to this order in this browser should land on the summary.
      rememberSubmitted(order.id, {
        reference: created.reference,
        email: created.customerEmail,
      });

      const checkout = created.exchangeDraft?.invoiceUrl ?? null;
      if (checkoutTab) {
        if (checkout) {
          checkoutTab.location.href = checkout;
        } else {
          // No link came back — the store settles exchanges on the original
          // order, or the draft failed. Close the blank tab rather than
          // stranding the shopper on it; the status page explains what's next.
          checkoutTab.close();
        }
      }

      navigate(
        `/r/${slug}/status/${created.reference}?email=${encodeURIComponent(
          created.customerEmail,
        )}`,
      );
    } catch (e) {
      checkoutTab?.close();
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
  /** An upgrade: the replacement costs more than the return is worth. */
  const owesMoney = net < 0;

  /**
   * A trade-down leaves the shopper owed money even though every line is an
   * exchange. That leftover deserves the same choice a plain refund gets, so
   * the credit options appear for it too — driven by their own state, since
   * there is no non-exchange line whose resolution could carry the answer.
   */
  const surplus =
    (shopping || (returning.length === 0 && exchanges.length > 0)) && quote
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

            {/*
              The basket, when the shopper spent their value in the catalogue.
              Rendered separately from the per-line swaps below because it isn't
              one: these items answer to the whole return, not to any single
              item going back.
            */}
            {shopping && (
              <>
                <h2 style={{ marginTop: 28 }}>What you're getting</h2>
                <div className="review__grid">
                  {cart.map((line) => (
                    <div key={line.variantId} className="review__tile">
                      {line.imageUrl ? (
                        <img src={line.imageUrl} alt="" />
                      ) : (
                        <div className="review__tile-blank" />
                      )}
                      <div className="review__tile-title">{line.title}</div>
                      {line.variantTitle && (
                        <div className="muted">{line.variantTitle}</div>
                      )}
                      <div className="muted">
                        {line.quantity > 1 && `${line.quantity} × `}
                        {money(line.price, line.currency)}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="review__shop-total">
                  {cart.length} item{cart.length === 1 ? "" : "s"} ·{" "}
                  {money(cartTotal(cart), currency)}{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => navigate(`/r/${slug}/shop`)}
                  >
                    Edit basket
                  </button>
                </p>
              </>
            )}

            {!shopping && exchanges.length > 0 && (
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
            {/*
              Shown because it is where the replacement goes, not as trivia.
              On an upsell the checkout is locked to this address, so seeing it
              here is the shopper's chance to notice it's wrong before paying.
            */}
            {order.shippingAddress && (
              <div className="review__kv review__kv--address">
                <span className="muted">
                  {owesMoney ? "Delivering to" : "Shipping address"}
                </span>
                <address>
                  {order.shippingAddress.name && (
                    <span>{order.shippingAddress.name}</span>
                  )}
                  {order.shippingAddress.lines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </address>
              </div>
            )}
          </div>
        </div>

        <aside className="review__aside">
          <div className="card review__summary">
            <h2>Return summary</h2>

            <div className="summary__section">
              <div className="summary__heading">
                <span>Return credits ({entries.length})</span>
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
              {/* Restated under the list, so the section adds up on its own
                  rather than only against a total four rows further down. */}
              {quote && (
                <div className="summary__line summary__line--subtotal">
                  <span>Credit subtotal</span>
                  <span>{money(quote.itemsSubtotal, currency)}</span>
                </div>
              )}
              {quote && quote.bonusCredit > 0 && (
                <div className="summary__line summary__line--credit">
                  <span>Bonus credit</span>
                  <span>+{money(quote.bonusCredit, currency)}</span>
                </div>
              )}
              {quote && quote.restockingFee > 0 && (
                <div className="summary__line">
                  <span>Restocking fee</span>
                  <span>−{money(quote.restockingFee, currency)}</span>
                </div>
              )}
            </div>

            {/*
              What's being bought, from either route: a per-line swap, or one
              basket paid for with every line's credit pooled. The basket has
              no line to hang from, so keying this off the per-line decisions
              alone left it invisible for the whole of shop now.
            */}
            {(shopping || exchanges.length > 0) && (
              <div className="summary__section">
                <div className="summary__heading">
                  <span>
                    Purchasing ({shopping ? cart.length : exchanges.length})
                  </span>
                  <span>
                    {quote ? money(quote.purchaseSubtotal, currency) : "—"}
                  </span>
                </div>

                {shopping
                  ? cart.map((line) => (
                      <div key={`sc-${line.variantId}`} className="summary__row">
                        {line.imageUrl ? (
                          <img src={line.imageUrl} alt="" />
                        ) : (
                          <span className="summary__blank" />
                        )}
                        <span className="summary__label">
                          {line.title}
                          {line.variantTitle && (
                            <span className="muted">{line.variantTitle}</span>
                          )}
                          {line.quantity > 1 && (
                            <span className="muted">
                              Quantity: {line.quantity}
                            </span>
                          )}
                        </span>
                        <span>
                          {/* Stored when it was added, so only shown while it
                              is still in the money this page is rendering. */}
                          {line.currency === currency
                            ? money(line.price * line.quantity, currency)
                            : ""}
                        </span>
                      </div>
                    ))
                  : exchanges.map(([id, d]) => (
                      <div key={`sx-${id}`} className="summary__row">
                        {/* Same picture the tile opposite shows — this row was
                            the last place still rendering a grey square. */}
                        {d.exchangeImageUrl ? (
                          <img src={d.exchangeImageUrl} alt="" />
                        ) : (
                          <span className="summary__blank" />
                        )}
                        <span className="summary__label">
                          {d.exchangeProductTitle ?? d.exchangeLabel}
                          {d.exchangeVariantTitle && (
                            <span className="muted">
                              {d.exchangeVariantTitle}
                            </span>
                          )}
                        </span>
                        <span>
                          {exchangePriceIn(d, currency) !== null
                            ? money(exchangePriceIn(d, currency)!, currency)
                            : ""}
                        </span>
                      </div>
                    ))}

                {quote && (
                  <div className="summary__line summary__line--subtotal">
                    <span>Purchase subtotal</span>
                    <span>{money(quote.purchaseSubtotal, currency)}</span>
                  </div>
                )}
              </div>
            )}

            {/*
              Two different questions wear the same control. Normally it asks
              how the shopper wants to be paid; when everything has gone into a
              basket there is nothing to be paid *for*, so it can only be about
              the leftover — and a basket has no line whose resolution could
              carry that answer, which is why it has its own state.
            */}
            {(choosingForSurplus || (!shopping && returning.length > 0)) && (
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
              onClick={() => (owesMoney ? setPayPrompt(true) : void submit())}
              disabled={submitting || !quote}
            >
              {submitting
                ? "Submitting…"
                : owesMoney
                  ? "Pay and submit"
                  : "Submit return"}
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

      {/*
        Warns before the tab opens, because the two things about to happen are
        not obvious: checkout is a separate page, and the return is submitted
        either way. Said plainly rather than borrowing AfterShip's countdown —
        nothing here expires a request after ten minutes, and inventing a
        deadline to look urgent would be a lie.
      */}
      {payPrompt && (
        <div className="paydialog" role="dialog" aria-modal="true">
          <div
            className="paydialog__backdrop"
            onClick={() => setPayPrompt(false)}
          />
          <div className="paydialog__panel">
            <h2>Pay and submit</h2>
            <p>
              Checkout will open on a new page. Your return is submitted either
              way — if you'd rather pay later, the link is on your confirmation
              page and in your email.
            </p>
            <p className="paydialog__amount">
              <span>To pay</span>
              <strong>{money(-net, currency)}</strong>
            </p>
            <div className="paydialog__actions">
              <button
                className="btn btn--secondary"
                onClick={() => setPayPrompt(false)}
              >
                Cancel
              </button>
              <button className="btn" onClick={() => void submit(true)}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
