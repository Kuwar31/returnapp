import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useParams } from "react-router";
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
interface NavItem {
  to: string;
  label: string;
  icon: string;
  end: boolean;
  /** Paths under `to` that belong to another entry, so this one stays quiet there. */
  exclude?: string[];
}

const NAV: Array<{ label: string | null; items: NavItem[] }> = [
  {
    label: null,
    items: [
      { to: "", label: "Dashboard", icon: "▦", end: true },
      { to: "/returns", label: "Returns", icon: "↩", end: false, exclude: ["/returns/find"] },
      { to: "/returns/find", label: "Find an order", icon: "⌕", end: true },
    ],
  },
  {
    label: "Settings",
    items: [
      { to: "/settings", label: "General", icon: "⚙", end: true },
      { to: "/settings/policy", label: "Return policy", icon: "◷", end: true },
      /*
        Destinations and Locations live under Return policies as tabs, but
        each gets its own entry here so it can be reached in one click. The
        parent stays lit for the policies and routing tabs only.
      */
      {
        to: "/settings/policies",
        label: "Return policies",
        icon: "◫",
        end: false,
        exclude: ["/settings/policies/destinations", "/settings/policies/locations"],
      },
      { to: "/settings/policies/destinations", label: "Destinations", icon: "⌖", end: true },
      { to: "/settings/policies/locations", label: "Locations", icon: "⊞", end: true },
      { to: "/settings/shipping", label: "Shipping", icon: "⛟", end: true },
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

/** "Kuwar Singh" → "KS"; an address falls back to its first two letters. */
const initialsOf = (name: string | null, email: string): string => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
  return email.slice(0, 2).toUpperCase();
};

/**
 * The account menu at the top right, where Loop keeps it: who is signed in
 * and to which store, and under it the stores to switch to and the way out.
 *
 * Each store is a URL, so switching is a navigation: no token to exchange, no
 * page reload, and the browser's own back button and "open in new tab" work on
 * it — a merchant can keep two shops open side by side instead of toggling one
 * global setting between them.
 */
function AccountMenu({ session, onSignOut }: { session: AdminSession; onSignOut: () => void }) {
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
    <div className="store-switch account" ref={root}>
      <button
        type="button"
        className="account__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${session.merchant.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account__avatar" aria-hidden="true">
          {initialsOf(session.user.name, session.user.email)}
        </span>
        <span className="account__label">
          <span className="account__store">{session.merchant.name}</span>
          <span className="account__person">{session.user.name || session.user.email}</span>
        </span>
        <span className="account__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div className="store-switch__menu account__menu" role="menu">
          <div className="account__who" title={session.user.email}>
            {session.user.email}
          </div>
          <div className="account__heading">Stores</div>
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
          <button
            type="button"
            role="menuitem"
            className="store-switch__add account__signout"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminLayout() {
  const { session, loading, logout } = useAuth();
  const { store } = useParams();
  const { pathname } = useLocation();

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
      {/* Across the top, as Loop has it: the app on the left, the account on the right. */}
      <header className="admin__bar">
        <Link className="admin__brand" to={base}>
          <span className="admin__mark" aria-hidden="true">
            ↩
          </span>
          Returns Manager
        </Link>
        <AccountMenu session={session} onSignOut={logout} />
      </header>

      <aside className="admin__sidebar">

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
                  className={({ isActive }) =>
                    isActive &&
                    !item.exclude?.some((path) => pathname.startsWith(`${base}${path}`))
                      ? "is-active"
                      : ""
                  }
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
