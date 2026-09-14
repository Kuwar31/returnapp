import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import type { ShippingView } from "../lib/types";
import { CopyLink } from "../components/CopyLink";
import { ErrorAlert, Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { NumberField, Switch } from "./policy-controls";
import { storePath } from "./store-path";

/**
 * Shipping: the carriers a store can book return labels with, which one
 * does, and what applies to whichever it is.
 *
 * A return that chose "ship with a return label" gets a courier booked at
 * approval — a reverse pickup from the shopper's door to the store's return
 * destination — and the label and tracking ride along in the approval
 * email and on the shopper's status page. Each carrier has its own card to
 * connect and its own way of testing: Shiprocket has no sandbox, so the app
 * pretends for it; Delhivery has a staging environment, so the app uses that.
 */

type Provider = "SHIPROCKET" | "DELHIVERY";
type Parcel = ShippingView["settings"]["parcel"];

const CARRIER_NAMES: Record<Provider, string> = { SHIPROCKET: "Shiprocket", DELHIVERY: "Delhivery" };

export default function ShippingPage() {
  const { session } = useAuth();
  const base = storePath(session!.merchant.slug);
  const [data, setData] = useState<ShippingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parcel, setParcel] = useState<Parcel>({ lengthCm: 20, breadthCm: 15, heightCm: 10, weightKg: 0.5 });
  const [showSecret, setShowSecret] = useState(false);
  /** The delivery destination's phone and postcode, editable in place. */
  const [contact, setContact] = useState<{ id: string | null; phone: string; zip: string }>({ id: null, phone: "", zip: "" });
  // The connect forms.
  const [sr, setSr] = useState({ email: "", password: "" });
  const [dl, setDl] = useState({ token: "", staging: true, warehouseName: "" });
  const [warehouse, setWarehouse] = useState("");

  const apply = (found: ShippingView) => {
    setData(found);
    setParcel(found.settings.parcel);
    setWarehouse(found.delhivery?.warehouseName ?? "");
  };

  const load = () =>
    api
      .get<ShippingView>("/admin/settings/shipping", { auth: "admin" })
      .then(apply)
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  /** Where parcels go today: the chosen destination, else the default. */
  const effectiveOf = (found: ShippingView) =>
    found.destinations.find((d) => d.id === found.settings.destinationId) ??
    found.destinations.find((d) => d.isDefault) ??
    found.destinations[0] ??
    null;

  // The contact fields follow whichever destination is in effect.
  useEffect(() => {
    if (!data) return;
    const d = effectiveOf(data);
    setContact({ id: d?.id ?? null, phone: d?.phone ?? "", zip: d?.zip ?? "" });
  }, [data]);

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

  const patchSettings = (
    changes: Partial<Parcel & { provider: Provider | null; autoCreate: boolean; receiveOnDelivery: boolean; destinationId: string | null }>,
    message?: string,
  ) => run(() => api.patch("/admin/settings/shipping", changes, { auth: "admin" }), message);

  /**
   * Saves the phone and postcode onto the destination itself, through the
   * destinations endpoint, which wants the whole address back.
   */
  const saveContact = () => {
    const d = data?.destinations.find((x) => x.id === contact.id);
    if (!d) return;
    void run(
      () =>
        api.patch(
          `/admin/settings/destinations/${d.id}`,
          {
            name: d.name,
            address1: d.address1,
            address2: d.address2,
            city: d.city,
            province: d.province,
            zip: contact.zip.trim() || null,
            countryCode: d.countryCode,
            phone: contact.phone.trim() || null,
            isDefault: d.isDefault,
            locationId: d.locationId,
          },
          { auth: "admin" },
        ),
      `Saved ${d.name}.`,
    );
  };

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Shipping</h1>
        <ErrorAlert message={error ?? "Couldn't load your shipping settings."} />
      </>
    );
  }

  const { settings } = data;
  const active = settings.provider;
  const anyConnected = Boolean(data.shiprocket || data.delhivery);
  const testing =
    (active === "SHIPROCKET" && data.shiprocket?.testMode) || (active === "DELHIVERY" && data.delhivery?.staging);
  const parcelDirty =
    parcel.lengthCm !== settings.parcel.lengthCm ||
    parcel.breadthCm !== settings.parcel.breadthCm ||
    parcel.heightCm !== settings.parcel.heightCm ||
    parcel.weightKg !== settings.parcel.weightKg;
  const effective = effectiveOf(data);
  const storeDefault = data.destinations.find((d) => d.isDefault) ?? null;
  const destinationProblems = effective
    ? [...(effective.hasPhone ? [] : ["a 10-digit Indian mobile number"]), ...(effective.hasZip ? [] : ["a postcode"])]
    : [];
  const contactDirty =
    effective !== null &&
    contact.id === effective.id &&
    (contact.phone !== (effective.phone ?? "") || contact.zip !== (effective.zip ?? ""));

  /** The "Use for return labels" control on a carrier card. */
  const useFor = (provider: Provider, connected: boolean) => (
    <label className={`carrier__use${!connected ? " is-disabled" : ""}`}>
      <input
        type="radio"
        name="provider"
        checked={active === provider}
        disabled={!connected || busy}
        onChange={() => void patchSettings({ provider }, `${CARRIER_NAMES[provider]} now books return labels.`)}
      />
      <span>{active === provider ? "Books return labels" : "Use for return labels"}</span>
    </label>
  );

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Shipping</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Book courier pickups and print return labels through a carrier.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}
      {testing && (
        <div className="alert alert--warn">
          {active === "DELHIVERY"
            ? "Delhivery is on its staging environment: bookings are real calls that charge nothing and send no courier. Switch it to production below before real returns come in."
            : "Test mode is on: return labels are pretend and no courier is booked. Turn it off below before real returns come in."}
        </div>
      )}

      <div className="split">
        <div>
          <h3 className="split__title">Carriers</h3>
          <p className="split__blurb">
            Connect one or more, then choose which books return labels. The
            settings below apply to whichever it is.
          </p>
          <p className="split__blurb">
            Credentials are stored encrypted and only ever sent to the carrier.
          </p>
        </div>
        <div className="carriers">
          {/* --- Shiprocket --- */}
          <div className={`panel carrier${active === "SHIPROCKET" ? " is-active" : ""}`}>
            <div className="carrier__head">
              <div>
                <h2>Shiprocket</h2>
                <p className="settings-row__hint">
                  An aggregator over Delhivery, Xpressbees, Bluedart and others, quoted per pickup.
                </p>
              </div>
              {data.shiprocket ? <span className="badge badge--success">Connected</span> : null}
            </div>
            {data.shiprocket ? (
              <>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">{data.shiprocket.email}</div>
                    <div className="settings-row__hint">
                      Connected {dateTime(data.shiprocket.connectedAt)}
                      {data.shiprocket.tokenExpiresAt && ` · token renews ${dateTime(data.shiprocket.tokenExpiresAt)}`}
                    </div>
                  </div>
                  {useFor("SHIPROCKET", true)}
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Test mode</div>
                    <div className="settings-row__hint">
                      Books pretend pickups: nothing is sent to Shiprocket and nothing charged to your wallet.
                      Shiprocket has no sandbox of its own.
                    </div>
                  </div>
                  <Switch
                    on={data.shiprocket.testMode}
                    label="Shiprocket test mode"
                    onChange={(testMode) =>
                      void run(
                        () => api.patch("/admin/settings/shiprocket", { testMode }, { auth: "admin" }),
                        testMode ? "Test mode on — Shiprocket labels are pretend from now." : "Test mode off — Shiprocket labels are real again.",
                      )
                    }
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Quality check at pickup</div>
                    <div className="settings-row__hint">
                      The courier checks each item against its name and picture before taking it. Shiprocket may charge for this.
                    </div>
                  </div>
                  <Switch
                    on={data.shiprocket.qcEnabled}
                    label="Quality check at pickup"
                    onChange={(qcEnabled) => void run(() => api.patch("/admin/settings/shiprocket", { qcEnabled }, { auth: "admin" }))}
                  />
                </div>
                <div className="settings-row settings-row--stacked">
                  <div>
                    <div className="settings-row__label">Tracking webhook</div>
                    <div className="settings-row__hint">
                      In Shiprocket, open Settings → API → Webhooks, paste this URL, switch it on, and set the
                      security token to the value below. Without it, open parcels are checked every half hour.
                    </div>
                  </div>
                  <div style={{ width: "100%" }}>
                    <CopyLink url={data.shiprocket.webhookUrl} label="Webhook URL" />
                    <div className="ship-secret" style={{ marginTop: 10 }}>
                      <code className="ship-secret__value">
                        {showSecret ? data.shiprocket.webhookSecret : "•".repeat(24)}
                      </code>
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowSecret((v) => !v)}>
                        {showSecret ? "Hide" : "Show"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => void navigator.clipboard.writeText(data.shiprocket!.webhookSecret)}
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
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Connection</div>
                    <div className="settings-row__hint">Test logs in again; Disconnect stops labels being made here.</div>
                  </div>
                  <div className="rsn-row__actions">
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
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("Disconnect Shiprocket from this store?")) return;
                        void run(() => api.delete("/admin/settings/shiprocket", { auth: "admin" }), "Shiprocket disconnected.");
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api.post("/admin/settings/shiprocket/connect", { email: sr.email.trim(), password: sr.password }, { auth: "admin" });
                    setSr({ email: "", password: "" });
                  }, "Shiprocket connected.");
                }}
              >
                <p className="settings-row__hint" style={{ marginBottom: 12 }}>
                  Connect an API user from your Shiprocket panel: Settings → API → Configure → Create an API User.
                  Its email has to differ from your Shiprocket login.
                </p>
                <div className="field">
                  <label htmlFor="sr-email">API user email</label>
                  <input id="sr-email" type="email" value={sr.email} autoComplete="off" onChange={(e) => setSr({ ...sr, email: e.target.value })} placeholder="api-user@yourstore.com" required />
                </div>
                <div className="field">
                  <label htmlFor="sr-password">API user password</label>
                  <input id="sr-password" type="password" value={sr.password} autoComplete="new-password" onChange={(e) => setSr({ ...sr, password: e.target.value })} required />
                </div>
                <button className="btn" type="submit" disabled={busy || !sr.email.trim() || !sr.password}>
                  {busy ? "Connecting…" : "Connect Shiprocket"}
                </button>
              </form>
            )}
          </div>

          {/* --- Delhivery --- */}
          <div className={`panel carrier${active === "DELHIVERY" ? " is-active" : ""}`}>
            <div className="carrier__head">
              <div>
                <h2>Delhivery</h2>
                <p className="settings-row__hint">
                  A direct account, billed at your contract rates. Its staging environment is a real sandbox.
                </p>
              </div>
              {data.delhivery ? (
                <span className={`badge ${data.delhivery.staging ? "badge--warn" : "badge--success"}`}>
                  {data.delhivery.staging ? "Staging" : "Connected"}
                </span>
              ) : null}
            </div>
            {data.delhivery ? (
              <>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Connected {dateTime(data.delhivery.connectedAt)}</div>
                    <div className="settings-row__hint">Warehouse {data.delhivery.warehouseName}</div>
                  </div>
                  {useFor("DELHIVERY", true)}
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Staging environment (test mode)</div>
                    <div className="settings-row__hint">
                      Calls go to Delhivery's staging: the same booking, nothing charged, no courier. The token has to be
                      one Delhivery issued for staging. Switch off for production, with a production token.
                    </div>
                  </div>
                  <Switch
                    on={data.delhivery.staging}
                    label="Delhivery staging"
                    onChange={(staging) =>
                      void run(
                        () => api.patch("/admin/settings/delhivery", { staging }, { auth: "admin" }),
                        staging ? "Delhivery on staging — bookings are test ones." : "Delhivery on production — bookings are real.",
                      )
                    }
                  />
                </div>
                <div className="settings-row settings-row--stacked">
                  <div>
                    <div className="settings-row__label">Registered warehouse</div>
                    <div className="settings-row__hint">
                      The client warehouse name as registered with Delhivery. Every manifest is filed under it, even
                      though the parcel is delivered to your return destination.
                    </div>
                  </div>
                  <div className="ship-parcel">
                    <input
                      type="text"
                      className="settings-input"
                      style={{ minWidth: 280 }}
                      value={warehouse}
                      aria-label="Registered warehouse"
                      onChange={(e) => setWarehouse(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busy || !warehouse.trim() || warehouse.trim() === data.delhivery.warehouseName}
                      onClick={() =>
                        void run(
                          () => api.patch("/admin/settings/delhivery", { warehouseName: warehouse.trim() }, { auth: "admin" }),
                          "Warehouse saved.",
                        )
                      }
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Connection</div>
                    <div className="settings-row__hint">Test asks Delhivery about a postcode; Disconnect stops labels being made here.</div>
                  </div>
                  <div className="rsn-row__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.post("/admin/settings/delhivery/test", undefined, { auth: "admin" }),
                          "Delhivery answered — the connection works.",
                        )
                      }
                    >
                      Test connection
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("Disconnect Delhivery from this store?")) return;
                        void run(() => api.delete("/admin/settings/delhivery", { auth: "admin" }), "Delhivery disconnected.");
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api.post(
                      "/admin/settings/delhivery/connect",
                      { token: dl.token.trim(), staging: dl.staging, warehouseName: dl.warehouseName.trim() },
                      { auth: "admin" },
                    );
                    setDl({ token: "", staging: true, warehouseName: "" });
                  }, "Delhivery connected.");
                }}
              >
                <p className="settings-row__hint" style={{ marginBottom: 12 }}>
                  Paste the API token from your Delhivery panel. For staging, ask Delhivery's integration team for
                  staging credentials; the token has to match the environment chosen here.
                </p>
                <div className="field">
                  <label htmlFor="dl-token">API token</label>
                  <input id="dl-token" type="password" value={dl.token} autoComplete="off" onChange={(e) => setDl({ ...dl, token: e.target.value })} required />
                </div>
                <div className="field">
                  <label htmlFor="dl-warehouse">Registered warehouse name</label>
                  <input id="dl-warehouse" type="text" value={dl.warehouseName} autoComplete="off" onChange={(e) => setDl({ ...dl, warehouseName: e.target.value })} placeholder="As registered with Delhivery" required />
                </div>
                <label className="check-list__item" style={{ marginBottom: 14 }}>
                  <input type="checkbox" checked={dl.staging} onChange={(e) => setDl({ ...dl, staging: e.target.checked })} />
                  <span>
                    <span className="radio-list__label">Use the staging environment (test mode)</span>
                    <span className="radio-list__hint">Real calls that charge nothing and send no courier.</span>
                  </span>
                </label>
                <button className="btn" type="submit" disabled={busy || !dl.token.trim() || !dl.warehouseName.trim()}>
                  {busy ? "Connecting…" : "Connect Delhivery"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {anyConnected && (
        <div className="split">
          <div>
            <h3 className="split__title">Return labels</h3>
            <p className="split__blurb">
              What happens when a return that chose "Ship with a return label" is approved: the carrier books a courier
              to collect the parcel from the customer and bring it to your return destination.
            </p>
            <p className="split__blurb">
              The label and tracking go out in the approval email and show on the customer's return page.
            </p>
          </div>
          <div className="panel">
            {!active && (
              <div className="alert alert--warn" style={{ marginBottom: 12 }}>
                No carrier is chosen to book labels. Pick one above.
              </div>
            )}
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Book the courier at approval</div>
                <div className="settings-row__hint">
                  Off means you choose a service and book from the return, or from the approval dialog.
                </div>
              </div>
              <Switch on={settings.autoCreate} label="Book the courier at approval" onChange={(autoCreate) => void patchSettings({ autoCreate })} />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Mark received on delivery</div>
                <div className="settings-row__hint">
                  When the courier delivers the parcel, the return moves to received — and Shopify is told the items are back.
                </div>
              </div>
              <Switch on={settings.receiveOnDelivery} label="Mark received on delivery" onChange={(receiveOnDelivery) => void patchSettings({ receiveOnDelivery })} />
            </div>
            <div className="settings-row settings-row--stacked">
              <div>
                <div className="settings-row__label">Parcel defaults</div>
                <div className="settings-row__hint">
                  Orders don't carry dimensions, so every return parcel is booked at these. Carriers bill on the greater of
                  this weight and the volumetric one.
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
                <button type="button" className="btn btn--sm" disabled={busy || !parcelDirty} onClick={() => void patchSettings(parcel, "Parcel defaults saved.")}>
                  Save
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
            The courier delivers to the destination chosen here, unless the customer's regional policy names one of its
            own. Couriers need a 10-digit Indian mobile number and a postcode for it.
          </p>
        </div>
        <div className="panel">
          {data.destinations.length === 0 ? (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">No return destination yet</div>
                <div className="settings-row__hint">Add one so the courier knows where to deliver.</div>
              </div>
              <Link className="btn btn--secondary btn--sm" to={`${base}/settings/policies/destinations`}>
                Add a destination
              </Link>
            </div>
          ) : (
            <>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Deliver returns to</div>
                  <div className="settings-row__hint">{effective ? effective.address : "Choose a destination."}</div>
                </div>
                <select
                  value={settings.destinationId ?? ""}
                  aria-label="Deliver returns to"
                  disabled={busy}
                  style={{ minWidth: 280 }}
                  onChange={(e) => void patchSettings({ destinationId: e.target.value || null }, "Delivery destination saved.")}
                >
                  <option value="">Store default{storeDefault ? ` · ${storeDefault.name}` : ""}</option>
                  {data.destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              {effective && (
                <div className="settings-row settings-row--stacked">
                  <div>
                    <div className="settings-row__label">{effective.name}: mobile number and postcode</div>
                    <div className="settings-row__hint">
                      {destinationProblems.length === 0 ? "Ready for deliveries." : `Add ${destinationProblems.join(" and ")} before a label can be made.`}
                    </div>
                  </div>
                  <div className="ship-parcel">
                    <label className="ship-parcel__field">
                      <span className="rform__label">Mobile number</span>
                      <input type="tel" className="settings-input" value={contact.phone} placeholder="98765 43210" onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                    </label>
                    <label className="ship-parcel__field">
                      <span className="rform__label">Postcode</span>
                      <input type="text" className="settings-input" value={contact.zip} placeholder="110034" onChange={(e) => setContact({ ...contact, zip: e.target.value })} />
                    </label>
                    <button type="button" className="btn btn--sm" disabled={busy || !contactDirty} onClick={saveContact}>
                      Save
                    </button>
                  </div>
                </div>
              )}
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Addresses</div>
                  <div className="settings-row__hint">Change an address, or add another destination, under Return policies.</div>
                </div>
                <Link className="btn btn--secondary btn--sm" to={`${base}/settings/policies/destinations`}>
                  Destinations
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
