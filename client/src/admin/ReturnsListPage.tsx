import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { money, shortDate, titleCase } from "../lib/format";
import type { Paginated, ReturnSummary } from "../lib/types";
import { EmptyState, ErrorAlert } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";

const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "SUBMITTED", label: "Awaiting review" },
  { value: "APPROVED", label: "Approved" },
  { value: "IN_TRANSIT", label: "On its way back" },
  { value: "RECEIVED", label: "Received" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "REJECTED", label: "Declined" },
];

export function ReturnsListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const status = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? 1);
  const [search, setSearch] = useState(searchParams.get("search") ?? "");

  const [data, setData] = useState<Paginated<ReturnSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (search) next.set("search", search);
      else next.delete("search");
      next.set("page", "1");
      setSearchParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get<Paginated<ReturnSummary>>("/admin/returns", {
        auth: "admin",
        query: {
          status: status || undefined,
          search: searchParams.get("search") ?? undefined,
          page,
        },
      })
      .then((result) => active && setData(result))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [status, page, searchParams]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;

  return (
    <>
      <div className="admin__header">
        <div>
          <h1>Returns</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {data ? `${data.total} total` : "Loading…"}
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="toolbar">
        <input
          placeholder="Search reference, name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={status}
          onChange={(e) => setParam("status", e.target.value)}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        {loading && !data ? (
          <EmptyState title="Loading returns…" />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No returns match this view">
            <p>Try clearing the filters or search term.</p>
          </EmptyState>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Resolution</th>
                <th>Items</th>
                <th>Value</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((request) => (
                <tr
                  key={request.id}
                  onClick={() => navigate(`/admin/returns/${request.id}`)}
                >
                  <td>
                    <strong>{request.reference}</strong>
                  </td>
                  <td>{request.customerName ?? request.customerEmail}</td>
                  <td>{titleCase(request.resolution)}</td>
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

      {data && totalPages > 1 && (
        <div className="toolbar" style={{ marginTop: 14 }}>
          <button
            className="btn btn--secondary btn--sm"
            disabled={page <= 1}
            onClick={() => setParam("page", String(page - 1))}
          >
            Previous
          </button>
          <span className="subtle">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn--secondary btn--sm"
            disabled={page >= totalPages}
            onClick={() => setParam("page", String(page + 1))}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
