import { createContext, useContext } from "react";
import { Outlet, useRouteLoaderData } from "react-router";
import { api } from "../lib/api";
import type { PortalConfig } from "../lib/types";
import type { Route } from "./+types/PortalLayout";

const STEPS = ["Find your order", "Choose items", "All set"];

/**
 * Store branding is fetched once for the whole portal. Runs in the browser
 * because the app is in SPA mode; it becomes a server `loader` unchanged if
 * SSR is switched on.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  return api.get<PortalConfig>(`/portal/${params.slug}/config`);
}

const PortalContext = createContext<PortalConfig | null>(null);

/** Branding and store details for the portal being viewed. */
export const usePortal = (): PortalConfig => {
  const ctx = useContext(PortalContext);
  if (ctx) return ctx;
  // Child routes can also reach the layout's data directly.
  const data = useRouteLoaderData("r/:slug") as PortalConfig | undefined;
  if (!data) throw new Error("usePortal must be used inside PortalLayout");
  return data;
};

export function PortalStepper({ current }: { current: number }) {
  return (
    <div className="portal__steps">
      {STEPS.map((label, index) => (
        <div
          key={label}
          className={`portal__step${index === current ? " is-active" : ""}`}
        >
          <span className="portal__step-dot">{index + 1}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const config = loaderData;

  return (
    <PortalContext.Provider value={config}>
      {/* The merchant's accent colour cascades to buttons and highlights. */}
      <div
        className="portal"
        style={
          { "--accent": config.branding.accentColor } as React.CSSProperties
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
    </PortalContext.Provider>
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
