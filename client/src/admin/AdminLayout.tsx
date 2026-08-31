import { useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router";
import { Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import type { AdminSession } from "../lib/types";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/returns", label: "Returns", end: false },
  { to: "/admin/settings", label: "Settings", end: true },
  { to: "/admin/settings/reasons", label: "Return reasons", end: false },
];

/**
 * The store picker.
 *
 * Written as a menu rather than a `<select>` because a native dropdown can't be
 * styled to read as a control at all — it rendered as grey 12px text that
 * looked like a caption, so nobody could tell the sidebar was clickable. It
 * also has to carry more than a name: which store you're in is the single most
 * consequential piece of state in the admin, since every figure on every screen
 * belongs to it.
 */
function StoreSwitcher({ session }: { session: AdminSession }) {
  const { switchStore } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const choose = async (merchantId: string) => {
    if (merchantId === session.merchant.id) {
      setOpen(false);
      return;
    }
    setBusy(merchantId);
    setError(null);
    try {
      // Reloads on success, so there is no "done" state to render here.
      await switchStore(merchantId);
    } catch {
      setError("Couldn't switch stores. Try again.");
      setBusy(null);
    }
  };

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
            const active = store.id === session.merchant.id;
            return (
              <button
                key={store.id}
                type="button"
                role="menuitem"
                className={`store-switch__item${active ? " is-active" : ""}`}
                disabled={busy !== null}
                onClick={() => void choose(store.id)}
              >
                <span className="store-switch__check" aria-hidden="true">
                  {active ? "✓" : ""}
                </span>
                <span className="store-switch__item-text">
                  <span className="store-switch__item-name">{store.name}</span>
                  {/*
                    The slug, because two stores can easily share a display
                    name and the portal link is what actually differs.
                  */}
                  <span className="store-switch__item-slug">/r/{store.slug}</span>
                </span>
                {busy === store.id && (
                  <span className="store-switch__busy">Switching…</span>
                )}
              </button>
            );
          })}

          <button
            type="button"
            className="store-switch__add"
            onClick={() => {
              setOpen(false);
              navigate("/admin/settings");
            }}
          >
            + Connect another store
          </button>
        </div>
      )}

      {error && <div className="store-switch__error">{error}</div>}
    </div>
  );
}

export default function AdminLayout() {
  const { session, loading, logout } = useAuth();

  if (loading) return <Loading />;
  if (!session) return <Navigate to="/admin/login" replace />;

  return (
    <div className="admin">
      <aside className="admin__sidebar">
        <div>
          <div className="admin__brand">Returns Manager</div>
          <StoreSwitcher session={session} />
        </div>

        <nav className="admin__nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "is-active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="admin__footer">
          <div className="subtle" style={{ marginBottom: 8 }}>
            {session.user.email}
          </div>
          <button className="btn btn--secondary btn--sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="admin__main">
        <Outlet />
      </main>
    </div>
  );
}
