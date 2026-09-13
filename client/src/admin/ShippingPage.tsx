import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import type { ShiprocketSettings } from "../lib/types";
import { CopyLink } from "../components/CopyLink";
import { ErrorAlert, Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { NumberField, Switch } from "./policy-controls";
import { storePath } from "./store-path";

/**
 * Shipping: the store's Shiprocket connection, and what happens with it.
 *
 * A return that chose "ship with a return label" gets a courier booked at
 * approval — a reverse pickup from the shopper's door to the store's return
 * destination — and the label and tracking ride along in the approval
 * email and on the shopper's status page. This page connects the account,
 * sets the parcel defaults, and hands the merchant the webhook to paste
 * into Shiprocket so scans arrive as they happen.
 */

type Parcel = { lengthCm: number; breadthCm: number; heightCm: number; weightKg: number };

const DEFAULT_PARCEL: Parcel = { lengthCm: 20, breadthCm: 15, heightCm: 10, weightKg: 0.5 };

export default function ShippingPage() {
  const { session } = useAuth();
  const base = storePath(session!.merchant.slug);
  const [data, setData] = useState<ShiprocketSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [parcel, setParcel] = useState<Parcel>(DEFAULT_PARCEL);
  const [showSecret, setShowSecret] = useState(false);

  const load = () =>
    api
      .get<ShiprocketSettings>("/admin/settings/shiprocket", { auth: "admin" })
      .then((found) => {
        setData(found);
        if (found.connected) setParcel(found.parcel);
      })
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  /** Every change reloads; the payload is small and the server is authoritative. */
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
      await load();
      if (message) setStatus(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.post("/admin/settings/shiprocket/connect", { email: email.trim(), password }, { auth: "admin" });
      setPassword("");
    }, "Shiprocket connected.");
  };

  const patch = (changes: Partial<Parcel & { autoCreate: boolean; receiveOnDelivery: boolean; qcEnabled: boolean }>, message?: string) =>
    run(() => api.patch("/admin/settings/shiprocket", changes, { auth: "admin" }), message);

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Shipping</h1>
        <ErrorAlert message={error ?? "Couldn't load your shipping settings."} />
      </>
    );
  }

  const parcelDirty =
    data.connected &&
    (parcel.lengthCm !== data.parcel.lengthCm ||
      parcel.breadthCm !== data.parcel.breadthCm ||
      parcel.heightCm !== data.parcel.heightCm ||
      parcel.weightKg !== data.parcel.weightKg);

  const destinationProblems = data.destination
    ? [
        ...(data.destination.hasPhone ? [] : ["a 10-digit Indian mobile number"]),
        ...(data.destination.hasZip ? [] : ["a postcode"]),
      ]
    : [];

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Shipping</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Book courier pickups and print return labels through Shiprocket.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      <div className="split">
        <div>
          <h3 className="split__title">Shiprocket account</h3>
          <p className="split__blurb">
            Connect an API user from your Shiprocket panel: Settings → API →
            Configure → Create an API User. Its email has to differ from your
            Shiprocket login.
          </p>
          <p className="split__blurb">
            The password is stored encrypted and only ever sent to Shiprocket
            to fetch a login token.
          </p>
        </div>
        <div className="panel">
          {data.connected ? (
            <>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">{data.email}</div>
                  <div className="settings-row__hint">
                    Connected {dateTime(data.connectedAt)}
                    {data.tokenExpiresAt && ` · token renews ${dateTime(data.tokenExpiresAt)}`}
                  </div>
                </div>
                <span className="badge badge--success">Connected</span>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Test the connection</div>
                  <div className="settings-row__hint">
                    Logs in again and asks Shiprocket for your pickup addresses.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api.post("/admin/settings/shiprocket/test", undefined, { auth: "admin" }),
                      "Shiprocket answered — the connection works.",
                    )
                  }
                >
                  Test connection
                </button>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Disconnect</div>
                  <div className="settings-row__hint">
                    Labels stop being made. Parcels already booked keep tracking
                    until they arrive.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Disconnect Shiprocket from this store?")) return;
                    void run(
                      () => api.delete("/admin/settings/shiprocket", { auth: "admin" }),
                      "Shiprocket disconnected.",
                    );
                  }}
                >
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={connect}>
              <div className="field">
                <label htmlFor="sr-email">API user email</label>
                <input
                  id="sr-email"
                  type="email"
                  value={email}
                  autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="api-user@yourstore.com"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="sr-password">API user password</label>
                <input
                  id="sr-password"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>
                {busy ? "Connecting…" : "Connect Shiprocket"}
              </button>
            </form>
          )}
        </div>
      </div>

      {data.connected && (
        <div className="split">
          <div>
            <h3 className="split__title">Return labels</h3>
            <p className="split__blurb">
              What happens when a return that chose "Ship with a return label"
              is approved: Shiprocket books a courier to collect the parcel
              from the customer and bring it to your return destination.
            </p>
            <p className="split__blurb">
              The label and tracking go out in the approval email and show on
              the customer's return page.
            </p>
          </div>
          <div className="panel">
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Book the courier at approval</div>
                <div className="settings-row__hint">
                  Off means you make each label yourself from the return.
                </div>
              </div>
              <Switch
                on={data.autoCreate}
                label="Book the courier at approval"
                onChange={(autoCreate) => void patch({ autoCreate })}
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Mark received on delivery</div>
                <div className="settings-row__hint">
                  When the courier delivers the parcel, the return moves to
                  received — and Shopify is told the items are back.
                </div>
              </div>
              <Switch
                on={data.receiveOnDelivery}
                label="Mark received on delivery"
                onChange={(receiveOnDelivery) => void patch({ receiveOnDelivery })}
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Quality check at pickup</div>
                <div className="settings-row__hint">
                  The courier checks each item against its name and picture
                  before taking it. Shiprocket may charge for this.
                </div>
              </div>
              <Switch
                on={data.qcEnabled}
                label="Quality check at pickup"
                onChange={(qcEnabled) => void patch({ qcEnabled })}
              />
            </div>
            <div className="settings-row settings-row--stacked">
              <div>
                <div className="settings-row__label">Parcel defaults</div>
                <div className="settings-row__hint">
                  Orders don't carry dimensions, so every return parcel is
                  booked at these. Shiprocket bills on the greater of this
                  weight and the volumetric one.
                </div>
              </div>
              <div className="ship-parcel">
                {(
                  [
                    ["lengthCm", "Length", "cm"],
                    ["breadthCm", "Breadth", "cm"],
                    ["heightCm", "Height", "cm"],
                    ["weightKg", "Weight", "kg"],
                  ] as Array<[keyof Parcel, string, string]>
                ).map(([key, label, unit]) => (
                  <label key={key} className="ship-parcel__field">
                    <span className="rform__label">{label}</span>
                    <NumberField
                      value={parcel[key]}
                      min={key === "weightKg" ? 0.05 : 1}
                      step={key === "weightKg" ? "0.05" : "1"}
                      unit={unit}
                      onChange={(value) => setParcel({ ...parcel, [key]: value })}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || !parcelDirty}
                  onClick={() => void patch(parcel, "Parcel defaults saved.")}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {data.connected && (
        <div className="split">
          <div>
            <h3 className="split__title">Tracking webhook</h3>
            <p className="split__blurb">
              Shiprocket can send every scan here the moment it happens.
              Without it, open parcels are checked every half hour, which is
              enough to move a return along but slower.
            </p>
          </div>
          <div className="panel">
            <ol className="steps" style={{ marginBottom: 16 }}>
              <li>In Shiprocket, open Settings → API → Webhooks.</li>
              <li>Paste the URL below and switch the webhook on.</li>
              <li>Set the security token to the value below.</li>
            </ol>
            <CopyLink url={data.webhookUrl} label="Webhook URL" />
            <div className="settings-row settings-row--stacked" style={{ marginTop: 18 }}>
              <div>
                <div className="settings-row__label">Security token</div>
                <div className="settings-row__hint">
                  Shiprocket sends it in the x-api-key header; it's how this
                  app knows the event is yours. Regenerating it means pasting
                  the new one into Shiprocket.
                </div>
              </div>
              <div className="ship-secret">
                <code className="ship-secret__value">
                  {showSecret ? data.webhookSecret : "•".repeat(24)}
                </code>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void navigator.clipboard.writeText(data.webhookSecret)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Regenerate the token? Shiprocket will need the new one.")) return;
                    void run(
                      () => api.post("/admin/settings/shiprocket/webhook-secret", undefined, { auth: "admin" }),
                      "Token regenerated — paste it into Shiprocket.",
                    );
                  }}
                >
                  Regenerate
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="split">
        <div>
          <h3 className="split__title">Where parcels go</h3>
          <p className="split__blurb">
            The courier delivers to the return destination of the customer's
            policy, or your default destination. Shiprocket needs a phone
            number and a postcode for it.
          </p>
        </div>
        <div className="panel">
          {data.destination ? (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">{data.destination.name}</div>
                <div className="settings-row__hint">
                  {destinationProblems.length === 0
                    ? "Ready for deliveries."
                    : `Add ${destinationProblems.join(" and ")} before a label can be made.`}
                </div>
              </div>
              <Link className="btn btn--secondary btn--sm" to={`${base}/settings/policies/destinations`}>
                Destinations
              </Link>
            </div>
          ) : (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">No return destination yet</div>
                <div className="settings-row__hint">
                  Add one so the courier knows where to deliver.
                </div>
              </div>
              <Link className="btn btn--secondary btn--sm" to={`${base}/settings/policies/destinations`}>
                Add a destination
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
