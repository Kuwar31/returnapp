import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/format";
import type { Paginated, ReturnSummary } from "../lib/types";
import { EmptyState, ErrorAlert } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import { storePath } from "./store-path";

/**
 * The status tabs across the top.
 *
 * One status each, and the only thing that writes `status` — a tab row and a
 * status filter both editing the same parameter can disagree on screen, and
 * whichever the merchant looked at last would be wrong.
 */
const STATUS_TABS = [
  { value: "", label: "All", count: "all" },
  { value: "SUBMITTED", label: "Awaiting review", count: "SUBMITTED" },
  { value: "APPROVED", label: "Approved", count: "APPROVED" },
  { value: "IN_TRANSIT", label: "On its way back", count: "IN_TRANSIT" },
  { value: "RECEIVED", label: "Received", count: "RECEIVED" },
  { value: "RESOLVED", label: "Resolved", count: "RESOLVED" },
  { value: "REJECTED", label: "Declined", count: "REJECTED" },
];

const RESOLUTIONS = [
  { value: "REFUND", label: "Refund" },
  { value: "STORE_CREDIT", label: "Store credit" },
  { value: "EXCHANGE", label: "Exchange" },
  { value: "INSTANT_EXCHANGE", label: "Instant exchange" },
  { value: "GIFT_CARD", label: "Gift card" },
  { value: "WARRANTY", label: "Warranty" },
];

const RESOLUTION_LABELS = Object.fromEntries(
  RESOLUTIONS.map((r) => [r.value, r.label]),
);

const DATE_PRESETS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

/** YYYY-MM-DD, the form both the URL and a date input agree on. */
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return isoDay(d);
};

const list = (params: URLSearchParams, key: string) => {
  const raw = params.get(key);
  return raw ? raw.split(",").filter(Boolean) : [];
};

type Setter = (changes: Record<string, string | null>) => void;

interface FilterDef {
  key: string;
  label: string;
  group: string;
  /** Which parameters this filter owns, so removing it clears all of them. */
  params: string[];
  isSet: (p: URLSearchParams) => boolean;
  /** What the chip reads once the filter has a value. */
  summary: (p: URLSearchParams) => string;
  body: (p: URLSearchParams, set: Setter) => ReactNode;
}

function CheckList({
  options,
  selected,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="filter-pop__list">
      {options.map((option) => (
        <label key={option.value} className="filter-pop__check">
          <input
            type="checkbox"
            checked={selected.includes(option.value)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, option.value]
                  : selected.filter((v) => v !== option.value),
              )
            }
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * The store's own tags, fetched once and kept for the session.
 *
 * Module-level rather than component state because the popover unmounts every
 * time it closes, and re-fetching the same list each time a merchant reopens a
 * chip is a request per glance.
 */
let tagCache: string[] | null = null;

/**
 * A picker, not a text box.
 *
 * Tags match exactly — "Final Sale" and "final sale" are different tags to
 * Shopify and to the query — so typing one is a coin flip that silently
 * returns nothing. Offering the tags actually present on returned items means
 * every option in the list has something behind it.
 */
function TagPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [tags, setTags] = useState<string[] | null>(tagCache);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (tags !== null) return;
    let active = true;
    api
      .get<{ tags: string[] }>("/admin/returns/tags", { auth: "admin" })
      .then((r) => {
        tagCache = r.tags;
        if (active) setTags(r.tags);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [tags]);

  if (failed) return <p className="muted">Couldn't load your tags.</p>;
  if (tags === null) return <p className="muted">Loading tags…</p>;
  if (tags.length === 0) {
    return (
      <p className="muted">
        None of your returned items carry product tags yet. Tags are recorded
        when an order syncs from Shopify.
      </p>
    );
  }

  const shown = tags.filter((t) =>
    t.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      {/* Worth its space once a store has more than a handful. */}
      {tags.length > 8 && (
        <input
          className="filter-pop__search"
          placeholder="Search tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {shown.length === 0 ? (
        <p className="muted">No tag matches that.</p>
      ) : (
        <CheckList
          options={shown.map((t) => ({ value: t, label: t }))}
          selected={selected}
          onChange={onChange}
        />
      )}
    </>
  );
}

const FILTERS: FilterDef[] = [
  {
    key: "resolution",
    label: "Resolution",
    group: "Return request",
    params: ["resolution"],
    isSet: (p) => list(p, "resolution").length > 0,
    summary: (p) => {
      const values = list(p, "resolution");
      const first = RESOLUTION_LABELS[values[0]] ?? values[0];
      return values.length > 1 ? `${first} +${values.length - 1}` : first;
    },
    body: (p, set) => (
      <>
        <div className="filter-pop__head">Resolution is any of</div>
        <CheckList
          options={RESOLUTIONS}
          selected={list(p, "resolution")}
          onChange={(next) =>
            set({ resolution: next.length ? next.join(",") : null })
          }
        />
      </>
    ),
  },
  {
    key: "submitted",
    label: "Submitted",
    group: "Timeline",
    params: ["from", "to"],
    isSet: (p) => Boolean(p.get("from") || p.get("to")),
    summary: (p) => {
      const from = p.get("from");
      const to = p.get("to");
      if (from && to) return `${shortDate(from)} – ${shortDate(to)}`;
      if (from) return `since ${shortDate(from)}`;
      return `until ${shortDate(to!)}`;
    },
    body: (p, set) => (
      <>
        <div className="filter-pop__head">Submitted between</div>
        <div className="filter-pop__list">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.days}
              type="button"
              className="filter-pop__preset"
              onClick={() => set({ from: daysAgo(preset.days), to: null })}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="filter-pop__dates">
          <label>
            <span>From</span>
            <input
              type="date"
              value={p.get("from") ?? ""}
              max={p.get("to") ?? undefined}
              onChange={(e) => set({ from: e.target.value || null })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={p.get("to") ?? ""}
              min={p.get("from") ?? undefined}
              onChange={(e) => set({ to: e.target.value || null })}
            />
          </label>
        </div>
      </>
    ),
  },
  {
    key: "tags",
    label: "Product tag",
    group: "Return item",
    params: ["tags"],
    isSet: (p) => list(p, "tags").length > 0,
    summary: (p) => {
      const values = list(p, "tags");
      return values.length > 1
        ? `${values[0]} +${values.length - 1}`
        : values[0];
    },
    body: (p, set) => (
      <>
        <div className="filter-pop__head">Item is tagged any of</div>
        <TagPicker
          selected={list(p, "tags")}
          onChange={(next) => set({ tags: next.length ? next.join(",") : null })}
        />
      </>
    ),
  },
  {
    key: "flagged",
    label: "Flagged",
    group: "Others",
    params: ["flagged"],
    isSet: (p) => p.get("flagged") === "true",
    summary: () => "Flagged for review",
    body: (p, set) => (
      <>
        <div className="filter-pop__head">Show</div>
        <div className="filter-pop__list">
          <label className="filter-pop__check">
            <input
              type="checkbox"
              checked={p.get("flagged") === "true"}
              onChange={(e) => set({ flagged: e.target.checked ? "true" : null })}
            />
            <span>Only returns flagged for review</span>
          </label>
        </div>
      </>
    ),
  },
];

/** Closes on a click elsewhere and on Escape — what anyone tries first. */
function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return root;
}

function AddFilters({ onAdd }: { onAdd: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useDismiss(open, () => setOpen(false));
  const groups = [...new Set(FILTERS.map((f) => f.group))];

  return (
    <div className="filter-add" ref={root}>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">≡</span> Add filters
      </button>
      {open && (
        <div className="filter-menu" role="menu">
          {groups.map((group) => (
            <div key={group} className="filter-menu__group">
              <div className="filter-menu__label">{group}</div>
              {FILTERS.filter((f) => f.group === group).map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAdd(filter.key);
                    setOpen(false);
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  filter,
  params,
  set,
  onRemove,
  openByDefault,
}: {
  filter: FilterDef;
  params: URLSearchParams;
  set: Setter;
  onRemove: () => void;
  openByDefault: boolean;
}) {
  const [open, setOpen] = useState(openByDefault);
  const root = useDismiss(open, () => setOpen(false));
  const valued = filter.isSet(params);

  return (
    <div className="chip-wrap" ref={root}>
      <span className={`chip${valued ? " chip--set" : ""}`}>
        <button
          type="button"
          className="chip__body"
          onClick={() => setOpen((v) => !v)}
        >
          {filter.label}
          {valued && <span className="chip__value">{filter.summary(params)}</span>}
          <span className="chip__caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <button
          type="button"
          className="chip__x"
          aria-label={`Remove ${filter.label} filter`}
          onClick={onRemove}
        >
          ×
        </button>
      </span>
      {open && (
        <div className="filter-pop">
          {filter.body(params, set)}
          <div className="filter-pop__foot">
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                set(Object.fromEntries(filter.params.map((k) => [k, null])))
              }
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReturnsListPage() {
  const navigate = useNavigate();
  const base = storePath(useParams().store ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  const status = searchParams.get("status") ?? "";
  const page = Number(searchParams.get("page") ?? 1);
  const [search, setSearch] = useState(searchParams.get("search") ?? "");

  /**
   * Filters the merchant has added but not yet given a value.
   *
   * A chip has to exist before it can be filled in, so this holds the ones the
   * URL can't yet describe. Anything with a value is read back from the URL
   * instead, which is what makes a filtered view survive a reload or a paste
   * into someone else's browser.
   */
  const [pending, setPending] = useState<string[]>([]);
  const [justAdded, setJustAdded] = useState<string | null>(null);

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
          resolution: searchParams.get("resolution") ?? undefined,
          tags: searchParams.get("tags") ?? undefined,
          search: searchParams.get("search") ?? undefined,
          from: searchParams.get("from") ?? undefined,
          to: searchParams.get("to") ?? undefined,
          flagged: searchParams.get("flagged") ?? undefined,
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

  /** Any change to a filter starts again at page one. */
  const set: Setter = (changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    next.set("page", "1");
    setSearchParams(next);
  };

  const shown = FILTERS.filter(
    (f) => f.isSet(searchParams) || pending.includes(f.key),
  );

  const removeFilter = (filter: FilterDef) => {
    setPending((prev) => prev.filter((k) => k !== filter.key));
    if (filter.isSet(searchParams)) {
      set(Object.fromEntries(filter.params.map((k) => [k, null])));
    }
  };

  const clearAll = () => {
    setPending([]);
    set(
      Object.fromEntries(
        FILTERS.flatMap((f) => f.params).map((key) => [key, null]),
      ),
    );
  };

  const counts = data?.counts ?? {};
  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;
  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    <>
      <div className="admin__header">
        <div>
          <h1>Returns</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Every request your customers have raised.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="board">
        <div className="tabs" role="tablist">
          {STATUS_TABS.map((tab) => {
            const count = counts[tab.count];
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={status === tab.value}
                className={`tab${status === tab.value ? " is-active" : ""}`}
                onClick={() => set({ status: tab.value || null })}
              >
                {tab.label}
                {/*
                  Only where there is something to see: a row of zeroes reads
                  as broken, and an empty tab is its own answer.
                */}
                {count ? <span className="tab__count">{count}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="board__filters">
          <div className="search">
            <span className="search__icon" aria-hidden="true">
              ⌕
            </span>
            <input
              placeholder="Search by return or order number, customer name, or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="search__clear"
                aria-label="Clear search"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}
          </div>
          <AddFilters
            onAdd={(key) => {
              setPending((prev) => (prev.includes(key) ? prev : [...prev, key]));
              setJustAdded(key);
            }}
          />
        </div>

        {shown.length > 0 && (
          <div className="board__chips">
            {shown.map((filter) => (
              <FilterChip
                key={filter.key}
                filter={filter}
                params={searchParams}
                set={set}
                openByDefault={justAdded === filter.key}
                onRemove={() => removeFilter(filter)}
              />
            ))}
            <button type="button" className="link-btn" onClick={clearAll}>
              Clear all
            </button>
          </div>
        )}

        <div className="board__count">
          {loading && !data
            ? "Loading…"
            : data && data.total > 0
              ? `Showing ${from}–${to} of ${data.total} returns`
              : "No returns to show"}
        </div>

        {loading && !data ? (
          <EmptyState title="Loading returns…" />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No returns match this view">
            <p>Try clearing the filters or search term.</p>
          </EmptyState>
        ) : (
          <div className="board__table">
            <table className="data">
              <thead>
                <tr>
                  <th>Return no.</th>
                  <th>Order no.</th>
                  <th>Customer</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th className="num">Items</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((request) => (
                  <tr
                    key={request.id}
                    onClick={() => navigate(`${base}/returns/${request.id}`)}
                  >
                    <td>
                      <strong>{request.reference}</strong>
                    </td>
                    <td className="muted">
                      {request.orderNumber ? `#${request.orderNumber}` : "—"}
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span>
                          {request.customerName ?? request.customerEmail}
                        </span>
                        {request.customerName && (
                          <span className="cell-stack__sub">
                            {request.customerEmail}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="muted">{shortDate(request.submittedAt)}</td>
                    <td>
                      <StatusBadge
                        status={request.status}
                        label={request.statusLabel}
                      />
                    </td>
                    <td>
                      {/*
                        Tags rather than one word, because a return can be two
                        things at once — an exchange the shopper filled from the
                        catalogue, or one someone has flagged to look at again.
                      */}
                      <span className="tags">
                        <span className="tag">
                          {RESOLUTION_LABELS[request.resolution] ??
                            request.resolution}
                        </span>
                        {request.shopNow && <span className="tag">Shop now</span>}
                        {request.flagged && (
                          <span className="tag tag--warn">Flagged</span>
                        )}
                      </span>
                    </td>
                    <td className="num">{request.itemCount}</td>
                    <td className="num">
                      {money(request.estimatedTotal, request.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && totalPages > 1 && (
          <div className="board__foot">
            <button
              className="btn btn--secondary btn--sm"
              disabled={page <= 1}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("page", String(page - 1));
                setSearchParams(next);
              }}
            >
              Previous
            </button>
            <span className="subtle">
              Page {page} of {totalPages}
            </span>
            <button
              className="btn btn--secondary btn--sm"
              disabled={page >= totalPages}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("page", String(page + 1));
                setSearchParams(next);
              }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
