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
      { to: "/settings/order-notes", label: "Tags and notes", icon: "⌗", end: true },
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
  /** The store list replaces the rows while a shop is being chosen. */
  const [switching, setSwitching] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stores = session.stores ?? [];
  const base = storePath(session.merchant.slug);
  const initials = initialsOf(session.user.name, session.user.email);
  const person = session.user.name || session.user.email;

  const close = () => {
    setOpen(false);
    setSwitching(false);
  };

  // Close on a click anywhere else, and on Escape — the two things anyone
  // tries when a menu is open and they've changed their mind.
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
  }, [open]);

  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${session.merchant.name}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="account__avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="account__label">
          <span className="account__store">{session.merchant.name}</span>
          <span className="account__person">{person}</span>
        </span>
        <Icon name="chevron" className="account__chevron" />
      </button>

      {open && (
        <div className="account__menu" role="menu">
          <div className="account__card">
            <span className="account__avatar account__avatar--lg" aria-hidden="true">
              {initials}
            </span>
            <div className="account__card-store">{session.merchant.name}</div>
            <div className="account__card-person" title={session.user.email}>
              {person}
            </div>
            <button type="button" className="account__switch" onClick={() => setSwitching((v) => !v)}>
              {switching ? "Back" : "Switch shop"}
            </button>
          </div>

          {switching ? (
            <div className="account__rows">
              {stores.map((store) => {
                const active = store.slug === session.merchant.slug;
                return (
                  <Link
                    key={store.id}
                    role="menuitem"
                    to={storePath(store.slug)}
                    className={`account__row${active ? " is-active" : ""}`}
                    onClick={close}
                  >
                    <span className="account__check" aria-hidden="true">
                      {active ? "✓" : ""}
                    </span>
                    <span className="account__row-text">
                      <span>{store.name}</span>
                      {/* The slug, because two stores can share a display name and it is what the URL is keyed on. */}
                      <span className="account__row-sub">/{store.slug}</span>
                    </span>
                  </Link>
                );
              })}
              <Link role="menuitem" className="account__row" to={`${base}/settings`} onClick={close}>
                <Icon name="plus" />
                Connect another store
              </Link>
            </div>
          ) : (
            <div className="account__rows">
              <Link role="menuitem" className="account__row" to={`${base}/settings`} onClick={close}>
                <Icon name="user" />
                Account
              </Link>
              <Link role="menuitem" className="account__row" to={`${base}/settings/notifications`} onClick={close}>
                <Icon name="mail" />
                Notification settings
              </Link>
              <a role="menuitem" className="account__row" href={session.merchant.portalUrl} target="_blank" rel="noreferrer" onClick={close}>
                <Icon name="external" />
                Shopper return portal
              </a>
            </div>
          )}

          <div className="account__foot">
            <button
              type="button"
              role="menuitem"
              className="account__row account__row--danger"
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              <Icon name="logout" />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The menu's line icons, drawn here so they match one another in weight. */
function Icon({ name, className }: { name: "user" | "mail" | "external" | "logout" | "plus" | "chevron"; className?: string }) {
  const paths: Record<typeof name, React.ReactNode> = {
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
      </>
    ),
    mail: (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6" />
        <path d="M20 4 11 13" />
        <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
      </>
    ),
    logout: (
      <>
        <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
        <path d="M15 8l4 4-4 4" />
        <path d="M19 12H9" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    chevron: <path d="m6 9 6 6 6-6" />,
  };
  return (
    <svg className={`account__icon${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
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
