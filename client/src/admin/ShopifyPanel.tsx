import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";

interface Connection {
  configured: boolean;
  connected: boolean;
  /** Credentials exist but can't be decrypted — the store must be reconnected. */
  needsReconnect: boolean;
  shop: string | null;
  scopes: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  orderCount: number;
}

/** Connect-a-store panel plus a manual re-sync trigger. */
export function ShopifyPanel() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [shopInput, setShopInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const load = () =>
    api
      .get<Connection>("/shopify/connection", { auth: "admin" })
      .then(setConnection)
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      // Ask the API for a signed authorize URL first. That ties the install to
      // this merchant account, instead of creating a new one with no users.
      const { url } = await api.post<{ url: string }>(
        "/shopify/install-url",
        { shop: shopInput },
        { auth: "admin" },
      );
      // OAuth must be a top-level navigation, not a fetch.
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the install.");
      setConnecting(false);
    }
  };

  const resync = async () => {
    setSyncing(true);
    setError(null);
    setStatus(null);
    try {
      const result = await api.post<{ imported: number; skipped: number }>(
        "/shopify/sync",
        { days: 90 },
        { auth: "admin" },
      );
      setStatus(
        `Imported ${result.imported} order${result.imported === 1 ? "" : "s"}` +
          (result.skipped ? `, skipped ${result.skipped}.` : "."),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  if (!connection) return null;

  return (
    <div className="panel">
      <h2>Shopify</h2>

      {error && <div className="alert alert--error">{error}</div>}
      {status && <div className="alert alert--info">{status}</div>}

      {connection.needsReconnect && (
        <div className="alert alert--warn">
          {connection.shop} was connected, but the saved credentials can no
          longer be read — usually because the server's encryption key changed.
          Reconnect below to fix it.
        </div>
      )}

      {!connection.configured && (
        <div className="alert alert--warn">
          This server has no Shopify credentials. Set{" "}
          <code>SHOPIFY_API_KEY</code>, <code>SHOPIFY_API_SECRET</code> and{" "}
          <code>ENCRYPTION_KEY</code> in <code>.env</code>, then restart.
        </div>
      )}

      {connection.connected ? (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{connection.shop}</div>
              <div className="settings-row__hint">
                Connected{" "}
                {connection.connectedAt
                  ? dateTime(connection.connectedAt)
                  : "—"}{" "}
                · {connection.orderCount} order
                {connection.orderCount === 1 ? "" : "s"} synced
              </div>
            </div>
            <span className="badge badge--success">Connected</span>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Order sync</div>
              <div className="settings-row__hint">
                New orders arrive automatically over webhooks. Re-sync pulls the
                last 90 days again.
                {connection.lastSyncedAt &&
                  ` Last full sync ${dateTime(connection.lastSyncedAt)}.`}
              </div>
            </div>
            <button
              className="btn btn--secondary btn--sm"
              onClick={resync}
              disabled={syncing}
            >
              {syncing ? "Syncing…" : "Re-sync"}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={connect}>
          <p className="muted" style={{ marginBottom: 14 }}>
            Connect your store to pull in orders. You'll be sent to Shopify to
            approve access.
          </p>
          <div className="field">
            <label htmlFor="shop">Store domain</label>
            <input
              id="shop"
              value={shopInput}
              onChange={(e) => setShopInput(e.target.value)}
              placeholder="your-store.myshopify.com"
              autoComplete="off"
              required
            />
          </div>
          <button
            className="btn"
            type="submit"
            disabled={!connection.configured || !shopInput.trim() || connecting}
          >
            {connecting ? "Redirecting to Shopify…" : "Connect Shopify"}
          </button>
        </form>
      )}
    </div>
  );
}
