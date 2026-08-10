import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";
import type { LinksFunction } from "react-router";

import globalStyles from "./styles/global.css?url";
import portalStyles from "./styles/portal.css?url";
import adminStyles from "./styles/admin.css?url";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://rsms.me/" },
  { rel: "stylesheet", href: "https://rsms.me/inter/inter.css" },
  { rel: "stylesheet", href: globalStyles },
  { rel: "stylesheet", href: portalStyles },
  { rel: "stylesheet", href: adminStyles },
];

/**
 * The document shell. React Router renders every route — including the error
 * boundary and hydration fallback — inside this, so <head> and the script tags
 * live here rather than in the default export.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Shown while the app hydrates. In SPA mode only the root route may define
 * this, so it stays generic — per-route pending states use `useNavigation`.
 */
export function HydrateFallback() {
  return (
    <div className="center-screen">
      <p className="muted">Loading…</p>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  const { heading, detail } = isRouteErrorResponse(error)
    ? {
        heading: `${error.status} ${error.statusText}`,
        detail: typeof error.data === "string" ? error.data : "",
      }
    : {
        heading: "Something went wrong",
        detail:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
      };

  return (
    <div className="center-screen">
      <div className="card" style={{ maxWidth: 420 }}>
        <h2>{heading}</h2>
        {detail && (
          <p className="muted" style={{ marginTop: 8 }}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
