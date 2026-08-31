import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/format";
import type { DashboardStats, Paginated, ReturnSummary } from "../lib/types";
import { EmptyState, ErrorAlert } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";

export default function DashboardPage() {
  const { session } = useAuth();
  // Every link stays inside the store named in the URL.
  const base = storePath(useParams().store ?? "");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<ReturnSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The stats endpoint reports the currency it converted to, which may not be
  // the shop's own — the merchant can choose to see presentment instead.
  const currency = stats?.currency ?? session?.merchant.currency ?? "USD";

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<DashboardStats>("/admin/returns/stats", { auth: "admin" }),
      api.get<Paginated<ReturnSummary>>("/admin/returns", {
        auth: "admin",
        query: { pageSize: 5 },
      }),
    ])
      .then(([statsData, listData]) => {
        if (!active) return;
        setStats(statsData);
        setRecent(listData.items);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <div className="admin__header">
        <div>
          <h1>Dashboard</h1>
          {session && (
            <p className="muted" style={{ marginTop: 4 }}>
              Portal link:{" "}
              <a
                href={session.merchant.portalUrl}
                target="_blank"
                rel="noreferrer"
              >
                {session.merchant.portalUrl}
              </a>
            </p>
          )}
        </div>
        <Link className="btn btn--sm" to={`${base}/returns`}>
          View all returns
        </Link>
      </div>

      <ErrorAlert message={error} />

      <div className="stat-grid">
        <Stat label="Awaiting review" value={stats?.counts.submitted ?? 0} />
        <Stat label="Approved" value={stats?.counts.approved ?? 0} />
        <Stat label="Received" value={stats?.counts.received ?? 0} />
        <Stat
          label="Open value"
          value={stats ? money(stats.openValue, currency) : "—"}
        />
      </div>

      <div className="table-wrap">
        {recent.length === 0 ? (
          <EmptyState title="No returns yet">
            <p>
              Share your portal link with customers and requests will land
              here.
            </p>
          </EmptyState>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Value</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((request) => (
                <tr key={request.id}>
                  <td>
                    <Link to={`${base}/returns/${request.id}`}>
                      <strong>{request.reference}</strong>
                    </Link>
                  </td>
                  <td>{request.customerName ?? request.customerEmail}</td>
                  <td>{request.itemCount}</td>
                  <td>{money(request.estimatedTotal, request.currency)}</td>
                  <td>
                    <StatusBadge
                      status={request.status}
                      label={request.statusLabel}
                    />
                  </td>
                  <td>{shortDate(request.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
    </div>
  );
}
