import { Link } from "react-router";
import { type Key } from "../lib/i18n";
import type { ReturnStatus } from "../lib/types";
import { useT } from "./PortalLayout";

/** What a row needs to know about a return; both lists send exactly this. */
export interface ReturnSummary {
  reference: string;
  status: ReturnStatus;
  createdAt: string;
  /** The email the status page authenticates this return with. */
  email: string;
  items: Array<{ title: string; imageUrl: string | null }>;
}

/**
 * How far along a return is, for the bar on its row — the status page's
 * scale, so the two never disagree. A declined, cancelled or expired return
 * has no progress to show and gets no bar.
 */
const RETURN_PROGRESS: Partial<Record<ReturnStatus, number>> = {
  SUBMITTED: 0.2,
  APPROVED: 0.45,
  IN_TRANSIT: 0.65,
  RECEIVED: 0.85,
  RESOLVED: 1,
};

/**
 * The returns already raised on an order, each its own row — the shape of
 * AfterShip's order page — so a second return is as visible as the first.
 * The pictures are what went back, the headline is the status page's, and
 * the bar is how far along it is; the row opens that page.
 *
 * The status page authenticates on reference and email, so each link carries
 * the return's own email — the one snapshotted when it was submitted, which is
 * what that page checks — rather than the order's, which a merchant may have
 * changed in Shopify since.
 */
export function ReturnRows({ slug, returns }: { slug: string; returns: ReturnSummary[] }) {
  const t = useT();
  return (
    <>
      {returns.map((request) => (
        <Link
          key={request.reference}
          className="return-row"
          to={`/r/${slug}/status/${request.reference}?email=${encodeURIComponent(request.email)}`}
        >
          <div className="return-row__thumbs">
            {request.items.slice(0, 4).map((item, i) =>
              item.imageUrl ? (
                <img key={i} src={item.imageUrl} alt={item.title} />
              ) : (
                <span key={i} className="return-row__thumb-blank" aria-hidden="true" />
              ),
            )}
            {request.items.length > 4 && <span className="return-row__more">+{request.items.length - 4}</span>}
          </div>
          <div className="return-row__ref">{t("orders.returnRef", { reference: request.reference })}</div>
          <div className="return-row__heading">{t(`status.${request.status}.heading` as Key)}</div>
          {RETURN_PROGRESS[request.status] !== undefined && (
            <div className="confirm__progress return-row__progress" aria-hidden="true">
              <span className="confirm__progress-fill" style={{ width: `${RETURN_PROGRESS[request.status]! * 100}%` }}>
                <span className="confirm__progress-knob" />
              </span>
            </div>
          )}
          <span className="return-row__chevron" aria-hidden="true">
            ›
          </span>
        </Link>
      ))}
    </>
  );
}
