import { storeFromPath } from "../admin/store-path";

const BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Two independent sessions can be active at once: a merchant signed into the
// admin, and a shopper mid-return in the portal.
const TOKEN_KEYS = {
  admin: "returns.admin.token",
  portal: "returns.portal.token",
} as const;

export type TokenScope = keyof typeof TOKEN_KEYS;

export const getToken = (scope: TokenScope): string | null =>
  localStorage.getItem(TOKEN_KEYS[scope]);

export const setToken = (scope: TokenScope, token: string) =>
  localStorage.setItem(TOKEN_KEYS[scope], token);

export const clearToken = (scope: TokenScope) =>
  localStorage.removeItem(TOKEN_KEYS[scope]);

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Which stored token to send, if any. */
  auth?: TokenScope;
  query?: Record<string, string | number | undefined>;
}

/**
 * The most useful sentence an error response has to offer.
 *
 * Validation failures carry per-field messages written for a person — "Enter a
 * valid .myshopify.com domain", "Nothing to update" — while the top-level
 * message is always the same "The submitted data is invalid." Showing only the
 * latter turned every rejected field into the same opaque sentence, which is
 * exactly as helpful as no message at all.
 */
const describeError = (error: {
  message?: string;
  details?: unknown;
}): string => {
  const generic = error?.message ?? "Something went wrong.";
  if (!Array.isArray(error?.details)) return generic;

  const reasons = error.details
    .map((d) =>
      d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string"
        ? (d as { message: string }).message
        : null,
    )
    .filter((m): m is string => Boolean(m));

  // Two or three at most: a wall of field errors is its own kind of unreadable.
  return reasons.length > 0 ? reasons.slice(0, 3).join(" ") : generic;
};

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, auth, query } = options;

  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken(auth);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  /**
   * Which store an admin request acts on, taken from the address bar.
   *
   * Read here rather than threaded down from a provider because the URL is the
   * authority on this — anything else would be a second copy of the same fact,
   * free to disagree with what the merchant is looking at. The server treats it
   * as a claim and checks the membership behind it on every request.
   *
   * /auth/* is exempt: those answer "who is signed in", which has nothing to do
   * with a store. Scoping them meant a URL naming a store you can't reach —
   * a stale bookmark, a typo — made /auth/me fail and signed you out instead of
   * redirecting you somewhere you can go.
   */
  if (auth === "admin" && !path.startsWith("/auth/")) {
    const store = storeFromPath(window.location.pathname);
    if (store) headers["X-Store-Slug"] = store;
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection.");
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error;
    // An expired token should drop the session rather than loop on 401s.
    if (response.status === 401 && auth) clearToken(auth);
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      describeError(error),
      error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PUT", body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "DELETE" }),
};
