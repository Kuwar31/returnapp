/**
 * The admin is addressed per store: /admin/<slug>/returns, the same shape the
 * shopper portal already uses at /r/<slug>.
 *
 * That makes the URL the only place the active store is recorded. Nothing is
 * stashed in the token or in local state, so a page is bookmarkable, two tabs
 * can sit on two stores at once, and switching is an ordinary link rather than
 * a mutation with a reload behind it.
 */

/**
 * Segments after /admin that are pages, not stores. A slug can never be one of
 * these — the server refuses to mint them — but the reader below still has to
 * know, or signing in would send "login" as the active store.
 */
const RESERVED = new Set(["login", "logout"]);

/** The active store, read straight from a path. Null on /admin and /admin/login. */
export const storeFromPath = (pathname: string): string | null => {
  const match = /^\/admin\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  return RESERVED.has(slug) ? null : slug;
};

/** Builds a link within a store: storePath("acme", "/returns"). */
export const storePath = (slug: string, sub = ""): string =>
  `/admin/${encodeURIComponent(slug)}${sub}`;
