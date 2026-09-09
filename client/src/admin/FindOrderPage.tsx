import { useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { shortDate } from "../lib/format";
import type { FoundCustomer, FoundOrder, OrderSearchResult } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";

/**
 * "Find an order", as Loop lays it out.
 *
 * A customer who writes in rather than using the portal still needs a return
 * raised, and the merchant knows only a name, an email or an order number.
 * The search lists matching customers with their orders; "Start return"
 * opens the portal signed in to one, so the merchant walks through the
 * shopper's own steps on their behalf, and the share button copies that
 * same link to send to the customer.
 */

type SearchBy = "name" | "email" | "number";

const SEARCH_BY: Array<{ value: SearchBy; label: string; placeholder: string }> = [
  { value: "name", label: "Customer name", placeholder: "Search customer name" },
  { value: "email", label: "Customer email", placeholder: "Search customer email" },
  { value: "number", label: "Order number", placeholder: "Search order number" },
];

const DAY = 24 * 60 * 60 * 1000;

/** "Jan 26, 2026 (226 days)" — when, and how long ago, at a glance. */
const placed = (value: string): string => {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / DAY));
  return `${shortDate(value)} (${days} day${days === 1 ? "" : "s"})`;
};

const itemCount = (n: number): string =>
  n >= 5 ? "5+ items" : `${n} item${n === 1 ? "" : "s"}`;

function OrderRow({
  order,
  basePath,
  onLink,
  copied,
}: {
  order: FoundOrder;
  basePath: string;
  onLink: (order: FoundOrder, mode: "open" | "copy") => void;
  copied: boolean;
}) {
  const address = order.shippingAddress;
  return (
    <div className="orow">
      <div className="orow__number">
        {order.shopifyUrl ? (
          <a href={order.shopifyUrl} target="_blank" rel="noreferrer">
            #{order.orderNumber} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <span>#{order.orderNumber}</span>
        )}
      </div>
      <div className="orow__date">{placed(order.placedAt)}</div>
      <div className="orow__items">{itemCount(order.itemCount)}</div>
      <div className="orow__address" title={address?.lines.join("\n") ?? undefined}>
        {address?.lines[0] ?? <span className="muted">No address</span>}
        {order.returns.length > 0 && (
          <div className="orow__returns">
            {order.returns.map((r) => (
              <Link key={r.id} to={`${basePath}/returns/${r.id}`} className="chip">
                {r.reference}
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="orow__actions">
        <button type="button" className="link-btn" onClick={() => onLink(order, "open")}>
          Start return
        </button>
        <button
          type="button"
          className="orow__share"
          title={copied ? "Link copied" : "Copy a link to start this return"}
          aria-label={copied ? "Link copied" : "Copy a link to start this return"}
          onClick={() => onLink(order, "copy")}
        >
          {copied ? "✓" : "⤴"}
        </button>
      </div>
    </div>
  );
}

export default function FindOrderPage() {
  const { session } = useAuth();
  const [by, setBy] = useState<SearchBy>("name");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<OrderSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const basePath = storePath(session!.merchant.slug);
  const option = SEARCH_BY.find((o) => o.value === by)!;

  const search = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    try {
      const found = await api.get<OrderSearchResult>("/admin/orders/search", {
        auth: "admin",
        query: { by, q: query.trim() },
      });
      setResult(found);
      // One customer found: open them, since that's what the search was for.
      setOpen(new Set(found.customers.length === 1 ? [found.customers[0].email] : []));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't search orders.");
    } finally {
      setSearching(false);
    }
  };

  const toggle = (email: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  /**
   * "Start return" opens the portal in a new tab; the tab is claimed on the
   * click, before the link exists, since browsers only allow it then. The
   * share button puts the same link on the clipboard for the customer.
   */
  const link = async (order: FoundOrder, mode: "open" | "copy") => {
    const tab = mode === "open" ? window.open("", "_blank") : null;
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(
        `/admin/orders/${order.id}/return-link`,
        undefined,
        { auth: "admin" },
      );
      if (tab) {
        tab.location.href = url;
      } else {
        await navigator.clipboard.writeText(url);
        setCopiedId(order.id);
        window.setTimeout(() => setCopiedId((id) => (id === order.id ? null : id)), 2500);
      }
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Couldn't make a return link.");
    }
  };

  return (
    <>
      <Link className="subtle" to={`${basePath}/returns`}>
        ← Returns
      </Link>
      <div className="admin__header">
        <div>
          <h1>Find an order</h1>
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="panel finder">
        <form className="finder__bar" onSubmit={(e) => void search(e)}>
          <select
            className="finder__by"
            value={by}
            aria-label="Search by"
            onChange={(e) => setBy(e.target.value as SearchBy)}
          >
            {SEARCH_BY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="search">
            <span className="search__icon" aria-hidden="true">
              ⌕
            </span>
            <input
              value={query}
              placeholder={option.placeholder}
              aria-label={option.placeholder}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="search__clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
          <button type="submit" className="btn btn--secondary" disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>

        {result === null ? (
          <div className="finder__hero">
            <h2>Create, copy and share links to start any return.</h2>
            <p className="muted">Search for an order to get started.</p>
          </div>
        ) : result.customers.length === 0 ? (
          <div className="finder__hero">
            <h2>No orders match.</h2>
            <p className="muted">
              {by === "number"
                ? "Check the number, or try the customer's email instead."
                : "Try another spelling, or search by order number."}
            </p>
          </div>
        ) : (
          <>
            <p className="finder__found">These customers match your search criteria</p>
            <div className="custs">
              {result.customers.map((customer: FoundCustomer) => {
                const expanded = open.has(customer.email);
                return (
                  <div key={customer.email} className="cust">
                    <button
                      type="button"
                      className="cust__row"
                      aria-expanded={expanded}
                      onClick={() => toggle(customer.email)}
                    >
                      <span className="cust__name">{customer.name ?? "—"}</span>
                      <span className="cust__email">{customer.email}</span>
                      <span className="cust__count">
                        {customer.orderCount} order{customer.orderCount === 1 ? "" : "s"}
                      </span>
                      <span className={`cust__caret${expanded ? " is-open" : ""}`} aria-hidden="true">
                        ▾
                      </span>
                    </button>
                    {expanded && (
                      <div className="cust__orders">
                        {customer.orders.map((order) => (
                          <OrderRow
                            key={order.id}
                            order={order}
                            basePath={basePath}
                            onLink={(o, mode) => void link(o, mode)}
                            copied={copiedId === order.id}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
