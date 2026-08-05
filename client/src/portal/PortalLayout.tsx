import { createContext, useContext, useEffect, useState } from "react";
import { Outlet, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { PortalConfig } from "../lib/types";
import { Loading } from "../components/Feedback";

const PortalContext = createContext<PortalConfig | null>(null);

export const usePortal = (): PortalConfig => {
  const config = useContext(PortalContext);
  if (!config) throw new Error("usePortal must be used inside PortalLayout");
  return config;
};

const STEPS = ["Find your order", "Choose items", "All set"];

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

export function PortalLayout() {
  const { slug } = useParams<{ slug: string }>();
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let active = true;
    api
      .get<PortalConfig>(`/portal/${slug}/config`)
      .then((data) => active && setConfig(data))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [slug]);

  if (error) {
    return (
      <div className="center-screen">
        <div className="card portal__card">
          <h2>Portal unavailable</h2>
          <p className="muted" style={{ marginTop: 8 }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!config) return <Loading />;

  return (
    <PortalContext.Provider value={config}>
      {/* Merchant's accent color cascades to every button and highlight. */}
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
