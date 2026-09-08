import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePortal, useT } from "./PortalLayout";
import { money } from "../lib/format";
import type { Key } from "../lib/i18n";
import { describeVariant } from "./draft";
import type {
  AdvancedExchange,
  EligibleLineItem,
  ExchangeOptions,
  ExchangeProduct,
  ExchangeRecommendation,
  ExchangeRecommendations,
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
  /**
   * The replacement's picture and variant, so the shopper can see what they're
   * swapping to rather than reading its name. Both may be absent on a draft
   * saved before they were recorded, so every use has to tolerate null.
   */
  exchangeImageUrl?: string | null;
  exchangeVariantTitle?: string | null;
  exchangeProductTitle?: string | null;
  /**
   * What `exchangePrice` is denominated in, captured when it was chosen.
   *
   * The draft outlives the page, so a price picked before the merchant changed
   * display currency — or before a deploy that changed how prices are
   * converted — would otherwise be rendered under whatever symbol the page is
   * using now. That put an unconverted "₹100.00" under a converted "₹11,172.00"
   * for the same item. Stale prices are dropped on render rather than relabelled.
   */
  exchangeCurrency: string | null;
  /**
   * The exchange group a catalogue pick came through, and the note the
   * shopper left with it when the group allows one. Both travel to the
   * server, which prices the swap by the group and keeps the note.
   */
  exchangeRuleId?: string | null;
  exchangeNote?: string | null;
}

/**
 * Three top-level routes and nothing more.
 *
 * "Return item" records the intent only — *how* the shopper is paid is a single
 * choice for the whole return, made on the review step. Asking per item would
 * mean answering the same question repeatedly and could produce a return that
 * pays out three different ways for no reason.
 */
/**
 * "size" and "product" render the same panel — a chosen replacement, its
 * options and what the swap costs. They differ only in where the product came
 * from: the item's own siblings, or the catalogue.
 */
/**
 * "ai" sits between the reason and the resolution when the store has turned
 * recommendations on: one suggested replacement, taken or declined, before
 * the ordinary choice.
 */
type Step = "reason" | "ai" | "resolution" | "size" | "browse" | "product";

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
  absorbing = false,
  merchantName,
  initial,
  onCancel,
  onConfirm,
}: {
  item: EligibleLineItem;
  reasons: ReturnReasonOption[];
  allowedResolutions: ResolutionType[];
  currency: string;
  /** The store covers any gap between the two variants. */
  absorbing?: boolean;
  /** Named in the copy, so "we cover it" says who "we" is. */
  merchantName: string;
  initial: ItemDecision | null;
  onCancel: () => void;
  onConfirm: (decision: ItemDecision) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>(initial ? "resolution" : "reason");
  const [reasonId, setReasonId] = useState(initial?.reasonId ?? "");
  const [reasonLabel, setReasonLabel] = useState(initial?.reasonLabel ?? "");
  /** The parent whose sub-reasons are on screen; null at the top level. */
  const [reasonParent, setReasonParent] = useState<ReturnReasonOption | null>(null);
  const [reasonNote, setReasonNote] = useState(initial?.reasonNote ?? "");
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState<ExchangeOptions | null>(null);
  const [products, setProducts] = useState<ExchangeProduct[] | null>(null);
  /** The catalogue product being confirmed, once one is opened from the grid. */
  const [picked, setPicked] = useState<ExchangeProduct | null>(null);
  /**
   * The merchant's own list of what this item may become, if they've set one.
   * Undefined while unknown, null once we know no rule applies.
   */
  const [advanced, setAdvanced] = useState<AdvancedExchange | null | undefined>(
    undefined,
  );
  /** The exchange group the browse step is scoped to, if any. */
  const [ruleId, setRuleId] = useState<string | null>(null);
  /**
   * The recommendation screen's state. `recs` is undefined until asked, null
   * when the store has it off or nothing fits; `recsFor` is the reason it was
   * asked about, since a changed reason deserves a fresh answer.
   */
  const { merchant: portalMerchant, branding } = usePortal();
  const [recs, setRecs] = useState<ExchangeRecommendations | null | undefined>(
    undefined,
  );
  const [recsFor, setRecsFor] = useState<string | null>(null);
  const [recIndex, setRecIndex] = useState(0);
  const [recVariantId, setRecVariantId] = useState<string | null>(null);
  /** What the shopper wrote with a pick, where the group allows a note. */
  const [exchangeNote, setExchangeNote] = useState("");
  /** Preview lookups that failed. Distinct from "loaded, and empty". */
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [productsFailed, setProductsFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  /**
   * The size step no longer commits on click.
   *
   * Picking a size and confirming are separate acts here: the price and the
   * difference owed change with the choice, and a shopper deserves to see both
   * before the drawer closes on them.
   */
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [galleryIndex, setGalleryIndex] = useState(0);

  /** The chosen reason, which may be a parent or one of its children. */
  const reason =
    reasons.find((r) => r.id === reasonId) ??
    reasons.flatMap((r) => r.children ?? []).find((c) => c.id === reasonId);
  /** Options actually worth offering: in stock, and not the one they own. */
  /**
   * What the confirm panel is about.
   *
   * A product picked out of the catalogue is adapted into the same shape the
   * item's own variants arrive in, so one panel serves both — the shopper gets
   * the same picture, price, options and consequence either way, rather than a
   * considered screen for a size change and a bare grid of chips for anything
   * else.
   */
  const swap: ExchangeOptions | null =
    step === "product" && picked
      ? {
          product: {
            id: picked.id,
            title: picked.title,
            images: picked.imageUrl ? [picked.imageUrl] : [],
          },
          variants: picked.variants,
          // Nothing is "the one you already have" when it's a different product.
          currentVariantId: null,
          currency: picked.currency || currency,
        }
      : options;

  const swappableVariants = (swap?.variants ?? []).filter(
    (v) => v.available && v.id !== swap?.currentVariantId,
  );
  /**
   * A swap within the item's own product, which is the only kind the store
   * offers to cover.
   *
   * Decided by comparing product ids, exactly as the server does when it
   * prices the return — the panel is shared by size swaps and catalogue picks,
   * so "which panel am I on" is not the same question. Choosing something else
   * entirely is a change of mind about what to own, and its price gap is
   * settled the ordinary way.
   */
  const sameProduct = Boolean(
    options?.product &&
      swap?.product &&
      swap.product.id === options.product.id,
  );
  const chosen = swap?.variants.find((v) => v.id === chosenId) ?? null;
  /** Positive means they owe the difference; negative means they're owed it. */
  const delta = chosen ? chosen.price - item.unitPrice : 0;
  /**
   * The exchange group a catalogue pick came through. Only on the product
   * step: a size swap is the item's own siblings, whatever group the shopper
   * may have looked at first.
   */
  const activeRule =
    step === "product"
      ? (advanced?.options.find((o) => o.id === ruleId) ?? null)
      : null;
  /** The group settles the gap flat, so the money line says so up front. */
  const evenGroup = activeRule?.pricing === "EVEN";
  const gallery = swap?.product?.images?.length
    ? swap.product.images
    : [chosen?.imageUrl ?? swap?.variants[0]?.imageUrl ?? item.imageUrl].filter(
        (url): url is string => Boolean(url),
      );
  const heading = swap?.product?.title ?? item.title;
  /**
   * The returned item's own variant, named. Prefers the server's label and
   * falls back to the bare title for an order synced before names were stored.
   */
  const variantLabel = item.variantLabel ?? item.variantTitle;
  /** The media pane shows the replacement only once there is one to show. */
  const showGallery = (step === "size" || step === "product") && gallery.length > 0;

  /**
   * What the replacement costs, before a size narrows it down.
   *
   * Falls back to the cheapest in-stock option, since that is the only figure
   * that can't overstate what they'd pay.
   */
  const displayPrice =
    chosen?.price ??
    (swappableVariants.length
      ? Math.min(...swappableVariants.map((v) => v.price))
      : (options?.variants[0]?.price ?? null));

  /**
   * A line explaining why this screen is the one they landed on, taken from
   * the reason they gave rather than from any modelling of other shoppers.
   */
  const suggestion = (() => {
    const label = `${reasonLabel} ${reason?.label ?? ""}`.toLowerCase();
    if (/small|large|fit|size/.test(label)) {
      return t("drawer.suggest.fit");
    }
    if (/wrong item|not as described|different/.test(label)) {
      return t("drawer.suggest.wrongItem");
    }
    return t("drawer.suggest.generic");
  })();
  /**
   * Whatever the merchant actually calls this axis — "Size" for footwear,
   * "Color" elsewhere. Falls back to a neutral word rather than assuming every
   * product is sized.
   *
   * "Title" is Shopify's placeholder on products with no real options, not a
   * name anyone chose, so it is never shown. Capitalised because merchants type
   * these by hand and this store has one entered as "size".
   */
  const rawOptionName = swap?.variants[0]?.options?.[0]?.name ?? "";
  const optionName =
    !rawOptionName || rawOptionName.toLowerCase() === "title"
      ? t("drawer.options")
      : rawOptionName[0].toUpperCase() + rawOptionName.slice(1);

  const canExchange = allowedResolutions.some((r) =>
    ["EXCHANGE", "INSTANT_EXCHANGE"].includes(r),
  );

  /**
   * Where a reason leads. The recommendation screen only when the store has
   * it on and the item can be exchanged at all; it steps aside on its own if
   * nothing fits (see the effect below), so the shopper never lands on an
   * empty page.
   */
  const afterReason = () =>
    setStep(portalMerchant.aiExchange && canExchange ? "ai" : "resolution");

  useEffect(() => {
    if (step !== "ai") return;
    if (recs !== undefined && recsFor === reasonId) return;
    setRecs(undefined);
    setRecsFor(reasonId);
    setRecIndex(0);
    setRecVariantId(null);
    api
      .get<ExchangeRecommendations | null>(
        "/portal/session/exchange/recommendations",
        {
          auth: "portal",
          query: {
            orderLineItemId: item.id,
            reasonId,
            // Their own words carry the detail — "wanted the black one".
            note: reasonNote.trim() || undefined,
          },
        },
      )
      .then((data) => setRecs(data && data.candidates.length > 0 ? data : null))
      .catch(() => setRecs(null));
  }, [step, recs, recsFor, reasonId, item.id]);

  // Nothing to recommend: straight on to the ordinary choice, no dead end.
  useEffect(() => {
    if (step === "ai" && recs === null) setStep("resolution");
  }, [step, recs]);

  /** The candidate on show, and the option of it the shopper has picked. */
  const rec: ExchangeRecommendation | null = recs?.candidates[recIndex] ?? null;
  const recVariants = rec
    ? rec.variants.filter((v) => !(rec.sameProduct && v.id === recs?.currentVariantId))
    : [];
  useEffect(() => {
    if (!rec) return;
    if (recVariantId && recVariants.some((v) => v.id === recVariantId)) return;
    // Open on the option that answers the reason; else the first in stock.
    setRecVariantId(
      (rec.recommendedVariantId &&
      recVariants.some((v) => v.id === rec.recommendedVariantId && v.available)
        ? rec.recommendedVariantId
        : null) ??
        recVariants.find((v) => v.available)?.id ??
        null,
    );
    // recVariants is derived from rec; listing rec is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.id]);
  const recChosen = recVariants.find((v) => v.id === recVariantId) ?? null;
  /**
   * What the swap costs, as the summary will price it: a group priced as an
   * even exchange, or the item's own sizes under an absorbing store, settle
   * flat; otherwise the difference either way.
   */
  const recPrice = recChosen?.price ?? rec?.minPrice ?? 0;
  const recEven =
    rec !== null && (rec.pricing === "EVEN" || (rec.sameProduct && absorbing));
  const recDue = recEven ? 0 : Math.max(0, recPrice - item.unitPrice);
  const recBack = recEven ? 0 : Math.max(0, item.unitPrice - recPrice);
  /** The merchant's own words for the screen, else the app's. */
  const copy = (override: string | null | undefined, key: Key) =>
    override?.trim() || t(key);
  /** Why this option, in a line under the price — only when it's a real answer. */
  const RATIONALE_KEY: Record<string, Key> = {
    SIZE_UP: "ai.why.sizeUp",
    SIZE_DOWN: "ai.why.sizeDown",
    SHORTER: "ai.why.shorter",
    LONGER: "ai.why.longer",
    COLOR: "ai.why.colour",
    REPLACEMENT: "ai.why.replacement",
    HISTORY: "ai.why.history",
  };
  const recWhy =
    rec?.rationale && recVariantId === rec.recommendedVariantId
      ? t(RATIONALE_KEY[rec.rationale.kind], { from: rec.rationale.from ?? "" })
      : null;
  /** The recommended option's values, so its chips can carry the spark. */
  const recStarred = new Set(
    (rec?.recommendedVariantId
      ? recVariants.find((v) => v.id === rec.recommendedVariantId)?.options ?? []
      : []
    ).map((o) => `${o.name}:${o.value}`),
  );
  /** The option axes of the candidate — "Color", "Size" — with their values. */
  const recAxes = (() => {
    const axes = new Map<string, string[]>();
    for (const v of recVariants) {
      for (const o of v.options ?? []) {
        if (o.name.toLowerCase() === "title") continue;
        const values = axes.get(o.name) ?? [];
        if (!values.includes(o.value)) values.push(o.value);
        axes.set(o.name, values);
      }
    }
    return [...axes.entries()];
  })();
  /** Pick a value on one axis, keeping the others where they are if possible. */
  const pickAxis = (axis: string, value: string) => {
    const current = recChosen?.options ?? [];
    const wanted = (v: ExchangeVariant) =>
      v.options.some((o) => o.name === axis && o.value === value);
    const keepsOthers = (v: ExchangeVariant) =>
      current.every(
        (o) => o.name === axis || v.options.some((p) => p.name === o.name && p.value === o.value),
      );
    const next =
      recVariants.find((v) => v.available && wanted(v) && keepsOthers(v)) ??
      recVariants.find((v) => v.available && wanted(v)) ??
      recVariants.find(wanted);
    if (next) setRecVariantId(next.id);
  };
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
    if (options || optionsFailed) return;
    setLoading(step === "size");
    api
      .get<ExchangeOptions>("/portal/session/exchange/variants", {
        auth: "portal",
        query: { orderLineItemId: item.id },
      })
      .then(setOptions)
      .catch(() => {
        /**
         * A failed preview must not look like "there are no other sizes".
         *
         * Writing an empty variant list here hid the exchange option outright,
         * so a shopper whose network hiccuped was quietly told the only thing
         * they could do was take a refund. The flag stops the effect retrying
         * forever while leaving the card on offer; the size step says the
         * options couldn't be loaded and offers a retry, which clears it.
         */
        setOptionsFailed(true);
      })
      .finally(() => setLoading(false));
  }, [step, options, optionsFailed, item.id]);

  useEffect(() => {
    if (step !== "resolution" || advanced !== undefined) return;
    api
      .get<AdvancedExchange | null>("/portal/session/exchange/advanced", {
        auth: "portal",
        query: { orderLineItemId: item.id },
      })
      .then((r) => setAdvanced(r ?? null))
      // No rule is the safe reading: offer the whole catalogue as before.
      .catch(() => setAdvanced(null));
  }, [step, advanced, item.id]);

  useEffect(() => {
    if (step !== "resolution" || products || productsFailed) return;
    api
      .get<{ products: ExchangeProduct[] }>("/portal/session/exchange/products", {
        auth: "portal",
      })
      .then((r) => setProducts(r.products))
      // Same reasoning as above: unknown is not the same as none.
      .catch(() => setProductsFailed(true));
  }, [step, products, productsFailed]);

  useEffect(() => {
    if (step !== "browse") return;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ products: ExchangeProduct[] }>(
          "/portal/session/exchange/products",
          {
            auth: "portal",
            query: {
              search: search || undefined,
              // The group's own list, for the item it applies to.
              ruleId: ruleId ?? undefined,
              orderLineItemId: ruleId ? item.id : undefined,
            },
          },
        )
        .then((r) => setProducts(r.products))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [step, search, ruleId, item.id]);

  // A newly picked variant with its own shot should lead the gallery.
  useEffect(() => {
    if (!chosen?.imageUrl || !options?.product?.images?.length) return;
    const at = options.product.images.indexOf(chosen.imageUrl);
    if (at >= 0) setGalleryIndex(at);
  }, [chosenId, chosen?.imageUrl, options?.product?.images]);

  const finish = (
    resolution: ResolutionType,
    variant?: ExchangeVariant,
    productTitle?: string,
    /** The exchange group a catalogue pick came through, if any. */
    viaRule?: AdvancedExchange["options"][number] | null,
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
      exchangeRuleId: variant && viaRule ? viaRule.id : null,
      exchangeNote:
        variant && viaRule?.allowNote && exchangeNote.trim()
          ? exchangeNote.trim()
          : null,
      exchangeVariantId: variant?.id ?? null,
      exchangeLabel: variant
        ? `${productTitle ?? options?.product?.title ?? ""} · ${variant.title}`.trim()
        : null,
      exchangePrice: variant?.price ?? null,
      exchangeCurrency: variant ? (options?.currency ?? currency) : null,
      exchangeImageUrl: variant?.imageUrl ?? null,
      exchangeVariantTitle: variant
        ? describeVariant(variant.options, variant.title)
        : null,
      exchangeProductTitle: variant
        ? (productTitle ?? options?.product?.title ?? null)
        : null,
    });
  };

  return (
    <div className="drawer" role="dialog" aria-modal="true">
      <div className="drawer__backdrop" onClick={onCancel} />
      <div className={`drawer__panel${step === "ai" ? " drawer__panel--ai" : ""}`}>
        {/*
          One image pane, shared by every step.
          On the swap step it becomes the replacement's gallery — the drawer is
          already two columns, so giving the swap screen its own second column
          would have nested one image pane inside another.
        */}
        <div className="drawer__media">
          {showGallery ? (
            <>
              <div className="swapper__stage">
                <img src={gallery[galleryIndex]} alt={heading} />
                {gallery.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="swapper__arrow swapper__arrow--prev"
                      aria-label={t("drawer.prevImage")}
                      onClick={() =>
                        setGalleryIndex(
                          (i) => (i - 1 + gallery.length) % gallery.length,
                        )
                      }
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="swapper__arrow swapper__arrow--next"
                      aria-label={t("drawer.nextImage")}
                      onClick={() =>
                        setGalleryIndex((i) => (i + 1) % gallery.length)
                      }
                    >
                      ›
                    </button>
                  </>
                )}
              </div>
              {gallery.length > 1 && (
                <div className="swapper__thumbs">
                  {gallery.map((url, i) => (
                    <button
                      key={url}
                      type="button"
                      className={`swapper__thumb${i === galleryIndex ? " is-active" : ""}`}
                      aria-label={`Image ${i + 1}`}
                      aria-current={i === galleryIndex}
                      onClick={() => setGalleryIndex(i)}
                    >
                      <img src={url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <div className="drawer__caption">
                <div className="drawer__title">{heading}</div>
                {chosen && <div className="muted">{chosen.title}</div>}
              </div>
            </>
          ) : (
            <>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.title} />
              ) : (
                <div className="drawer__placeholder" />
              )}
              <div className="drawer__caption">
                <div className="drawer__title">{item.title}</div>
                {variantLabel && <div className="muted">{variantLabel}</div>}
                <div className="muted">{money(item.unitPrice, currency)}</div>
              </div>
            </>
          )}
        </div>

        <div className="drawer__body">
          <button
            className="drawer__close"
            onClick={onCancel}
            aria-label={t("common.close")}
          >
            ✕
          </button>

          {step !== "reason" && (
            <button
              className="drawer__back"
              onClick={() =>
                /* One step back, not one screen back to the start: confirming a
                   catalogue product belongs to the grid it was opened from. */
                step === "product"
                  ? (setPicked(null), setChosenId(null), setStep("browse"))
                  : setStep(
                      step === "resolution" || step === "ai"
                        ? "reason"
                        : "resolution",
                    )
              }
              aria-label={t("common.back")}
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
                    ← {t("drawer.allReasons")}
                  </button>
                  <h2>{reasonParent.label}</h2>
                  <p className="muted" style={{ margin: "6px 0 20px" }}>
                    {t("drawer.closest")}
                  </p>
                </>
              ) : (
                <>
                  <h2>{t("drawer.whyReturning")}</h2>
                  <p className="muted" style={{ margin: "6px 0 20px" }}>
                    {t("drawer.detailsHelp")}
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
                        if (!r.requiresNote) afterReason();
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
                  <label htmlFor="note">{t("drawer.noteLabel")}</label>
                  <textarea
                    id="note"
                    rows={3}
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                    placeholder={t("drawer.notePlaceholder")}
                  />
                  <button
                    className="btn btn--block"
                    style={{ marginTop: 12 }}
                    disabled={!reasonNote.trim()}
                    onClick={() => {
                      setError(null);
                      afterReason();
                    }}
                  >
                    {t("common.continue")}
                  </button>
                </div>
              )}
            </>
          )}

          {step === "ai" && (
            <div className="ai">
              {recs === undefined && (
                <p className="muted">{t("drawer.loadingOptions")}</p>
              )}
              {rec && recs && (
                <>
                  <h2 className="ai__title">
                    <span className="ai__spark" aria-hidden="true">✦</span>{" "}
                    {t("ai.title")}
                  </h2>
                  <p className="muted" style={{ margin: "6px 0 14px" }}>
                    {t("ai.intro")}
                  </p>
                  {recs.candidates.length > 1 && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm ai__switch"
                      onClick={() =>
                        setRecIndex((recIndex + 1) % recs.candidates.length)
                      }
                    >
                      ↻ {copy(branding.aiSwitchLabel, "ai.switch")}
                    </button>
                  )}

                  <div className="ai-card">
                    <div className="ai-card__media">
                      {recIndex === 0 && (
                        <span className="ai-card__flag">✦ {t("ai.bestMatch")}</span>
                      )}
                      {(recChosen?.imageUrl ?? rec.imageUrl) ? (
                        <img src={recChosen?.imageUrl ?? rec.imageUrl ?? ""} alt="" />
                      ) : (
                        <div className="ai-card__blank" />
                      )}
                    </div>
                    <div className="ai-card__body">
                      <div className="ai-card__name">{rec.title}</div>
                      <div className="ai-card__price">
                        {recDue < recPrice - 0.005 && (
                          <s>{money(recPrice, rec.currency || currency)}</s>
                        )}
                        <strong>{money(recDue, rec.currency || currency)}</strong>
                        <span className="muted">
                          {copy(branding.aiPriceCaption, "ai.priceCaption")}
                        </span>
                      </div>
                      {recDue < 0.005 && (
                        <span className="chip ai-card__chip">{t("ai.free")}</span>
                      )}
                      {recWhy && (
                        <p className="ai-card__why">
                          <span aria-hidden="true">✦</span> {recWhy}
                        </p>
                      )}

                      {recAxes.map(([axis, values]) => (
                        <div key={axis} className="ai-card__axis">
                          <h3 className="swapper__label">
                            {axis[0].toUpperCase() + axis.slice(1)}
                          </h3>
                          <div className="swapper__sizes">
                            {values.map((value) => {
                              const selected = recChosen?.options.some(
                                (o) => o.name === axis && o.value === value,
                              );
                              const possible = recVariants.some(
                                (v) =>
                                  v.available &&
                                  v.options.some((o) => o.name === axis && o.value === value),
                              );
                              return (
                                <button
                                  key={value}
                                  type="button"
                                  className={`size${selected ? " is-selected" : ""}${
                                    possible ? "" : " is-out"
                                  }`}
                                  disabled={!possible}
                                  aria-pressed={selected}
                                  onClick={() => pickAxis(axis, value)}
                                >
                                  {/* The spark marks the answer to their reason. */}
                                  {recStarred.has(`${axis}:${value}`) && (
                                    <span className="size__spark" aria-hidden="true">✦ </span>
                                  )}
                                  {value}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      {rec.description && (
                        <details className="ai-card__details">
                          <summary>{copy(branding.aiDetailsTitle, "ai.details")}</summary>
                          <p>{rec.description}</p>
                        </details>
                      )}
                    </div>
                  </div>

                  {recs.candidates.length > 1 && (
                    <>
                      <h3 className="ai__similar-title">
                        {copy(branding.aiSimilarTitle, "ai.similar")}
                      </h3>
                      <div className="ai-similar">
                        {recs.candidates.map((c, i) =>
                          i === recIndex ? null : (
                            <button
                              key={c.id}
                              type="button"
                              className="ai-similar__item"
                              onClick={() => setRecIndex(i)}
                            >
                              {c.imageUrl ? (
                                <img src={c.imageUrl} alt="" />
                              ) : (
                                <span className="ai-card__blank" />
                              )}
                              <span className="ai-similar__price">
                                {money(
                                  c.pricing === "EVEN" || (c.sameProduct && absorbing)
                                    ? 0
                                    : Math.max(0, c.minPrice - item.unitPrice),
                                  c.currency || currency,
                                )}
                              </span>
                              <span className="muted">
                                {copy(branding.aiPriceCaption, "ai.priceCaption")}
                              </span>
                            </button>
                          ),
                        )}
                      </div>
                    </>
                  )}

                  <div className="ai__footer">
                    <p className="ai__outcome">
                      {recDue > 0.005
                        ? t("ai.pay", { amount: money(recDue, rec.currency || currency) })
                        : recBack > 0.005
                          ? t("ai.refund", { amount: money(recBack, rec.currency || currency) })
                          : t("ai.even")}
                    </p>
                    <div className="ai__actions">
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => setStep("resolution")}
                      >
                        {copy(branding.aiSecondaryLabel, "ai.secondary")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={!recChosen}
                        onClick={() =>
                          recChosen &&
                          finish(
                            "EXCHANGE",
                            recChosen,
                            rec.title,
                            rec.ruleId
                              ? { id: rec.ruleId, label: rec.title, pricing: rec.pricing, allowNote: false, preview: [] }
                              : null,
                          )
                        }
                      >
                        {copy(branding.aiPrimaryLabel, "ai.primary")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {step === "resolution" && (
            <>
              <h2>{t("drawer.howProceed")}</h2>

              {canExchange && (swappableVariants.length > 0 || optionsFailed) && (
                <button
                  className="choice choice--feature"
                  onClick={() => setStep("size")}
                >
                  <span className="choice__main">
                    <span className="choice__flag">✦ {t("drawer.bestMatch")}</span>
                    <span className="choice__label">{t("drawer.exchangeSize")}</span>
                    <span className="choice__preview">
                      {item.imageUrl && (
                        <img src={item.imageUrl} alt="" className="choice__thumb" />
                      )}
                      <span className="choice__desc">
                        {/* Never "0 size options": the count is unknown when
                            the preview didn't load, not zero. */}
                        {optionsFailed && swappableVariants.length === 0
                          ? t("drawer.seeAvailable")
                          : t.plural(
                              "drawer.sizeOptions",
                              swappableVariants.length,
                            )}
                      </span>
                    </span>
                  </span>
                  <span className="choice__chevron">›</span>
                </button>
              )}

              {/*
                The merchant's own lists, when they've narrowed what this item
                may become. Each shows a few real products: a card headed
                "Exchange for a new style" with nothing under it says nothing
                about whether it's worth opening.
              */}
              {canExchange &&
                advanced?.options.map((option) => (
                  <button
                    key={option.id}
                    className="choice choice--list"
                    onClick={() => {
                      setRuleId(option.id);
                      setProducts(null);
                      setStep("browse");
                    }}
                  >
                    <span className="choice__main">
                      <span className="choice__label">{option.label}</span>
                      <span className="choice__strip">
                        {option.preview.map((p) => (
                          <span key={p.id} className="choice__strip-item">
                            {p.imageUrl ? (
                              <img src={p.imageUrl} alt="" />
                            ) : (
                              <span className="choice__strip-blank" />
                            )}
                            {advanced.showProductTitles && (
                              <span className="choice__strip-title">
                                {p.title}
                              </span>
                            )}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="choice__chevron">›</span>
                  </button>
                ))}

              {/*
                The open catalogue, offered only when no rule governs this item
                — a merchant who narrowed the choice didn't mean "and also
                everything else".
              */}
              {canExchange &&
                advanced === null &&
                (products === null || products.length > 0 || productsFailed) && (
                <button
                  className="choice"
                  onClick={() => {
                    setRuleId(null);
                    setStep("browse");
                  }}
                >
                  <span className="choice__main">
                    <span className="choice__label">
                      {t("drawer.exchangeProduct")}
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
                  <span className="choice__label">{t("drawer.returnItem")}</span>
                  <span className="choice__desc">
                    {t("drawer.paidNextStep")}
                  </span>
                </span>
                <span className="choice__chevron">›</span>
              </button>
            </>
          )}


          {(step === "size" || step === "product") && (
            <>
              {loading && <p className="muted">{t("drawer.loadingOptions")}</p>}
              {/*
                The preview couldn't be read — Shopify unreachable, store not
                connected — which is not the same thing as "no other sizes".
                Say so and offer another go: the flag is what the fetch effect
                waits on, so clearing it is the retry. Size step only; the
                product step's list carries its own failure state.
              */}
              {step === "size" && !loading && !swap && optionsFailed && (
                <div className="alert alert--error">
                  {t("drawer.optionsFailed")}{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setOptionsFailed(false)}
                  >
                    {t("drawer.tryAgain")}
                  </button>
                </div>
              )}
              {!loading && swap && swap.variants.length === 0 && (
                <div className="alert alert--info">
                  {t("drawer.noOtherOptions")}
                </div>
              )}

              {swap && swap.variants.length > 0 && (
                <div className="swapper__panel">
                  {/* What they're giving up, so the swap reads as a comparison. */}
                  <div className="swapper__current-heading">
                    {t("drawer.returning")}
                  </div>
                  <div className="swapper__current">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt="" />
                    ) : (
                      <span className="swapper__current-blank" />
                    )}
                    <span className="swapper__current-body">
                      {/* Title and price share a row, so the money lines up with
                          the name rather than floating beside a two-line block. */}
                      <span className="swapper__current-top">
                        <span className="swapper__current-title">
                          {item.title}
                        </span>
                        <span className="swapper__current-price">
                          {money(item.unitPrice, currency)}
                        </span>
                      </span>
                      {variantLabel && (
                        <span className="muted">{variantLabel}</span>
                      )}
                    </span>
                  </div>

                  <h2 className="swapper__title">{heading}</h2>
                  {/*
                    Priced before a size is picked. Sizes of one product almost
                    always cost the same, so waiting for a selection hid a
                    number we already knew and made the panel look unfinished.
                  */}
                  {displayPrice !== null && (
                    <div className="swapper__price">
                      {money(displayPrice, swap.currency)}
                    </div>
                  )}

                  {/*
                    Why they are looking at this screen. Drawn from the reason
                    they gave a moment ago — deliberately not "what worked for
                    similar shoppers", which we have no data for and would be
                    inventing.
                  */}
                  {suggestion && (
                    <p className="swapper__hint">
                      <span aria-hidden="true">✦</span> {suggestion}
                    </p>
                  )}

                  {/*
                    The money consequence, stated before they commit rather
                    than discovered on the summary screen.
                  */}
                  {chosen && (
                    <p className="swapper__delta">
                      {/*
                        When the store absorbs the gap there is nothing to pay
                        and nothing coming back, so promising a credit here was
                        simply false — the summary would then show zero.
                      */}
                      {evenGroup
                        ? t("drawer.evenSwap")
                        : absorbing && sameProduct && Math.abs(delta) > 0.005
                        ? t("drawer.absorbed", { store: merchantName })
                        : delta > 0.005
                          ? t("drawer.youPay", {
                              amount: money(delta, swap.currency),
                            })
                          : delta < -0.005
                            ? t("drawer.youGetCredit", {
                                amount: money(-delta, swap.currency),
                              })
                            : t("drawer.evenSwap")}
                    </p>
                  )}

                  <h3 className="swapper__label">{optionName}</h3>
                  <div className="swapper__sizes">
                    {swap.variants.map((v) => {
                      const isCurrent = v.id === swap.currentVariantId;
                      const isChosen = v.id === chosenId;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          className={`size${isChosen ? " is-selected" : ""}${
                            v.available ? "" : " is-out"
                          }`}
                          disabled={!v.available || isCurrent}
                          aria-pressed={isChosen}
                          onClick={() => setChosenId(v.id)}
                          title={
                            isCurrent
                              ? t("drawer.currentOption")
                              : v.available
                                ? money(v.price, swap.currency)
                                : t("drawer.outOfStock")
                          }
                        >
                          {v.title}
                        </button>
                      );
                    })}
                  </div>

                  {/*
                    A word from the shopper, where the group asked for one —
                    "the blue if this sells out", that sort of thing. Kept
                    with the pick, shown to the merchant beside it.
                  */}
                  {activeRule?.allowNote && (
                    <div className="field swapper__note">
                      <label htmlFor="exchange-note">
                        {t("drawer.exchangeNote")}
                      </label>
                      <textarea
                        id="exchange-note"
                        rows={2}
                        maxLength={300}
                        value={exchangeNote}
                        placeholder={t("drawer.exchangeNotePlaceholder")}
                        onChange={(e) => setExchangeNote(e.target.value)}
                      />
                    </div>
                  )}

                  <button
                    className="btn btn--block swapper__confirm"
                    disabled={!chosen}
                    onClick={() =>
                      chosen &&
                      finish("EXCHANGE", chosen, picked?.title, activeRule)
                    }
                  >
                    {chosen
                      ? t("drawer.confirmItem")
                      : t("drawer.chooseOption", {
                          option: optionName.toLowerCase(),
                        })}
                  </button>
                </div>
              )}
            </>
          )}

          {step === "browse" && (
            <>
              <h2>{t("drawer.exchangeProduct")}</h2>
              <div className="field">
                <input
                  placeholder={t("drawer.searchProducts")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {loading && <p className="muted">{t("common.loading")}</p>}
              {/*
                Pictures and prices only. Every variant used to be a chip under
                its product, which turned a browse into a wall of buttons and
                committed the shopper the instant they touched one — no price
                for that variant, no sense of what the swap would cost. Opening
                the product instead gives the same confirm panel a size change
                already gets.
              */}
              <div className="product-grid">
                {products?.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="product"
                    onClick={() => {
                      setPicked(p);
                      setChosenId(
                        p.variants.length === 1 ? p.variants[0].id : null,
                      );
                      setStep("product");
                    }}
                  >
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" />
                    ) : (
                      <div className="product__placeholder" />
                    )}
                    <div className="product__title">{p.title}</div>
                    <div className="product__price">
                      {money(p.minPrice, p.currency || currency)}
                      {p.maxPrice > p.minPrice && "+"}
                    </div>
                  </button>
                ))}
              </div>
              {products?.length === 0 && !loading && (
                <p className="muted">{t("drawer.noProducts")}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
