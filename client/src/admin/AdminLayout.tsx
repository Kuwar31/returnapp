import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useParams } from "react-router";
import { Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";
import type { AdminSession } from "../lib/types";

/**
 * The sidebar, in two groups.
 *
 * Settings used to be a single entry with everything behind it and three
 * siblings that were also settings, which read as one flat list of unrelated
 * words. Grouping them says which screens are the day's work and which are the
 * store's configuration, and gives each area of configuration a name a merchant
 * can aim at directly.
 */
const NAV = [
  {
    label: null,
    items: [
      { to: "", label: "Dashboard", icon: "▦", end: true },
      { to: "/returns", label: "Returns", icon: "↩", end: false },
    ],
  },
  {
    label: "Settings",
    items: [
      { to: "/settings", label: "General", icon: "⚙", end: true },
      { to: "/settings/policy", label: "Return policy", icon: "◷", end: true },
      { to: "/settings/exchanges", label: "Exchanges", icon: "⇄", end: true },
      { to: "/settings/shop-now", label: "Shop now", icon: "◈", end: true },
      { to: "/settings/portal", label: "Portal", icon: "◎", end: false },
      {
        to: "/settings/notifications",
        label: "Notifications",
        icon: "✉",
        end: false,
      },
      { to: "/settings/reasons", label: "Return reasons", icon: "☰", end: false },
      {
        to: "/settings/rules",
        label: "Advanced exchanges",
        icon: "⌥",
        end: false,
      },
    ],
  },
];

/**
 * The store picker — now a set of links rather than a control with state.
 *
 * Each store is a URL, so switching is a navigation: no token to exchange, no
 * page reload, and the browser's own back button and "open in new tab" work on
 * it. That last one is the point of the change — a merchant can keep two shops
 * open side by side instead of toggling one global setting between them.
 */
function StoreSwitcher({ session }: { session: AdminSession }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stores = session.stores ?? [];

  // Close on a click anywhere else, and on Escape — the two things anyone
  // tries when a menu is open and they've changed their mind.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="store-switch" ref={root}>
      <button
        type="button"
        className="store-switch__button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="store-switch__label">
          <span className="store-switch__caption">Store</span>
          <span className="store-switch__name">{session.merchant.name}</span>
        </span>
        <span className="store-switch__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="store-switch__menu" role="menu">
          {stores.map((store) => {
            const active = store.slug === session.merchant.slug;
            return (
              <Link
                key={store.id}
                role="menuitem"
                to={storePath(store.slug)}
                className={`store-switch__item${active ? " is-active" : ""}`}
                onClick={() => setOpen(false)}
              >
                <span className="store-switch__check" aria-hidden="true">
                  {active ? "✓" : ""}
                </span>
                <span className="store-switch__item-text">
                  <span className="store-switch__item-name">{store.name}</span>
                  {/*
                    The slug, because two stores can easily share a display
                    name and it is what the URL is keyed on.
                  */}
                  <span className="store-switch__item-slug">/{store.slug}</span>
                </span>
              </Link>
            );
          })}

          <Link
            className="store-switch__add"
            to={storePath(session.merchant.slug, "/settings")}
            onClick={() => setOpen(false)}
          >
            + Connect another store
          </Link>
        </div>
      )}
    </div>
  );
}

export default function AdminLayout() {
  const { session, loading, logout } = useAuth();
  const { store } = useParams();

  if (loading) return <Loading />;
  if (!session) return <Navigate to="/admin/login" replace />;

  /**
   * A slug this account can't reach — a stale bookmark, an old /admin/returns
   * link from before stores were in the path, or someone else's store. Send
   * them to one they do have rather than letting the page fire off requests
   * that will only come back 403.
   */
  const known = session.stores?.some((s) => s.slug === store) ?? false;
  if (!known) {
    const first = session.stores?.[0]?.slug ?? session.merchant.slug;
    return <Navigate to={storePath(first)} replace />;
  }

  const base = storePath(session.merchant.slug);

  return (
    <div className="admin">
      <aside className="admin__sidebar">
        <div className="admin__top">
          <div className="admin__brand">
            <span className="admin__mark" aria-hidden="true">
              ↩
            </span>
            Returns Manager
          </div>
          <StoreSwitcher session={session} />
        </div>

        <nav className="admin__nav">
          {NAV.map((group) => (
            <div key={group.label ?? "main"} className="admin__group">
              {group.label && (
                <div className="admin__group-label">{group.label}</div>
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={`${base}${item.to}`}
                  end={item.end}
                  className={({ isActive }) => (isActive ? "is-active" : "")}
                >
                  <span className="admin__nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="admin__footer">
          <div className="admin__user" title={session.user.email}>
            {session.user.email}
          </div>
          <button className="btn btn--secondary btn--sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      {/*
        Keyed on the store so moving between them remounts the page underneath.

        Without this, switching changes the URL but React keeps the same
        component mounted — every page fetches in an effect that runs on mount,
        so the new store's name appears in the sidebar above the old store's
        returns. Doing it here rather than adding the slug to each page's
        dependency list makes it structural: a page added later cannot forget.
      */}
      <main className="admin__main" key={session.merchant.slug}>
        <Outlet />
      </main>
    </div>
  );
}
