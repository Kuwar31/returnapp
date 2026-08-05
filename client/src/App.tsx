import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import { AdminLayout } from "./admin/AdminLayout";
import { AuthProvider } from "./admin/AuthContext";
import { DashboardPage } from "./admin/DashboardPage";
import { LoginPage } from "./admin/LoginPage";
import { ReturnDetailPage } from "./admin/ReturnDetailPage";
import { ReturnsListPage } from "./admin/ReturnsListPage";
import { SettingsPage } from "./admin/SettingsPage";
import { PortalLayout } from "./portal/PortalLayout";
import { LookupPage } from "./portal/LookupPage";
import { SelectItemsPage } from "./portal/SelectItemsPage";
import { StatusPage } from "./portal/StatusPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Shopper portal, one per merchant slug */}
        <Route path="/r/:slug" element={<PortalLayout />}>
          <Route index element={<LookupPage />} />
          <Route path="items" element={<SelectItemsPage />} />
          <Route path="status/:reference" element={<StatusPage />} />
        </Route>

        {/* Merchant admin */}
        <Route
          path="/admin/login"
          element={
            <AuthProvider>
              <LoginPage />
            </AuthProvider>
          }
        />
        <Route
          path="/admin"
          element={
            <AuthProvider>
              <AdminLayout />
            </AuthProvider>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="returns" element={<ReturnsListPage />} />
          <Route path="returns/:id" element={<ReturnDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
