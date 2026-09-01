import { useEffect } from "react";

/**
 * True when the portal is running inside the merchant's storefront.
 *
 * The Shopify app proxy renders this app in a frame under the store's own
 * theme, which already supplies a header, a logo and a footer. Both `embedded`
 * and the frame check are consulted: the parameter is what the proxy sets, and
 * being framed is the fact that actually matters — a merchant who embeds the
 * portal some other way should get the same treatment without knowing to add
 * a query string.
 */
export const isEmbedded = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("embedded") === "1") {
      return true;
    }
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws in older browsers, which is
    // itself proof of being framed.
    return true;
  }
};

/**
 * Keeps the framing page sized to this one.
 *
 * A cross-origin iframe can't measure its own content from the outside, so the
 * portal has to say how tall it is. Reported on every change rather than once
 * on load, because almost every screen here grows and shrinks — opening the
 * item drawer, adding to a basket, expanding a summary.
 */
export const useReportHeight = (enabled: boolean): void => {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || window.parent === window) {
      return;
    }

    let last = 0;
    const report = () => {
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      );
      // Only on a real change, and never for sub-pixel jitter: a resize
      // observer that posts on every frame makes the host page flicker.
      if (Math.abs(height - last) < 2) return;
      last = height;
      window.parent.postMessage(
        { type: "returns-portal:height", height },
        "*",
      );
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    window.addEventListener("load", report);

    return () => {
      observer.disconnect();
      window.removeEventListener("load", report);
    };
  }, [enabled]);
};
