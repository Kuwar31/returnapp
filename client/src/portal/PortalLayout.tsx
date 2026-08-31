import { Outlet, useRouteLoaderData } from "react-router";
import { api } from "../lib/api";
import type { PortalConfig } from "../lib/types";
import type { Route } from "./+types/PortalLayout";

/**
 * Store branding is fetched once for the whole portal. Runs in the browser
 * because the app is in SPA mode; it becomes a server `loader` unchanged if
 * SSR is switched on.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  return api.get<PortalConfig>(`/portal/${params.slug}/config`);
}

/**
 * Branding and store details for the portal being viewed.
 *
 * Reads the layout route's loader data rather than a React context: a route
 * module is loaded through the router's own virtual module, so a context
 * created in this file is a *different* context object from the one a child
 * route imports, and the provider silently never matches.
 */
export const usePortal = (): PortalConfig => {
  const data = useRouteLoaderData("portal/PortalLayout") as
    | PortalConfig
    | undefined;
  if (!data) throw new Error("usePortal must be used inside PortalLayout");
  return data;
};

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const config = loaderData;

  return (
    <>
      {/* The merchant's accent colour cascades to buttons and highlights. */}
      <div
        className={`portal${config.branding.heroImageUrl ? " portal--hero" : ""}`}
        style={
          {
            "--accent": config.branding.accentColor,
            ...(config.branding.heroImageUrl
              ? { "--hero": `url("${config.branding.heroImageUrl}")` }
              : {}),
          } as React.CSSProperties
        }
      >
        <header className="portal__header">
          {config.branding.logoUrl && (
            <img
              className="portal__logo"
              src={config.branding.logoUrl}
              alt={config.merchant.name}
            />
          )}
          <h1>{config.branding.headline}</h1>
          <p className="muted">{config.branding.subheadline}</p>
        </header>

        <Outlet />

        <footer className="portal__footer">
          {config.branding.supportEmail && (
            <>
              Need help?{" "}
              <a href={`mailto:${config.branding.supportEmail}`}>
                {config.branding.supportEmail}
              </a>
              <br />
            </>
          )}
          {config.merchant.name}
        </footer>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  return (
    <div className="center-screen">
      <div className="card portal__card">
        <h2>Portal unavailable</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          We couldn't find that store's returns portal. Please use the link the
          store sent you.
        </p>
      </div>
    </div>
  );
}
