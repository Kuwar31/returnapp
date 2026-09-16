import { CarrierError } from "./shipments.js";

/**
 * One HTTP helper for the direct carriers, which differ only in host,
 * headers and the shape of their error bodies.
 */

const TIMEOUT_MS = 25_000;

export interface Call {
  base: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** JSON unless `form` is given. */
  body?: unknown;
  form?: Record<string, string>;
  /** Who's on the other end, for the messages. */
  carrier: string;
  /** How to read this carrier's error body. */
  errorOf?: (body: unknown) => string | null;
  /** What to say on 401/403. */
  unauthorized?: string;
}

export const carrierCall = async <T>(c: Call): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${c.base.replace(/\/+$/, "")}${c.path}`, {
      method: c.method ?? (c.body !== undefined || c.form ? "POST" : "GET"),
      headers: {
        accept: "application/json",
        ...(c.form ? { "content-type": "application/x-www-form-urlencoded" } : c.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(c.headers ?? {}),
      },
      body: c.form ? new URLSearchParams(c.form).toString() : c.body !== undefined ? JSON.stringify(c.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw new CarrierError(
      error instanceof Error && error.name === "AbortError" ? `${c.carrier} didn't answer in time.` : `Couldn't reach ${c.carrier}.`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.status === 401 || res.status === 403) {
    // The carrier's own words too, since "rejected" alone hides an expired key from a wrong one.
    const said = c.errorOf?.(parsed);
    const base = c.unauthorized ?? `${c.carrier} rejected the credentials. Check them under Settings → Shipping.`;
    throw new CarrierError(said ? `${base} ${c.carrier} said: ${said}` : base, res.status, parsed);
  }
  if (!res.ok) {
    const message = c.errorOf?.(parsed) ?? (typeof parsed === "string" && parsed.trim() ? parsed.trim().slice(0, 300) : null);
    throw new CarrierError(message ?? `${c.carrier} returned ${res.status}.`, res.status, parsed);
  }
  return parsed as T;
};

export const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** "2026-09-16T09:00:00" → the same; "2026-09-16 09:00" → ISO-ish. Best effort. */
export const isoish = (date?: string | null, time?: string | null): string =>
  [date, time].filter(Boolean).join("T") || "";

/** A file a carrier handed back, base64, whatever it called the field. */
export const pdfBase64 = (content: string | null | undefined): string | null => {
  if (!content) return null;
  return content.replace(/^data:application\/pdf;base64,/, "");
};
