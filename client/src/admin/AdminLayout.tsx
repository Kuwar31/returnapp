import { NavLink, Navigate, Outlet } from "react-router";
import { Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/returns", label: "Returns", end: false },
  { to: "/admin/settings", label: "Settings", end: true },
  { to: "/admin/settings/reasons", label: "Return reasons", end: false },
];

export default function AdminLayout() {
  const { session, loading, logout, switchStore } = useAuth();

  if (loading) return <Loading />;
  if (!session) return <Navigate to="/admin/login" replace />;

  return (
    <div className="admin">
      <aside className="admin__sidebar">
        <div>
          <div className="admin__brand">Returns Manager</div>
          {/*
            A picker only when there is something to pick. Most accounts have
            one store, and a dropdown listing a single option is a control that
            does nothing.
          */}
          {session.stores && session.stores.length > 1 ? (
            <select
              className="admin__store-switch"
              value={session.merchant.id}
              aria-label="Store"
              onChange={(e) => void switchStore(e.target.value)}
            >
              {session.stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="admin__store">{session.merchant.name}</div>
          )}
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
