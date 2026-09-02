import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

/**
 * Route tree. Two independent surfaces, both addressed per store:
 *   /r/:slug           — the shopper portal, no account needed
 *   /admin/:store      — the merchant dashboard, behind a login
 *
 * The admin carries the store in the path for the same reason the portal does:
 * it makes every page bookmarkable and lets one person keep two stores open in
 * two tabs. /admin with nothing after it lands on whichever store comes first.
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
    route("shop", "portal/ShopPage.tsx"),
    route("shop-return", "portal/ShopReturnPage.tsx"),
    route("review", "portal/ReviewPage.tsx"),
    route("status/:reference", "portal/StatusPage.tsx"),
  ]),

  layout("admin/AuthLayout.tsx", [
    // Static segments outrank the dynamic one below, so no store can shadow it.
    route("admin/login", "admin/LoginPage.tsx"),
    route("admin", "admin/AdminIndex.tsx"),
    route("admin/:store", "admin/AdminLayout.tsx", [
      index("admin/DashboardPage.tsx"),
      route("returns", "admin/ReturnsListPage.tsx"),
      route("returns/:id", "admin/ReturnDetailPage.tsx"),
      /*
        Settings is one page shown a section at a time, rather than one long
        scroll. Each section is its own address so the sidebar can link
        straight to it and a merchant can bookmark the screen they keep
        coming back to.
      */
      route("settings", "admin/SettingsPage.tsx", { id: "settings-general" }),
      route("settings/policy", "admin/SettingsPage.tsx", { id: "settings-policy" }),
      route("settings/exchanges", "admin/SettingsPage.tsx", {
        id: "settings-exchanges",
      }),
      route("settings/shop-now", "admin/SettingsPage.tsx", {
        id: "settings-shop-now",
      }),
      route("settings/reasons", "admin/ReasonsPage.tsx"),
      route("settings/rules", "admin/ExchangeRulesPage.tsx"),
    ]),
  ]),

  route("*", "NotFound.tsx"),
] satisfies RouteConfig;
