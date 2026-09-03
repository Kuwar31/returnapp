import { useState } from "react";
import { data, Link, useParams, useRevalidator } from "react-router";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/format";
import type { ReturnDetail, ReturnStatus } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { at, type Key, type TranslateFn } from "../lib/i18n";
import { usePortal, useT } from "./PortalLayout";
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
/**
 * What each status means, in the shopper's language.
 *
 * A function of the translator rather than a module constant: a constant is
 * built once at import, before any store's language is known, so it would pin
 * every portal to English. The keys are flat — `status.APPROVED.heading` —
 * so a translator sees the three lines of one state together.
 */
const nextStep = (t: TranslateFn, status: ReturnStatus) => ({
  heading: t(`status.${status}.heading` as Key),
  title: t(`status.${status}.title` as Key),
  body: t(`status.${status}.body` as Key),
});

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

export default function StatusPage({ loaderData }: Route.ComponentProps) {
  const detail = loaderData;
  const { slug } = useParams();
  const revalidator = useRevalidator();
  const { branding, merchant } = usePortal();
  const t = useT();

  const [showDetails, setShowDetails] = useState(true);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = detail.currency;
  const copy = nextStep(t, detail.status);
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
          title: t("status.requestSubmitted"),
          detail: shortDate(detail.submittedAt),
          done: true,
        },
        {
          title: t("status.storeReview"),
          detail:
            detail.status === "REJECTED"
              ? (detail.rejectionReason ?? t("status.declined"))
              : detail.reviewedAt
                ? t("status.approvedOn", { date: shortDate(detail.reviewedAt) })
                : t("status.awaitingReview"),
          done: Boolean(detail.reviewedAt),
        },
        ...(detail.status === "REJECTED"
          ? []
          : [
              {
                title: t("status.resolved"),
                detail: finished
                  ? shortDate(detail.resolvedAt ?? detail.submittedAt)
                  : t("status.onceItemsArrive"),
                done: finished,
              },
            ]),
      ];

  const creditSubtotal = detail.totals.itemsSubtotal;
  const purchaseSubtotal = detail.exchangeItems.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const draft = detail.exchangeDraft;

  /**
   * What the shopper still owes, in the currency this page is showing.
   *
   * The draft order's balance is authoritative — it's what Shopify will
   * actually charge — but only when the draft is denominated in the same
   * currency the page is rendering. Taking its number regardless printed a
   * EUR balance under a rupee sign, which is worse than an estimate.
   *
   * Otherwise it's derived from the rows immediately above it, so the panel
   * adds up: purchases, less the credit and any bonus, plus fees withheld.
   */
  const creditTotal =
    creditSubtotal + detail.totals.bonusCredit - detail.totals.restockingFee;
  const owed =
    draft && draft.currency === currency
      ? draft.balanceDue
      : Math.max(0, Math.round((purchaseSubtotal - creditTotal) * 100) / 100);

  /**
   * Whichever route raised the exchange supplies the link.
   *
   * A completed draft is excluded so a paid exchange doesn't keep inviting
   * payment; the native side needs no such check, since the server only returns
   * a link while the order still carries a balance.
   */
  const payLink =
    (draft?.status !== "COMPLETED" ? draft?.invoiceUrl : null) ??
    detail.exchangePayment?.url ??
    null;

  /** Settled, so every figure and prompt below should read in the past tense. */
  const exchangePaid = draft?.status === "COMPLETED";

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
      setError(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>

      <div className="confirm">
        <div className="confirm__main">
          <h1 className="confirm__heading">{copy.heading}</h1>

          <ErrorAlert message={error} />

          <div className="card confirm__card">
            <div className="confirm__eyebrow">
              <span>
                {detail.order
                  ? t("status.orderNo", { number: detail.order.orderNumber })
                  : t("status.returnWord")}
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
                  {t("status.questionsEmail")}{" "}
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
            <h2 className="confirm__card-title">{t("status.edit")}</h2>

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
              <span className="confirm__action-label">{t("status.cancel")}</span>
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
                  ? t("status.cancelled")
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
                  {busy ? t("status.cancelling") : t("status.confirmCancel")}
                </button>
              </div>
            )}
          </div>

          <Section title="Customer information" defaultOpen={false}>
            <h3 className="confirm__subhead">{t("status.contactInfo")}</h3>
            <p className="muted">{detail.customerEmail}</p>
            {detail.order?.shippingAddress?.phone && (
              <p className="muted">{detail.order.shippingAddress.phone}</p>
            )}

            {detail.order?.shippingAddress && (
              <>
                <h3 className="confirm__subhead">{t("review.shippingAddress")}</h3>
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
            {t("status.startAnother")}
          </Link>
        </div>

        <aside className="confirm__aside">
          <div className="card confirm__summary">
            <div className="confirm__summary-head">
              <h2>{t("review.summary")}</h2>
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
                    <span className="muted">{t("review.creditSubtotal")}</span>
                    <span className="muted">
                      {money(creditSubtotal, currency)}
                    </span>
                  </div>
                  {detail.totals.bonusCredit > 0 && (
                    <div className="summary__line summary__line--credit">
                      <span>{t("totals.bonus")}</span>
                      <span>+{money(detail.totals.bonusCredit, currency)}</span>
                    </div>
                  )}
                  {detail.totals.restockingFee > 0 && (
                    <div className="summary__line">
                      <span className="muted">{t("totals.restocking")}</span>
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
                      <span className="muted">{t("review.purchaseSubtotal")}</span>
                      <span className="muted">
                        {money(purchaseSubtotal, currency)}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="summary__total confirm__total">
              <span>
                {finished ? t("status.youReceived") : t("review.totalRefund")}
              </span>
              <strong>{money(payout, currency)}</strong>
            </div>

            {/*
              Past tense once it's settled. The old copy asked for money that
              had already been handed over, directly above a line saying it had
              been paid.
            */}
            {owed > 0 && (
              <div
                className={`summary__total ${
                  exchangePaid ? "summary__total--paid" : "summary__total--due"
                }`}
              >
                <span>{exchangePaid ? t("status.paid") : t("review.toPay")}</span>
                <strong>{money(owed, currency)}</strong>
              </div>
            )}

            {/*
              The checkout link, rather than only in the email.
              Someone reading "to pay" on this page should be able to act on it
              here — sending them off to find an inbox is where exchanges get
              abandoned.

              Two sources, because the two exchange methods settle differently:
              a draft order carries its own invoice, while a native exchange
              puts the balance on the original order and Shopify supplies the
              link to pay it. Either way the shopper sees one button.
            */}
            {payLink && owed > 0 && (
              <>
                <a
                  className="btn btn--block"
                  style={{ marginTop: 14 }}
                  href={payLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("status.payNow")}
                </a>
                <p className="confirm__pay-note">
                  Secure checkout with {merchant.name}. We'll ship your
                  replacement as soon as your return arrives.
                </p>
                {/*
                  The native link settles the whole order, not this return's
                  share, and the two differ when the order carries another
                  unpaid exchange. Better to say so here than to let checkout
                  ask for a larger number than the line above promised.
                */}
                {detail.exchangePayment &&
                  detail.exchangePayment.currency === currency &&
                  Math.abs(detail.exchangePayment.amount - owed) > 0.01 && (
                    <p className="confirm__pay-note">
                      This order has{" "}
                      {money(detail.exchangePayment.amount, currency)}{" "}
                      outstanding in total, including earlier exchanges, and
                      checkout will settle all of it.
                    </p>
                  )}
              </>
            )}

            {exchangePaid && (
              <div className="confirm__paid">
                <span className="confirm__paid-mark" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <strong>{t("status.paymentReceived")}</strong>
                  <p>
                    Your replacement is being prepared. It ships as soon as your
                    return arrives back with us.
                  </p>
                </div>
              </div>
            )}
          </div>

          {branding.supportEmail && (
            <p className="confirm__help">
              {t("status.questions")}
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
  /*
    `at` rather than the hook: a boundary renders when the route below it
    threw, which includes the case where the layout's own data never arrived —
    so there may be no branding to read a locale from. This falls back to the
    last language the portal rendered in, and to English on a cold load.
  */
  return (
    <div className="card portal__card">
      <h2>{at("status.notFound.title")}</h2>
      <p className="muted" style={{ margin: "8px 0 20px" }}>
        {at("status.notFound.body")}
      </p>
      <Link className="btn btn--secondary btn--block" to={`/r/${slug}`}>
        {at("status.backToReturns")}
      </Link>
    </div>
  );
}
