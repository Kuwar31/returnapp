import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, getToken } from "../lib/api";
import { money } from "../lib/format";
import type {
  OrderSession,
  Quote,
  ResolutionType,
  ReturnDetail,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { PortalStepper } from "./PortalLayout";

const RESOLUTION_COPY: Record<
  string,
  { label: string; description: string }
> = {
  REFUND: {
    label: "Refund",
    description: "Back to your original payment method",
  },
  STORE_CREDIT: {
    label: "Store credit",
    description: "Spend it whenever you like",
  },
  EXCHANGE: {
    label: "Exchange",
    description: "Swap for a different size or color",
  },
  INSTANT_EXCHANGE: {
    label: "Instant exchange",
    description: "We ship the replacement right away",
  },
};

interface Selection {
  selected: boolean;
  quantity: number;
  reasonCode: string;
  reasonNote: string;
}

export function SelectItemsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [session, setSession] = useState<OrderSession | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [resolution, setResolution] = useState<ResolutionType>("REFUND");
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Bounce straight back to lookup if the session token is gone or expired.
  useEffect(() => {
    if (!getToken("portal")) navigate(`/r/${slug}`, { replace: true });
  }, [slug, navigate]);

  useEffect(() => {
    let active = true;
    api
      .get<OrderSession>("/portal/session/order", { auth: "portal" })
      .then((data) => {
        if (!active) return;
        setSession(data);
        setSelections(
          Object.fromEntries(
            data.eligibility.items.map((item) => [
              item.id,
              {
                selected: false,
                quantity: 1,
                reasonCode: data.reasons[0]?.code ?? "",
                reasonNote: "",
              },
            ]),
          ),
        );
        setResolution(data.eligibility.allowedResolutions[0] ?? "REFUND");
      })
      .catch((e) => {
        if (!active) return;
        if (e.status === 401) navigate(`/r/${slug}`, { replace: true });
        else setError(e.message);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [slug, navigate]);

  const chosen = useMemo(
    () =>
      Object.entries(selections)
        .filter(([, s]) => s.selected)
        .map(([id, s]) => ({
          orderLineItemId: id,
          quantity: s.quantity,
          reasonCode: s.reasonCode,
          reasonNote: s.reasonNote || undefined,
          photoUrls: [],
        })),
    [selections],
  );

  // Re-quote whenever the basket or resolution changes. Debounced so dragging
  // a quantity selector doesn't fire a request per keystroke.
  useEffect(() => {
    if (chosen.length === 0) {
      setQuote(null);
      return;
    }
    const controller = setTimeout(() => {
      api
        .post<Quote>(
          "/portal/session/quote",
          { resolution, items: chosen },
          { auth: "portal" },
        )
        .then(setQuote)
        .catch(() => setQuote(null));
    }, 250);
    return () => clearTimeout(controller);
  }, [chosen, resolution]);

  const update = (id: string, patch: Partial<Selection>) =>
    setSelections((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<ReturnDetail>(
        "/portal/session/returns",
        {
          resolution,
          items: chosen,
          customerNote: note || undefined,
          exchangeItems: [],
        },
        { auth: "portal" },
      );
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

  if (loading) return <Loading label="Loading your order…" />;
  if (!session) {
    return (
      <div className="card portal__card">
        <ErrorAlert message={error ?? "We couldn't load your order."} />
        <Link className="btn btn--secondary btn--block" to={`/r/${slug}`}>
          Try another order
        </Link>
      </div>
    );
  }

  const { order, policy, reasons, eligibility } = session;
  const currency = order.currency;
  const reasonFor = (code: string) => reasons.find((r) => r.code === code);

  return (
    <>
      <PortalStepper current={1} />
      <div className="card portal__card portal__card--wide">
        <Link className="portal__back" to={`/r/${slug}`}>
          ← Look up a different order
        </Link>

        <div className="spread" style={{ marginBottom: 4 }}>
          <h2>Order #{order.orderNumber}</h2>
          {eligibility.daysRemaining !== null && eligibility.withinWindow && (
            <span className="badge badge--neutral">
              {eligibility.daysRemaining} days left to return
            </span>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 20 }}>
          {order.customerName ? `${order.customerName} · ` : ""}
          Choose the items you'd like to send back.
        </p>

        <ErrorAlert message={error} />

        {!eligibility.withinWindow && (
          <div className="alert alert--warn">
            This order is outside the {eligibility.windowDays}-day return
            window.
          </div>
        )}

        {eligibility.withinWindow && !eligibility.hasEligibleItems && (
          <div className="alert alert--info">
            None of the items on this order are currently returnable.
          </div>
        )}

        <form onSubmit={submit}>
          {eligibility.items.map((item) => {
            const state = selections[item.id];
            if (!state) return null;
            const reason = reasonFor(state.reasonCode);
            return (
              <div
                key={item.id}
                className={`line-item${item.eligible ? "" : " is-disabled"}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Return ${item.title}`}
                  disabled={!item.eligible}
                  checked={state.selected}
                  onChange={(e) =>
                    update(item.id, { selected: e.target.checked })
                  }
                />
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
                    {money(item.unitPrice, item.currency)}
                    {item.returnableQuantity > 1 &&
                      ` · ${item.returnableQuantity} returnable`}
                  </div>
                  {!item.eligible && item.ineligibleReason && (
                    <div className="line-item__meta">
                      {item.ineligibleReason}
                    </div>
                  )}

                  {state.selected && (
                    <div className="line-item__controls">
                      {item.returnableQuantity > 1 && (
                        <select
                          aria-label="Quantity"
                          value={state.quantity}
                          onChange={(e) =>
                            update(item.id, {
                              quantity: Number(e.target.value),
                            })
                          }
                        >
                          {Array.from(
                            { length: item.returnableQuantity },
                            (_, i) => i + 1,
                          ).map((n) => (
                            <option key={n} value={n}>
                              Qty {n}
                            </option>
                          ))}
                        </select>
                      )}
                      <select
                        aria-label="Reason"
                        value={state.reasonCode}
                        onChange={(e) =>
                          update(item.id, { reasonCode: e.target.value })
                        }
                      >
                        {reasons.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      {reason?.requiresNote && (
                        <input
                          type="text"
                          placeholder="Tell us what happened"
                          value={state.reasonNote}
                          onChange={(e) =>
                            update(item.id, { reasonNote: e.target.value })
                          }
                          required
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <h2 style={{ marginTop: 26 }}>How can we make it right?</h2>
          <div className="resolutions">
            {eligibility.allowedResolutions.map((key) => {
              const copy = RESOLUTION_COPY[key];
              if (!copy) return null;
              const showsBonus =
                policy.bonusCreditPercent > 0 &&
                (key === "STORE_CREDIT" ||
                  key === "EXCHANGE" ||
                  key === "INSTANT_EXCHANGE");
              return (
                <label
                  key={key}
                  className={`resolution${
                    resolution === key ? " is-selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolution === key}
                    onChange={() => setResolution(key)}
                  />
                  <span>
                    <span className="resolution__label">{copy.label}</span>
                    <span className="resolution__desc">
                      {copy.description}
                    </span>
                    {showsBonus && (
                      <span className="resolution__bonus">
                        +{policy.bonusCreditPercent}% bonus credit
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="field">
            <label htmlFor="note">Anything else we should know?</label>
            <textarea
              id="note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
            />
          </div>

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
              {quote.shippingFee > 0 && (
                <div className="totals__row">
                  <span>Return shipping</span>
                  <span>−{money(quote.shippingFee, currency)}</span>
                </div>
              )}
              <div className="totals__row totals__row--grand">
                <span>You'll receive</span>
                <span>{money(quote.estimatedTotal, currency)}</span>
              </div>
            </div>
          )}

          <button
            className="btn btn--block"
            type="submit"
            style={{ marginTop: 18 }}
            disabled={
              submitting || chosen.length === 0 || !eligibility.withinWindow
            }
          >
            {submitting ? "Submitting…" : "Submit return request"}
          </button>
        </form>
      </div>
    </>
  );
}
