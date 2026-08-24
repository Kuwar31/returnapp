import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

/**
 * Route tree. Two independent surfaces:
 *   /r/:slug — the shopper portal, one per merchant, no account needed
 *   /admin   — the merchant dashboard, behind a login
 *
 * AuthLayout is pathless: it supplies the admin session to both the login
 * screen and the dashboard without adding a URL segment.
 */
export default [
  // `*` does not match `/`, so the root path needs its own entry.
  index("Home.tsx"),

  route("r/:slug", "portal/PortalLayout.tsx", [
    index("portal/LookupPage.tsx"),
    route("items", "portal/SelectItemsPage.tsx"),
    route("review", "portal/ReviewPage.tsx"),
    route("status/:reference", "portal/StatusPage.tsx"),
  ]),

  layout("admin/AuthLayout.tsx", [
    route("admin/login", "admin/LoginPage.tsx"),
    route("admin", "admin/AdminLayout.tsx", [
      index("admin/DashboardPage.tsx"),
      route("returns", "admin/ReturnsListPage.tsx"),
      route("returns/:id", "admin/ReturnDetailPage.tsx"),
      route("settings", "admin/SettingsPage.tsx"),
      route("settings/reasons", "admin/ReasonsPage.tsx"),
    ]),
  ]),

  route("*", "NotFound.tsx"),
] satisfies RouteConfig;
