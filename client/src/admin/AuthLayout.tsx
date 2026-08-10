import { Outlet } from "react-router";
import { AuthProvider } from "./AuthContext";

/**
 * Pathless layout supplying the admin session to both /admin/login and the
 * dashboard, so the session survives navigation between them.
 */
export default function AuthLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}
