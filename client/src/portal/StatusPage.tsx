import { data, Link, useParams } from "react-router";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/format";
import type { ReturnDetail } from "../lib/types";
import { StatusBadge } from "../components/StatusBadge";
import { PortalStepper } from "./PortalLayout";
import type { Route } from "./+types/StatusPage";

const RESOLUTION_OUTCOME: Record<string, string> = {
  REFUND: "Refund issued",
  STORE_CREDIT: "Store credit issued",
  EXCHANGE: "Replacement shipped",
  INSTANT_EXCHANGE: "Replacement shipped",
  WARRANTY: "Warranty replacement sent",
};

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

export default function StatusPage({ loaderData }: Route.ComponentProps) {
  const detail = loaderData;
  const { slug } = useParams();

  const reviewed = detail.status !== "SUBMITTED" && detail.status !== "DRAFT";
  const finished = detail.status === "RESOLVED";

  return (
    <>
      <PortalStepper current={2} />
      <div className="card portal__card">
        <div className="spread">
          <StatusBadge status={detail.status} label={detail.statusLabel} />
          <span className="subtle">{detail.reference}</span>
        </div>

        <h2 style={{ marginTop: 16 }}>We've got your request</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          Submitted {shortDate(detail.submittedAt)}. We'll email{" "}
          {detail.customerEmail} with updates.
        </p>

        <ul className="timeline">
          <li className="is-done">
            <span className="timeline__marker" />
            <div>
              <div className="timeline__title">Request submitted</div>
              <div className="timeline__desc">
                {shortDate(detail.submittedAt)}
              </div>
            </div>
          </li>
          <li className={reviewed ? "is-done" : ""}>
            <span className="timeline__marker" />
            <div>
              <div className="timeline__title">Store review</div>
              <div className="timeline__desc">
                {detail.status === "REJECTED"
                  ? (detail.rejectionReason ?? "Declined")
                  : reviewed
                    ? "Approved — send your items back"
                    : "Waiting for the store to review"}
              </div>
            </div>
          </li>
          <li className={finished ? "is-done" : ""}>
            <span className="timeline__marker" />
            <div>
              <div className="timeline__title">
                {RESOLUTION_OUTCOME[detail.resolution] ?? "Resolved"}
              </div>
              <div className="timeline__desc">
                {finished
                  ? shortDate(detail.resolvedAt ?? detail.submittedAt)
                  : "Once your items arrive back with us"}
              </div>
            </div>
          </li>
        </ul>

        {detail.lineItems.map((item) => (
          <div className="line-item" key={item.id}>
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
                Qty {item.quantity}
                {item.reasonLabel && <> · {item.reasonLabel}</>}
              </div>
            </div>
          </div>
        ))}

        <div className="totals">
          <div className="totals__row totals__row--grand">
            <span>{finished ? "You received" : "Estimated total"}</span>
            <span>
              {money(
                detail.totals.settledTotal ?? detail.totals.estimatedTotal,
                detail.currency,
              )}
            </span>
          </div>
        </div>

        <Link
          className="btn btn--secondary btn--block"
          style={{ marginTop: 16 }}
          to={`/r/${slug}`}
        >
          Start another return
        </Link>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  const { slug } = useParams();
  return (
    <div className="card portal__card">
      <h2>We couldn't find that return</h2>
      <p className="muted" style={{ margin: "8px 0 20px" }}>
        The reference and email don't match, or the link has expired.
      </p>
      <Link className="btn btn--secondary btn--block" to={`/r/${slug}`}>
        Back to returns
      </Link>
    </div>
  );
}
