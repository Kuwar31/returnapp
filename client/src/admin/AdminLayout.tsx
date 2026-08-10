import { NavLink, Navigate, Outlet } from "react-router";
import { Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";

const NAV = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/returns", label: "Returns", end: false },
  { to: "/admin/settings", label: "Settings", end: false },
];

export default function AdminLayout() {
  const { session, loading, logout } = useAuth();

  if (loading) return <Loading />;
  if (!session) return <Navigate to="/admin/login" replace />;

  return (
    <div className="admin">
      <aside className="admin__sidebar">
        <div>
          <div className="admin__brand">Returns Manager</div>
          <div className="admin__store">{session.merchant.name}</div>
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
