import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import type { ShippingView } from "../lib/types";
import { CopyLink } from "../components/CopyLink";
import { ErrorAlert, Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { Modal } from "./Modal";
import { NumberField, Switch } from "./policy-controls";
import { storePath } from "./store-path";

/**
 * Shipping, laid out as Loop lays it out: the shipping services connected
 * to the store and which one is the default, the email carriers write to,
 * the label defaults every service shares, and where parcels go.
 *
 * A return that chose "ship with a return label" gets a label from the
 * default service at approval — a courier collecting from the shopper's
 * door with the Indian carriers, a printed drop-off label with EasyPost —
 * and the label and tracking ride along in the approval email and on the
 * shopper's status page. Each service connects and tests in its own way:
 * Shiprocket has no sandbox, so the app pretends; Delhivery has a staging
 * environment; EasyPost has test keys.
 */

type Provider = "SHIPROCKET" | "DELHIVERY" | "EASYPOST" | "SHIPPO";
type Parcel = ShippingView["settings"]["parcel"];

const SERVICES: Array<{ id: Provider; name: string; initials: string; blurb: string }> = [
  {
    id: "SHIPROCKET",
    name: "Shiprocket",
    initials: "SR",
    blurb: "An Indian aggregator over Delhivery, Xpressbees, Bluedart and others, quoted per pickup.",
  },
  {
    id: "DELHIVERY",
    name: "Delhivery",
    initials: "DL",
    blurb: "A direct Delhivery account, billed at your contract rates, with a staging environment to test in.",
  },
  {
    id: "EASYPOST",
    name: "EasyPost",
    initials: "EP",
    blurb: "USPS, UPS, FedEx, DHL and more through one API key. Drop-off labels the customer prints.",
  },
  {
    id: "SHIPPO",
    name: "Shippo",
    initials: "SP",
    blurb: "USPS, UPS, FedEx, DHL and more through one token. Drop-off labels the customer prints.",
  },
];

const NAMES: Record<Provider, string> = { SHIPROCKET: "Shiprocket", DELHIVERY: "Delhivery", EASYPOST: "EasyPost", SHIPPO: "Shippo" };

export default function ShippingPage() {
  const { session } = useAuth();
  const base = storePath(session!.merchant.slug);
  const [data, setData] = useState<ShippingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parcel, setParcel] = useState<Parcel>({ lengthCm: 20, breadthCm: 15, heightCm: 10, weightKg: 0.5 });
  const [shippingEmail, setShippingEmail] = useState("");
  /** The delivery destination's phone and postcode, editable in place. */
  const [contact, setContact] = useState<{ id: string | null; phone: string; zip: string }>({ id: null, phone: "", zip: "" });
  /** Which dialog is open, if any. */
  const [dialog, setDialog] = useState<null | { kind: "connect" } | { kind: "default" } | { kind: "manage"; provider: Provider }>(null);

  const apply = (found: ShippingView) => {
    setData(found);
    setParcel(found.settings.parcel);
    setShippingEmail(found.settings.shippingEmail ?? "");
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
  const run = async (fn: () => Promise<unknown>, message?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
      await load();
      if (message) setStatus(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const patchSettings = (
    changes: Partial<
      Parcel & {
        provider: Provider | null;
        autoCreate: boolean;
        receiveOnDelivery: boolean;
        destinationId: string | null;
        shippingEmail: string | null;
      }
    >,
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
  const connected: Provider[] = SERVICES.map((s) => s.id).filter((id) =>
    id === "SHIPROCKET" ? Boolean(data.shiprocket) : id === "DELHIVERY" ? Boolean(data.delhivery) : id === "EASYPOST" ? Boolean(data.easypost) : Boolean(data.shippo),
  );
  /** A service's test mode, whichever name its carrier gives it. */
  const testing = (id: Provider) =>
    id === "SHIPROCKET"
      ? Boolean(data.shiprocket?.testMode)
      : id === "DELHIVERY"
        ? Boolean(data.delhivery?.staging)
        : id === "EASYPOST"
          ? Boolean(data.easypost?.testMode)
          : Boolean(data.shippo?.testMode);
  const testModeCopy: Record<Provider, string> = {
    SHIPROCKET: "Test mode is on: return labels are pretend and no courier is booked. Turn it off before real returns come in.",
    DELHIVERY: "Delhivery is on its staging environment: bookings are real calls that charge nothing and send no courier. Switch it to production before real returns come in.",
    EASYPOST: "EasyPost is connected with a test key: labels are test labels and no postage is bought. Reconnect with a production key before real returns come in.",
    SHIPPO: "Shippo is connected with a test token: labels are test labels and no postage is bought. Reconnect with a live token before real returns come in.",
  };
  const parcelDirty =
    parcel.lengthCm !== settings.parcel.lengthCm ||
    parcel.breadthCm !== settings.parcel.breadthCm ||
    parcel.heightCm !== settings.parcel.heightCm ||
    parcel.weightKg !== settings.parcel.weightKg;
  const emailDirty = shippingEmail.trim() !== (settings.shippingEmail ?? "");
  const effective = effectiveOf(data);
  const storeDefault = data.destinations.find((d) => d.isDefault) ?? null;
  const destinationProblems = effective
    ? [...(effective.hasPhone ? [] : ["a 10-digit Indian mobile number"]), ...(effective.hasZip ? [] : ["a postcode"])]
    : [];
  const contactDirty =
    effective !== null &&
    contact.id === effective.id &&
    (contact.phone !== (effective.phone ?? "") || contact.zip !== (effective.zip ?? ""));

  /** One line under a connected service's name. */
  const detail = (id: Provider): string => {
    if (id === "SHIPROCKET" && data.shiprocket) return `${data.shiprocket.email} · connected ${dateTime(data.shiprocket.connectedAt)}`;
    if (id === "DELHIVERY" && data.delhivery) return `Warehouse ${data.delhivery.warehouseName} · connected ${dateTime(data.delhivery.connectedAt)}`;
    if (id === "EASYPOST" && data.easypost) return `${data.easypost.testMode ? "Test key" : "Production key"} · connected ${dateTime(data.easypost.connectedAt)}`;
    if (id === "SHIPPO" && data.shippo) return `${data.shippo.testMode ? "Test token" : "Live token"} · connected ${dateTime(data.shippo.connectedAt)}`;
    return "";
  };

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Shipping</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Connect shipping services, and set the defaults every return label uses.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}
      {active && testing(active) && <div className="alert alert--warn">{testModeCopy[active]}</div>}

      <div className="split">
        <div>
          <h3 className="split__title">Integrations</h3>
          <p className="split__blurb">Manage external shipping carrier accounts and which one makes your return labels.</p>
        </div>
        <div className="panel">
          <h2>Shipping services</h2>
          {connected.length === 0 ? (
            <div className="services__empty">
              <span aria-hidden="true">ⓘ</span> No shipping services have been connected
            </div>
          ) : (
            <div className="services">
              {connected.map((id) => {
                const s = SERVICES.find((x) => x.id === id)!;
                return (
                  <div key={id} className="service-row">
                    <span className="service-row__logo" aria-hidden="true">
                      {s.initials}
                    </span>
                    <span className="service-row__body">
                      <span className="service-row__name">
                        {s.name}
                        {active === id && <span className="chip chip--accent">Default</span>}
                        {testing(id) && <span className="chip">{id === "DELHIVERY" ? "Staging" : "Test mode"}</span>}
                      </span>
                      <span className="service-row__meta">{detail(id)}</span>
                    </span>
                    <span className="service-row__actions">
                      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDialog({ kind: "manage", provider: id })}>
                        Manage
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="services__foot">
            <button type="button" className="btn btn--secondary btn--sm" disabled={connected.length === 0} onClick={() => setDialog({ kind: "default" })}>
              Edit default service
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setDialog({ kind: "connect" })}>
              Connect shipping service
            </button>
          </div>
        </div>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">Shipping notifications</h3>
          <p className="split__blurb">Used by carriers to send you delivery confirmations and shipping exceptions.</p>
        </div>
        <div className="panel">
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Shipping email</div>
              <div className="settings-row__hint">Required by some carriers to generate labels. Blank uses the store owner's address.</div>
            </div>
            <div className="ship-parcel">
              <input
                type="email"
                className="settings-input"
                value={shippingEmail}
                placeholder={session!.user.email}
                aria-label="Shipping email"
                onChange={(e) => setShippingEmail(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || !emailDirty}
                onClick={() => void patchSettings({ shippingEmail: shippingEmail.trim() || null }, "Shipping email saved.")}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">Label and shipment settings</h3>
          <p className="split__blurb">Customize default settings that apply to all enabled services.</p>
        </div>
        <div className="panel">
          <h2>Label defaults</h2>
          <p className="settings-row__hint" style={{ margin: "4px 0 14px" }}>
            Orders don't carry dimensions, so every return parcel is booked at these. Carriers bill on the greater of
            this weight and the volumetric one.
          </p>
          <div className="label-defaults">
            {(
              [
                ["weightKg", "Product weight default", "kg", "Applied per parcel; orders don't carry a weight."],
                ["lengthCm", "Package length default", "cm", "The typical packaging used to send back returns."],
                ["breadthCm", "Package width default", "cm", "The typical packaging used to send back returns."],
                ["heightCm", "Package height default", "cm", "The typical packaging used to send back returns."],
              ] as Array<[keyof Parcel, string, string, string]>
            ).map(([key, label, unit, hint]) => (
              <label key={key} className="label-defaults__field">
                <span className="settings-row__label">{label}</span>
                <NumberField
                  value={parcel[key]}
                  min={key === "weightKg" ? 0.05 : 1}
                  step={key === "weightKg" ? "0.05" : "1"}
                  unit={unit}
                  onChange={(value) => setParcel({ ...parcel, [key]: value })}
                />
                <span className="settings-row__hint">{hint}</span>
              </label>
            ))}
          </div>
          <div className="services__foot">
            <button type="button" className="btn btn--sm" disabled={busy || !parcelDirty} onClick={() => void patchSettings(parcel, "Label defaults saved.")}>
              Save
            </button>
          </div>
          <div className="settings-row" style={{ marginTop: 8 }}>
            <div>
              <div className="settings-row__label">Make the label at approval</div>
              <div className="settings-row__hint">Off means you choose a service and book from the return, or from the approval dialog.</div>
            </div>
            <Switch on={settings.autoCreate} label="Make the label at approval" onChange={(autoCreate) => void patchSettings({ autoCreate })} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Mark received on delivery</div>
              <div className="settings-row__hint">When the carrier delivers the parcel, the return moves to received — and Shopify is told the items are back.</div>
            </div>
            <Switch on={settings.receiveOnDelivery} label="Mark received on delivery" onChange={(receiveOnDelivery) => void patchSettings({ receiveOnDelivery })} />
          </div>
        </div>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">Where parcels go</h3>
          <p className="split__blurb">
            The carrier delivers to the destination chosen here, unless the customer's regional policy names one of its
            own. Indian couriers need a 10-digit mobile number and a postcode for it.
          </p>
        </div>
        <div className="panel">
          {data.destinations.length === 0 ? (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">No return destination yet</div>
                <div className="settings-row__hint">Add one so the carrier knows where to deliver.</div>
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
                      {destinationProblems.length === 0 ? "Ready for deliveries." : `Add ${destinationProblems.join(" and ")} before an Indian courier can deliver here.`}
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

      {dialog?.kind === "connect" && (
        <ConnectDialog
          connected={connected}
          busy={busy}
          onClose={() => setDialog(null)}
          onConnect={async (provider, body) => {
            const ok = await run(() => api.post(`/admin/settings/${provider.toLowerCase()}/connect`, body, { auth: "admin" }), `${NAMES[provider]} connected.`);
            if (ok) setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "default" && (
        <DefaultDialog
          connected={connected}
          active={active}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (provider) => {
            const ok = await patchSettings({ provider }, `${NAMES[provider]} now makes return labels.`);
            if (ok) setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "manage" && (
        <ManageDialog
          provider={dialog.provider}
          data={data}
          busy={busy}
          onClose={() => setDialog(null)}
          run={run}
          onDisconnected={() => setDialog(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Connect shipping service
// ---------------------------------------------------------------------------

function ConnectDialog({
  connected,
  busy,
  onClose,
  onConnect,
}: {
  connected: Provider[];
  busy: boolean;
  onClose: () => void;
  onConnect: (provider: Provider, body: Record<string, unknown>) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Provider | null>(null);
  const [sr, setSr] = useState({ email: "", password: "" });
  const [dl, setDl] = useState({ token: "", staging: true, warehouseName: "" });
  const [ep, setEp] = useState({ apiKey: "" });
  const [sp, setSp] = useState({ token: "" });

  const ready =
    picked === "SHIPROCKET"
      ? Boolean(sr.email.trim() && sr.password)
      : picked === "DELHIVERY"
        ? Boolean(dl.token.trim() && dl.warehouseName.trim())
        : picked === "EASYPOST"
          ? Boolean(ep.apiKey.trim())
          : picked === "SHIPPO"
            ? Boolean(sp.token.trim())
            : false;

  const submit = () => {
    if (!picked || !ready) return;
    const body =
      picked === "SHIPROCKET"
        ? { email: sr.email.trim(), password: sr.password }
        : picked === "DELHIVERY"
          ? { token: dl.token.trim(), staging: dl.staging, warehouseName: dl.warehouseName.trim() }
          : picked === "EASYPOST"
            ? { apiKey: ep.apiKey.trim() }
            : { token: sp.token.trim() };
    void onConnect(picked, body);
  };

  return (
    <Modal
      title={picked ? `Connect ${NAMES[picked]}` : "Connect shipping service"}
      onClose={onClose}
      footer={
        picked ? (
          <>
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setPicked(null)}>
              Back
            </button>
            <button type="button" className="btn btn--sm" disabled={busy || !ready} onClick={submit}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {!picked ? (
        <div className="connect-list">
          {SERVICES.map((s) => {
            const done = connected.includes(s.id);
            return (
              <div key={s.id} className="connect-row">
                <span className="service-row__logo" aria-hidden="true">
                  {s.initials}
                </span>
                <span className="service-row__body">
                  <span className="service-row__name">{s.name}</span>
                  <span className="service-row__meta">{s.blurb}</span>
                </span>
                {done ? (
                  <span className="badge badge--success">Connected</span>
                ) : (
                  <button type="button" className="btn btn--sm" onClick={() => setPicked(s.id)}>
                    Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : picked === "SHIPROCKET" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            Connect an API user from your Shiprocket panel: Settings → API → Configure → Create an API User. Its email has
            to differ from your Shiprocket login. Credentials are stored encrypted and only ever sent to Shiprocket.
          </p>
          <div className="field">
            <label htmlFor="sr-email">API user email</label>
            <input id="sr-email" type="email" value={sr.email} autoComplete="off" onChange={(e) => setSr({ ...sr, email: e.target.value })} placeholder="api-user@yourstore.com" required />
          </div>
          <div className="field">
            <label htmlFor="sr-password">API user password</label>
            <input id="sr-password" type="password" value={sr.password} autoComplete="new-password" onChange={(e) => setSr({ ...sr, password: e.target.value })} required />
          </div>
        </form>
      ) : picked === "DELHIVERY" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            Paste the API token from your Delhivery panel. For staging, ask Delhivery's integration team for staging
            credentials; the token has to match the environment chosen here.
          </p>
          <div className="field">
            <label htmlFor="dl-token">API token</label>
            <input id="dl-token" type="password" value={dl.token} autoComplete="off" onChange={(e) => setDl({ ...dl, token: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="dl-warehouse">Registered warehouse name</label>
            <input id="dl-warehouse" type="text" value={dl.warehouseName} autoComplete="off" onChange={(e) => setDl({ ...dl, warehouseName: e.target.value })} placeholder="As registered with Delhivery" required />
          </div>
          <label className="check-list__item">
            <input type="checkbox" checked={dl.staging} onChange={(e) => setDl({ ...dl, staging: e.target.checked })} />
            <span>
              <span className="radio-list__label">Use the staging environment (test mode)</span>
              <span className="radio-list__hint">Real calls that charge nothing and send no courier.</span>
            </span>
          </label>
        </form>
      ) : picked === "SHIPPO" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            Paste an API token from your Shippo dashboard, under Settings → API. A test token (starts with shippo_test_)
            is the test mode: real calls, test labels, nothing charged. A live token (shippo_live_) buys real postage.
          </p>
          <div className="field">
            <label htmlFor="sp-token">API token</label>
            <input id="sp-token" type="password" value={sp.token} autoComplete="off" onChange={(e) => setSp({ token: e.target.value })} placeholder="shippo_test_… or shippo_live_…" required />
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            Paste an API key from your EasyPost dashboard, under Account Settings → API Keys. A test key (starts with
            EZTK) is the test mode: real calls, test labels, nothing charged. A production key (EZAK) buys real postage.
            The carriers you've enabled in EasyPost are the ones quoted.
          </p>
          <div className="field">
            <label htmlFor="ep-key">API key</label>
            <input id="ep-key" type="password" value={ep.apiKey} autoComplete="off" onChange={(e) => setEp({ apiKey: e.target.value })} placeholder="EZTK… or EZAK…" required />
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit default service
// ---------------------------------------------------------------------------

function DefaultDialog({
  connected,
  active,
  busy,
  onClose,
  onSave,
}: {
  connected: Provider[];
  active: Provider | null;
  busy: boolean;
  onClose: () => void;
  onSave: (provider: Provider) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Provider | null>(active ?? connected[0] ?? null);
  return (
    <Modal
      title="Edit default service"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--sm" disabled={busy || !picked || picked === active} onClick={() => picked && void onSave(picked)}>
            Save
          </button>
        </>
      }
    >
      <p className="settings-row__hint" style={{ marginBottom: 12 }}>
        The default service makes every return label. The others stay connected and can be made the default later.
      </p>
      <div className="radio-list">
        {connected.map((id) => {
          const s = SERVICES.find((x) => x.id === id)!;
          return (
            <label key={id} className="radio-list__item">
              <input type="radio" name="default-service" checked={picked === id} onChange={() => setPicked(id)} />
              <span>
                <span className="radio-list__label">{s.name}</span>
                <span className="radio-list__hint">{s.blurb}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Manage a connected service
// ---------------------------------------------------------------------------

function ManageDialog({
  provider,
  data,
  busy,
  onClose,
  run,
  onDisconnected,
}: {
  provider: Provider;
  data: ShippingView;
  busy: boolean;
  onClose: () => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<boolean>;
  onDisconnected: () => void;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const [warehouse, setWarehouse] = useState(data.delhivery?.warehouseName ?? "");
  const path = `/admin/settings/${provider.toLowerCase()}`;
  const name = NAMES[provider];

  const disconnect = () => {
    if (!window.confirm(`Disconnect ${name} from this store?`)) return;
    void run(() => api.delete(path, { auth: "admin" }), `${name} disconnected.`).then((ok) => ok && onDisconnected());
  };

  const webhook = (url: string, secret: string, where: string) => (
    <div className="settings-row settings-row--stacked">
      <div>
        <div className="settings-row__label">Tracking webhook</div>
        <div className="settings-row__hint">{where} Without it, open parcels are checked every half hour.</div>
      </div>
      <div style={{ width: "100%" }}>
        <CopyLink url={url} label="Webhook URL" />
        <div className="ship-secret" style={{ marginTop: 10 }}>
          <code className="ship-secret__value">{showSecret ? secret : "•".repeat(24)}</code>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowSecret((v) => !v)}>
            {showSecret ? "Hide" : "Show"}
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void navigator.clipboard.writeText(secret)}>
            Copy
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Regenerate the secret? ${name} will need the new one.`)) return;
              void run(() => api.post(`${path}/webhook-secret`, undefined, { auth: "admin" }), `Secret regenerated — paste it into ${name}.`);
            }}
          >
            Regenerate
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      title={name}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--danger btn--sm" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={() => void run(() => api.post(`${path}/test`, undefined, { auth: "admin" }), `${name} answered — the connection works.`)}
          >
            Test connection
          </button>
          <button type="button" className="btn btn--sm" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {provider === "SHIPROCKET" && data.shiprocket && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{data.shiprocket.email}</div>
              <div className="settings-row__hint">
                Connected {dateTime(data.shiprocket.connectedAt)}
                {data.shiprocket.tokenExpiresAt && ` · token renews ${dateTime(data.shiprocket.tokenExpiresAt)}`}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Test mode</div>
              <div className="settings-row__hint">
                Books pretend pickups: nothing is sent to Shiprocket and nothing charged to your wallet. Shiprocket has no sandbox of its own.
              </div>
            </div>
            <Switch
              on={data.shiprocket.testMode}
              label="Shiprocket test mode"
              onChange={(testMode) => void run(() => api.patch(path, { testMode }, { auth: "admin" }), testMode ? "Test mode on." : "Test mode off — labels are real again.")}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Quality check at pickup</div>
              <div className="settings-row__hint">The courier checks each item against its name and picture before taking it. Shiprocket may charge for this.</div>
            </div>
            <Switch on={data.shiprocket.qcEnabled} label="Quality check at pickup" onChange={(qcEnabled) => void run(() => api.patch(path, { qcEnabled }, { auth: "admin" }))} />
          </div>
          {webhook(
            data.shiprocket.webhookUrl,
            data.shiprocket.webhookSecret,
            "In Shiprocket, open Settings → API → Webhooks, paste this URL, switch it on, and set the security token to the value below.",
          )}
        </>
      )}

      {provider === "DELHIVERY" && data.delhivery && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Staging environment (test mode)</div>
              <div className="settings-row__hint">
                Calls go to Delhivery's staging: the same booking, nothing charged, no courier. The token has to be one Delhivery issued for staging.
              </div>
            </div>
            <Switch
              on={data.delhivery.staging}
              label="Delhivery staging"
              onChange={(staging) => void run(() => api.patch(path, { staging }, { auth: "admin" }), staging ? "Delhivery on staging." : "Delhivery on production — bookings are real.")}
            />
          </div>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Registered warehouse</div>
              <div className="settings-row__hint">The client warehouse name as registered with Delhivery. Every manifest is filed under it.</div>
            </div>
            <div className="ship-parcel">
              <input type="text" className="settings-input" value={warehouse} aria-label="Registered warehouse" onChange={(e) => setWarehouse(e.target.value)} />
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy || !warehouse.trim() || warehouse.trim() === data.delhivery.warehouseName}
                onClick={() => void run(() => api.patch(path, { warehouseName: warehouse.trim() }, { auth: "admin" }), "Warehouse saved.")}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}

      {provider === "SHIPPO" && data.shippo && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{data.shippo.testMode ? "Test token" : "Live token"}</div>
              <div className="settings-row__hint">
                Connected {dateTime(data.shippo.connectedAt)}.{" "}
                {data.shippo.testMode
                  ? "Labels are test labels and no postage is bought. To go live, disconnect and connect again with a live token."
                  : "Labels buy real postage from the carriers set up in your Shippo account."}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">How labels work</div>
              <div className="settings-row__hint">
                Shippo makes a drop-off label: the customer prints it, attaches it, and hands the parcel to the carrier. Every carrier set up in Shippo is quoted at approval.
              </div>
            </div>
          </div>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Tracking webhook</div>
              <div className="settings-row__hint">
                In Shippo, open Settings → API → Webhooks, add this URL for the "Track updated" event. The URL carries its own token, since Shippo doesn't sign what it sends. Without it, open parcels are checked every half hour.
              </div>
            </div>
            <div style={{ width: "100%" }}>
              <CopyLink url={data.shippo.webhookUrl} label="Webhook URL" />
              <div className="ship-secret" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Regenerate the token? Shippo will need the new URL.")) return;
                    void run(() => api.post(`${path}/webhook-secret`, undefined, { auth: "admin" }), "Token regenerated — paste the new URL into Shippo.");
                  }}
                >
                  Regenerate URL
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {provider === "EASYPOST" && data.easypost && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{data.easypost.testMode ? "Test key" : "Production key"}</div>
              <div className="settings-row__hint">
                Connected {dateTime(data.easypost.connectedAt)}.{" "}
                {data.easypost.testMode
                  ? "Labels are test labels and no postage is bought. To go live, disconnect and connect again with a production key."
                  : "Labels buy real postage from the carriers enabled in your EasyPost account."}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">How labels work</div>
              <div className="settings-row__hint">
                EasyPost makes a drop-off label: the customer prints it, attaches it, and hands the parcel to the carrier. Every carrier enabled in EasyPost is quoted at approval.
              </div>
            </div>
          </div>
          {webhook(
            data.easypost.webhookUrl,
            data.easypost.webhookSecret,
            "In EasyPost, open Account Settings → Webhooks, add this URL, and set its secret to the value below.",
          )}
        </>
      )}
    </Modal>
  );
}
