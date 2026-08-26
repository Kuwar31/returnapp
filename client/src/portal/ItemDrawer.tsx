import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { money } from "../lib/format";
import type {
  EligibleLineItem,
  ExchangeOptions,
  ExchangeProduct,
  ExchangeVariant,
  ResolutionType,
  ReturnReasonOption,
} from "../lib/types";

/** What the drawer hands back once the shopper has decided. */
export interface ItemDecision {
  reasonId: string;
  reasonLabel: string;
  reasonNote: string;
  resolution: ResolutionType;
  exchangeVariantId: string | null;
  /** Kept only to render the summary; the server re-prices from Shopify. */
  exchangeLabel: string | null;
  exchangePrice: number | null;
}

/**
 * Three top-level routes and nothing more.
 *
 * "Return item" records the intent only — *how* the shopper is paid is a single
 * choice for the whole return, made on the review step. Asking per item would
 * mean answering the same question repeatedly and could produce a return that
 * pays out three different ways for no reason.
 */
type Step = "reason" | "resolution" | "size" | "browse";

/**
 * The per-item decision flow: why it's coming back, then how to make it right.
 *
 * Modelled on Loop's drawer because the shape solves a real problem — asking
 * for a reason first lets the exchange step lead with the swap that actually
 * fits the reason ("didn't fit" → a different size).
 */
export function ItemDrawer({
  item,
  reasons,
  allowedResolutions,
  currency,
  initial,
  onCancel,
  onConfirm,
}: {
  item: EligibleLineItem;
  reasons: ReturnReasonOption[];
  allowedResolutions: ResolutionType[];
  currency: string;
  initial: ItemDecision | null;
  onCancel: () => void;
  onConfirm: (decision: ItemDecision) => void;
}) {
  const [step, setStep] = useState<Step>(initial ? "resolution" : "reason");
  const [reasonId, setReasonId] = useState(initial?.reasonId ?? "");
  const [reasonLabel, setReasonLabel] = useState(initial?.reasonLabel ?? "");
  /** The parent whose sub-reasons are on screen; null at the top level. */
  const [reasonParent, setReasonParent] = useState<ReturnReasonOption | null>(null);
  const [reasonNote, setReasonNote] = useState(initial?.reasonNote ?? "");
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState<ExchangeOptions | null>(null);
  const [products, setProducts] = useState<ExchangeProduct[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  /** The chosen reason, which may be a parent or one of its children. */
  const reason =
    reasons.find((r) => r.id === reasonId) ??
    reasons.flatMap((r) => r.children ?? []).find((c) => c.id === reasonId);
  /** Options actually worth offering: in stock, and not the one they own. */
  const swappableVariants = (options?.variants ?? []).filter(
    (v) => v.available && v.id !== options?.currentVariantId,
  );
  const canExchange = allowedResolutions.some((r) =>
    ["EXCHANGE", "INSTANT_EXCHANGE"].includes(r),
  );
  /**
   * Placeholder for a plain return. The review step overwrites every non-
   * exchange line with whatever the shopper picks there, so this only has to
   * be a resolution the policy actually allows.
   */
  const defaultPayout: ResolutionType =
    (allowedResolutions.find((r) => r === "REFUND") ??
      allowedResolutions.find(
        (r) => !["EXCHANGE", "INSTANT_EXCHANGE"].includes(r),
      ) ??
      "REFUND") as ResolutionType;

  /**
   * Prefetch both exchange sources as soon as the shopper reaches the choice.
   *
   * The cards need to *show* what's behind them — sizes available, a few real
   * products — because an option that looks empty doesn't get clicked. Failures
   * are swallowed: a missing preview should degrade the card, never block the
   * shopper from choosing a refund.
   */
  useEffect(() => {
    if (step !== "resolution" && step !== "size") return;
    if (options) return;
    setLoading(step === "size");
    api
      .get<ExchangeOptions>("/portal/session/exchange/variants", {
        auth: "portal",
        query: { orderLineItemId: item.id },
      })
      .then(setOptions)
      .catch(() =>
        setOptions({
          product: null,
          variants: [],
          currentVariantId: null,
          currency,
        }),
      )
      .finally(() => setLoading(false));
  }, [step, options, item.id]);

  useEffect(() => {
    if (step !== "resolution" || products) return;
    api
      .get<{ products: ExchangeProduct[] }>("/portal/session/exchange/products", {
        auth: "portal",
      })
      .then((r) => setProducts(r.products))
      .catch(() => setProducts([]));
  }, [step, products]);

  useEffect(() => {
    if (step !== "browse") return;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ products: ExchangeProduct[] }>(
          "/portal/session/exchange/products",
          { auth: "portal", query: { search: search || undefined } },
        )
        .then((r) => setProducts(r.products))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [step, search]);

  const finish = (
    resolution: ResolutionType,
    variant?: ExchangeVariant,
    productTitle?: string,
  ) => {
    if (reason?.requiresNote && !reasonNote.trim()) {
      setError(`Please tell us a little more about "${reason.label}".`);
      setStep("reason");
      return;
    }
    onConfirm({
      reasonId,
      reasonLabel,
      reasonNote,
      resolution,
      exchangeVariantId: variant?.id ?? null,
      exchangeLabel: variant
        ? `${productTitle ?? options?.product?.title ?? ""} · ${variant.title}`.trim()
        : null,
      exchangePrice: variant?.price ?? null,
    });
  };

  return (
    <div className="drawer" role="dialog" aria-modal="true">
      <div className="drawer__backdrop" onClick={onCancel} />
      <div className="drawer__panel">
        <div className="drawer__media">
          {item.imageUrl ? (
            <img src={item.imageUrl} alt={item.title} />
          ) : (
            <div className="drawer__placeholder" />
          )}
          <div className="drawer__caption">
            <div className="drawer__title">{item.title}</div>
            {item.variantTitle && (
              <div className="muted">{item.variantTitle}</div>
            )}
            <div className="muted">{money(item.unitPrice, currency)}</div>
          </div>
        </div>

        <div className="drawer__body">
          <button
            className="drawer__close"
            onClick={onCancel}
            aria-label="Close"
          >
            ✕
          </button>

          {step !== "reason" && (
            <button
              className="drawer__back"
              onClick={() =>
                setStep(step === "resolution" ? "reason" : "resolution")
              }
              aria-label="Back"
            >
              ←
            </button>
          )}

          {error && <div className="alert alert--error">{error}</div>}

          {step === "reason" && (
            <>
              {reasonParent ? (
                <>
                  <button
                    className="linkish"
                    style={{ marginBottom: 10 }}
                    onClick={() => setReasonParent(null)}
                  >
                    ← All reasons
                  </button>
                  <h2>{reasonParent.label}</h2>
                  <p className="muted" style={{ margin: "6px 0 20px" }}>
                    Which of these is closest?
                  </p>
                </>
              ) : (
                <>
                  <h2>Why are you returning this item?</h2>
                  <p className="muted" style={{ margin: "6px 0 20px" }}>
                    Specific details help us prevent similar issues in future.
                  </p>
                </>
              )}

              <div className="choice-list">
                {(reasonParent?.children ?? reasons).map((r) => {
                  const hasChildren = (r.children?.length ?? 0) > 0;
                  return (
                    <button
                      key={r.id}
                      className={`choice${reasonId === r.id ? " is-selected" : ""}`}
                      onClick={() => {
                        setError(null);
                        if (hasChildren) {
                          setReasonParent(r);
                          return;
                        }
                        setReasonId(r.id);
                        setReasonLabel(
                          reasonParent ? `${reasonParent.label} · ${r.label}` : r.label,
                        );
                        // Reasons needing a note keep the shopper here; the rest
                        // move straight on, which is the common path.
                        if (!r.requiresNote) setStep("resolution");
                      }}
                    >
                      <span>{r.label}</span>
                      <span className="choice__chevron">›</span>
                    </button>
                  );
                })}
              </div>

              {reason?.requiresNote && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label htmlFor="note">Tell us what happened</label>
                  <textarea
                    id="note"
                    rows={3}
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                    placeholder="A short description helps us put it right"
                  />
                  <button
                    className="btn btn--block"
                    style={{ marginTop: 12 }}
                    disabled={!reasonNote.trim()}
                    onClick={() => {
                      setError(null);
                      setStep("resolution");
                    }}
                  >
                    Continue
                  </button>
                </div>
              )}
            </>
          )}

          {step === "resolution" && (
            <>
              <h2>How would you like to proceed?</h2>

              {canExchange && swappableVariants.length > 0 && (
                <button
                  className="choice choice--feature"
                  onClick={() => setStep("size")}
                >
                  <span className="choice__main">
                    <span className="choice__flag">✦ Best match for you</span>
                    <span className="choice__label">Exchange for new size</span>
                    <span className="choice__preview">
                      {item.imageUrl && (
                        <img src={item.imageUrl} alt="" className="choice__thumb" />
                      )}
                      <span className="choice__desc">
                        {swappableVariants.length === 1
                          ? "1 other option available"
                          : `${swappableVariants.length} size options available`}
                      </span>
                    </span>
                  </span>
                  <span className="choice__chevron">›</span>
                </button>
              )}

              {canExchange && (products === null || products.length > 0) && (
                <button className="choice" onClick={() => setStep("browse")}>
                  <span className="choice__main">
                    <span className="choice__label">
                      Exchange for another product
                    </span>
                    {/* A strip of real products, so the option reads as a
                        catalogue rather than an empty promise. */}
                    <span className="choice__strip">
                      {(products ?? []).slice(0, 3).map((p) =>
                        p.imageUrl ? (
                          <img key={p.id} src={p.imageUrl} alt="" />
                        ) : (
                          <span key={p.id} className="choice__strip-blank" />
                        ),
                      )}
                      {products && products.length > 3 && (
                        <span className="choice__strip-more">
                          +{products.length - 3} more
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="choice__chevron">›</span>
                </button>
              )}

              <button className="choice" onClick={() => finish(defaultPayout)}>
                <span className="choice__main">
                  <span className="choice__label">Return item</span>
                  <span className="choice__desc">
                    Choose how you're paid on the next step
                  </span>
                </span>
                <span className="choice__chevron">›</span>
              </button>
            </>
          )}


          {step === "size" && (
            <>
              <h2>Choose a different option</h2>
              {loading && <p className="muted">Loading options…</p>}
              {!loading && options && options.variants.length === 0 && (
                <div className="alert alert--info">
                  This item has no other options. Try exchanging for another
                  product instead.
                </div>
              )}
              <div className="variant-grid">
                {options?.variants.map((v) => {
                  const isCurrent = v.id === options.currentVariantId;
                  return (
                    <button
                      key={v.id}
                      className={`variant${v.available ? "" : " is-out"}`}
                      disabled={!v.available || isCurrent}
                      onClick={() => finish("EXCHANGE", v)}
                      title={
                        isCurrent
                          ? "This is the option you have"
                          : v.available
                            ? undefined
                            : "Out of stock"
                      }
                    >
                      <span className="variant__title">{v.title}</span>
                      <span className="variant__meta">
                        {isCurrent
                          ? "Current"
                          : v.available
                            ? money(v.price, options?.currency ?? currency)
                            : "Sold out"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === "browse" && (
            <>
              <h2>Exchange for another product</h2>
              <div className="field">
                <input
                  placeholder="Search products"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {loading && <p className="muted">Loading…</p>}
              <div className="product-grid">
                {products?.map((p) => (
                  <div key={p.id} className="product">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt={p.title} />
                    ) : (
                      <div className="product__placeholder" />
                    )}
                    <div className="product__title">{p.title}</div>
                    <div className="product__price">
                      {money(p.minPrice, p.currency || currency)}
                      {p.maxPrice > p.minPrice && "+"}
                    </div>
                    <div className="product__variants">
                      {p.variants.map((v) => (
                        <button
                          key={v.id}
                          className="variant variant--sm"
                          onClick={() => finish("EXCHANGE", v, p.title)}
                        >
                          {v.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {products?.length === 0 && !loading && (
                <p className="muted">No products match that search.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
