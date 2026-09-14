import { useEffect, useState } from "react";
import { redirect, useNavigate, useParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import { money } from "../lib/format";
import type { OrderSession, Quote, ReturnMethodKind } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { useT } from "./PortalLayout";
import { loadDraft, loadMethod, saveMethod, toSelections, type Draft } from "./draft";
import type { Route } from "./+types/MethodPage";

/**
 * The step between picking items and reviewing: how the items go back.
 *
 * One question on its own screen, so the shopper answers it before the
 * review rather than finding it among the totals. The store's routing rules
 * decide what's offered for these particular items and reasons, so the
 * options come from the quote. A store with a single way back has nothing
 * to ask, and the step passes straight through.
 */

/** One glyph per way of sending items back. */
const METHOD_ICONS: Record<ReturnMethodKind, string> = {
  LABEL: "🏷️",
  CARRIER: "🚚",
  STORE: "🏬",
  KEEP: "🌱",
};

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getToken("portal")) throw redirect(`/r/${params.slug}`);
  try {
    return await api.get<OrderSession>("/portal/session/order", { auth: "portal" });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw redirect(`/r/${params.slug}`);
    throw e;
  }
}

export default function MethodPage({ loaderData }: Route.ComponentProps) {
  const { order } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();
  const t = useT();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<ReturnMethodKind | null>(() => loadMethod(order.id));

  // Nothing chosen means the shopper landed here directly: back to the items.
  useEffect(() => {
    const stored = loadDraft(order.id);
    if (Object.keys(stored).length === 0) {
      navigate(`/r/${slug}/items`, { replace: true });
      return;
    }
    setDraft(stored);
  }, [order.id, slug, navigate]);

  // The options and the store's default, for these items and reasons.
  useEffect(() => {
    if (!draft) return;
    const items = toSelections(draft);
    if (items.length === 0) return;
    api
      .post<Quote>("/portal/session/quote", { items }, { auth: "portal" })
      .then(setQuote)
      .catch((e) => setError(e instanceof Error ? e.message : null));
  }, [draft]);

  const options = quote?.returnMethods?.options ?? [];
  const chosen =
    method && options.some((m) => m.kind === method)
      ? method
      : (quote?.returnMethods?.selected ?? null);

  const proceed = (kind: ReturnMethodKind | null) => {
    if (kind) saveMethod(order.id, kind);
    navigate(`/r/${slug}/review`);
  };

  // One way back is no choice at all: straight on to the review.
  useEffect(() => {
    if (quote && options.length <= 1) proceed(options[0]?.kind ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);

  return (
    <div className="method-page">
      <h1>{t("review.method.title")}</h1>

      <ErrorAlert message={error} />

      <div className="card review__card">
        {!quote ? (
          <p className="muted">{t("common.loading")}</p>
        ) : (
          <div className="methods" role="radiogroup" aria-label={t("review.method.title")}>
            {options.map((m) => {
              const selected = chosen === m.kind;
              return (
                <label key={m.kind} className={`method${selected ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name="return-method"
                    checked={selected}
                    onChange={() => setMethod(m.kind)}
                  />
                  <span className="method__icon" aria-hidden="true">
                    {METHOD_ICONS[m.kind]}
                  </span>
                  <span className="method__body">
                    <span className="method__name">{m.name}</span>
                    {m.description && <span className="muted">{m.description}</span>}
                  </span>
                  {m.costMode !== "HIDDEN" && (
                    <span className="method__cost">
                      {m.costMode === "FREE" ? t("review.method.free") : money(m.cost, m.currency)}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        <div className="method-page__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => navigate(`/r/${slug}/items`)}
          >
            {t("common.back")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!quote || !chosen}
            onClick={() => proceed(chosen)}
          >
            {t("common.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
