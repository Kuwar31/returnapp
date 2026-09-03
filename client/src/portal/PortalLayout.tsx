import { useEffect } from "react";
import { Outlet, useRouteLoaderData } from "react-router";
import { api } from "../lib/api";
import { ensureFontsLoaded, fontStack, RADIUS_PX } from "../lib/fonts";
import type { PortalBranding, PortalConfig } from "../lib/types";
import { isEmbedded, useReportHeight } from "./useEmbedded";
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

/**
 * The merchant's choices as CSS custom properties.
 *
 * One object rather than scattered inline styles, because everything under
 * this element — cards, buttons, drawers, the shop screen — reads the same
 * tokens. A control added to the settings page becomes a line here and needs
 * no change anywhere else.
 */
const themeVars = (b: PortalBranding): React.CSSProperties =>
  ({
    "--accent": b.accentColor,
    "--btn-bg": b.buttonColor ?? b.accentColor,
    "--btn-fg": b.buttonTextColor,
    "--bg": b.backgroundColor,
    "--text": b.headingColor,
    "--text-muted": b.bodyColor,
    "--font-heading": fontStack(b.headingFont),
    "--font": fontStack(b.bodyFont),
    "--radius-lg": RADIUS_PX[b.cornerRadius] ?? RADIUS_PX.CURVED,
    "--suggestion": b.suggestionColor,
    ...(b.heroImageUrl ? { "--hero": `url("${b.heroImageUrl}")` } : {}),
  }) as React.CSSProperties;

/**
 * The two things that live outside the React tree: the tab's icon, and whether
 * search engines may keep this page.
 *
 * Written imperatively because the portal is a single-page app with one static
 * index.html — there is no per-store document to put them in.
 */
const useDocumentBranding = (branding: PortalBranding, embedded: boolean) => {
  useEffect(() => {
    // Embedded, the host page owns its own head; writing to it from inside a
    // frame would be editing the merchant's theme.
    if (embedded) return;

    if (branding.faviconUrl) {
      const link =
        document.querySelector<HTMLLinkElement>("link[rel='icon']") ??
        document.head.appendChild(
          Object.assign(document.createElement("link"), { rel: "icon" }),
        );
      link.href = branding.faviconUrl;
    }

    /**
     * noindex when the merchant has asked to be left out. It stops future
     * crawls rather than retracting past ones, which is why the setting says
     * so instead of promising the page disappears.
     */
    const robots =
      document.querySelector<HTMLMetaElement>("meta[name='robots']") ??
      document.head.appendChild(
        Object.assign(document.createElement("meta"), { name: "robots" }),
      );
    robots.content = branding.searchEngineVisible
      ? "index, follow"
      : "noindex, nofollow";
  }, [branding.faviconUrl, branding.searchEngineVisible, embedded]);
};

export default function PortalLayout({ loaderData }: Route.ComponentProps) {
  const config = loaderData;
  const branding = config.branding;
  /**
   * Embedded in the merchant's storefront, the theme around this already shows
   * their logo, their name and a footer. Repeating all three inside the frame
   * is the same store introducing itself twice on one page.
   */
  const embedded = isEmbedded();
  useReportHeight(embedded);
  useDocumentBranding(branding, embedded);

  // Only the Google faces, and only the ones actually chosen.
  ensureFontsLoaded([branding.headingFont, branding.bodyFont]);

  return (
    <>
      {/* The merchant's accent colour cascades to buttons and highlights. */}
      <div
        className={`portal${branding.heroImageUrl && !embedded ? " portal--hero" : ""}${
          embedded ? " portal--embedded" : ""
        }${branding.textTone === "LIGHT" ? " portal--light-text" : ""}`}
        style={themeVars(branding)}
      >
        {!embedded && (
        <header className="portal__header">
          {/*
            The store identifies itself before the page explains itself.
            A logo does that job on its own, so the name is only spelled out
            when there isn't one — printing both is the same fact twice.
          */}
          {branding.logoUrl ? (
            <img
              className="portal__logo"
              src={branding.logoUrl}
              alt={config.merchant.name}
              style={{ width: branding.logoWidth, height: "auto" }}
            />
          ) : (
            <div className="portal__store">{config.merchant.name}</div>
          )}
          <h1>{branding.headline}</h1>
          <p className="muted">{branding.subheadline}</p>
        </header>
        )}

        <Outlet />

        {!embedded && (
        <footer className="portal__footer">
          {branding.footerHeading && <strong>{branding.footerHeading}</strong>}
          {/*
            The merchant's own sentence, with {{ link }} standing in for their
            support address. Written this way round so they can say "email us
            at X" or "reach the team on X" rather than being handed one fixed
            phrasing with the address bolted on the end.
          */}
          {branding.footerText ? (
            <div>{renderFooter(branding.footerText, branding.supportEmail)}</div>
          ) : (
            branding.supportEmail && (
              <div>
                Need help?{" "}
                <a href={`mailto:${branding.supportEmail}`}>
                  {branding.supportEmail}
                </a>
              </div>
            )
          )}
          <div>{config.merchant.name}</div>
        </footer>
        )}
      </div>
    </>
  );
}

/**
 * Splits the merchant's footer sentence around `{{ link }}` and drops their
 * support address in as a mailto. Built from parts rather than by setting
 * innerHTML: this is merchant-authored text on a customer-facing page, and the
 * one thing it must not be able to do is carry markup.
 */
const renderFooter = (text: string, email: string | null) => {
  const parts = text.split(/\{\{\s*link\s*\}\}/g);
  if (parts.length === 1 || !email) return text.replace(/\{\{\s*link\s*\}\}/g, email ?? "");
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <a key={i} href={`mailto:${email}`}>
            {email}
          </a>,
          part,
        ],
  );
};

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
