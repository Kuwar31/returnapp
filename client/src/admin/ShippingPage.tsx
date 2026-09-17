import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import { accountOf, PROVIDER_NAMES } from "../lib/shipping";
import type { LabelReference, LabelReferenceType, PackageSize, PackingSlipBarcode, PackingSlipSettings, ReturnMethodKind, ShipmentProvider, ShippingView } from "../lib/types";
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

type Provider = ShipmentProvider;

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
  {
    id: "SHIPSTATION",
    name: "ShipStation",
    initials: "SS",
    blurb: "The carriers in your ShipStation account, rated per service. Labels the customer prints; tracking on the carrier's site.",
  },
  {
    id: "SENDCLOUD",
    name: "Sendcloud",
    initials: "SC",
    blurb: "European carriers contracted through Sendcloud, with return methods priced per country.",
  },
  { id: "DHL_EXPRESS", name: "DHL Express", initials: "DX", blurb: "Your DHL Express account through the MyDHL API, rated per product, worldwide." },
  { id: "FEDEX", name: "FedEx", initials: "FX", blurb: "Your FedEx account through its REST APIs, rated per service, with return labels." },
  { id: "AUSPOST", name: "Australia Post", initials: "AP", blurb: "Your MyPost Business or eParcel account, priced per product within Australia." },
  { id: "DEUTSCHE_POST", name: "DHL Paket", initials: "DP", blurb: "Deutsche Post / DHL Paket for Germany, at your contract rates." },
  {
    id: "EXTERNAL",
    name: "External connector",
    initials: "EC",
    blurb: "Your own label system: each approved return is posted to a URL you give, and it answers with the label.",
  },
];

/**
 * Every service the app knows of, as the connect list shows them: the ones
 * built, and the ones on the roadmap so a merchant can see what's coming.
 * `brand` picks the wordmark's colours.
 */
const CATALOGUE: Array<{
  id?: Provider;
  name: string;
  brand: string;
  region: string;
  learnMore?: string;
  beta?: boolean;
}> = [
  { id: "SHIPPO", name: "shippo", brand: "shippo", region: "US", learnMore: "https://goshippo.com" },
  { id: "FEDEX", name: "FedEx", brand: "fedex", region: "International", learnMore: "https://developer.fedex.com" },
  { id: "EASYPOST", name: "easypost", brand: "easypost", region: "US, CA, MX, GB, AU, EU", learnMore: "https://www.easypost.com" },
  { id: "SHIPSTATION", name: "ShipStation", brand: "shipstation", region: "US", learnMore: "https://www.shipstation.com" },
  { id: "SENDCLOUD", name: "sendcloud", brand: "sendcloud", region: "EU", learnMore: "https://www.sendcloud.com" },
  { id: "SHIPROCKET", name: "Shiprocket", brand: "shiprocket", region: "IN", learnMore: "https://www.shiprocket.in", beta: true },
  { id: "DELHIVERY", name: "Delhivery", brand: "delhivery", region: "IN", learnMore: "https://www.delhivery.com", beta: true },
  { id: "DEUTSCHE_POST", name: "Deutsche Post", brand: "deutschepost", region: "DE", learnMore: "https://developer.dhl.com", beta: true },
  { id: "AUSPOST", name: "Australia Post", brand: "auspost", region: "AU", learnMore: "https://developer.auspost.com.au", beta: true },
  { id: "DHL_EXPRESS", name: "DHL Express", brand: "dhl", region: "International", learnMore: "https://developer.dhl.com", beta: true },
  { id: "EXTERNAL", name: "External connector", brand: "external", region: "Anywhere — your own system" },
];

const NAMES = PROVIDER_NAMES;

/** The API path segment for a service's admin routes. */
const PATHS: Record<Provider, string> = {
  SHIPROCKET: "shiprocket",
  DELHIVERY: "delhivery",
  EASYPOST: "easypost",
  SHIPPO: "shippo",
  SHIPSTATION: "shipstation",
  SENDCLOUD: "sendcloud",
  DHL_EXPRESS: "dhl-express",
  FEDEX: "fedex",
  AUSPOST: "auspost",
  DEUTSCHE_POST: "deutsche-post",
  EXTERNAL: "external",
};


export default function ShippingPage() {
  const { session } = useAuth();
  const base = storePath(session!.merchant.slug);
  const [data, setData] = useState<ShippingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shippingEmail, setShippingEmail] = useState("");
  /** The delivery destination's phone and postcode, editable in place. */
  const [contact, setContact] = useState<{ id: string | null; phone: string; zip: string }>({ id: null, phone: "", zip: "" });
  /** Which dialog is open, if any. */
  const [dialog, setDialog] = useState<
    null | { kind: "connect" } | { kind: "default" } | { kind: "manage"; provider: Provider } | { kind: "package"; size: PackageSize | null }
  >(null);

  const apply = (found: ShippingView) => {
    setData(found);
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
      {
        provider: Provider | null;
        autoCreate: boolean;
        receiveOnDelivery: boolean;
        destinationId: string | null;
        shippingEmail: string | null;
        packingSlipMethods: ReturnMethodKind[];
        autoCancelDays: number | null;
        labelReferences: LabelReference[];
      } & PackingSlipSettings
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
  const connected: Provider[] = SERVICES.map((s) => s.id).filter((id) => Boolean(accountOf(data, id)));
  /** A service's test mode, whichever name its carrier gives it. */
  const testing = (id: Provider) => Boolean(accountOf(data, id)?.testMode);
  const testModeCopy: Record<Provider, string> = {
    SHIPROCKET: "Test mode is on: return labels are pretend and no courier is booked. Turn it off before real returns come in.",
    DELHIVERY: "Delhivery is on its staging environment: bookings are real calls that charge nothing and send no courier. Switch it to production before real returns come in.",
    EASYPOST: "EasyPost is connected with a test key: labels are test labels and no postage is bought. Reconnect with a production key before real returns come in.",
    SHIPPO: "Shippo is connected with a test token: labels are test labels and no postage is bought. Reconnect with a live token before real returns come in.",
    SHIPSTATION: "ShipStation is making test labels, which it voids and never charges for. Turn that off under Manage before real returns come in.",
    SENDCLOUD: "Sendcloud is in test mode: parcels are announced without a label and nothing is charged. Turn that off under Manage before real returns come in.",
    DHL_EXPRESS: "DHL Express is on its test environment: labels are test labels and nothing is charged. Switch to production under Manage before real returns come in.",
    FEDEX: "FedEx is on its sandbox: labels are test labels and nothing is charged. Switch to production under Manage before real returns come in.",
    AUSPOST: "Australia Post is on its test environment: labels are test labels and nothing is charged. Switch to production under Manage before real returns come in.",
    DEUTSCHE_POST: "DHL Paket is on its sandbox: labels are test labels and nothing is charged. Switch to production under Manage before real returns come in.",
    EXTERNAL: "",
  };
  /** AfterShip's progress dashboard: what's done on the way to automatic labels. */
  const steps: Array<{ label: string; done: boolean; optional?: boolean; to?: string; action?: () => void; cta: string }> = [
    { label: "Add carrier", done: connected.length > 0, cta: "Connect shipping service", action: () => setDialog({ kind: "connect" }) },
    { label: "Add return location", done: data.destinations.length > 0, cta: "Add destination", to: `${base}/settings/policies/destinations` },
    { label: "Add package size", done: data.packageSizes.length > 0, cta: "Add package size", action: () => setDialog({ kind: "package", size: null }) },
    { label: "Return labels", done: settings.autoCancelDays !== null || settings.labelReferences.length > 0, optional: true, cta: "Review", to: "#return-labels" },
    { label: "Shipping documents", done: settings.packingSlips, optional: true, cta: "Review", to: "#shipping-documents" },
    { label: "Set up return routing rules", done: data.labelRules > 0, cta: "Set up in routing rules", to: `${base}/settings/policies/routing` },
  ];
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
    if (id === "SHIPSTATION" && data.shipstation) return `Billed in ${data.shipstation.currency} · connected ${dateTime(data.shipstation.connectedAt)}`;
    if (id === "SENDCLOUD" && data.sendcloud) return `Sender ${data.sendcloud.senderAddress} · connected ${dateTime(data.sendcloud.connectedAt)}`;
    if (id === "DHL_EXPRESS" && data.dhlExpress) return `Account ${data.dhlExpress.accountNumber} · connected ${dateTime(data.dhlExpress.connectedAt)}`;
    if (id === "FEDEX" && data.fedex) return `Account ${data.fedex.accountNumber} · connected ${dateTime(data.fedex.connectedAt)}`;
    if (id === "AUSPOST" && data.ausPost) return `Account ${data.ausPost.accountNumber} · connected ${dateTime(data.ausPost.connectedAt)}`;
    if (id === "DEUTSCHE_POST" && data.deutschePost) return `Billing ${data.deutschePost.billingNumber} · connected ${dateTime(data.deutschePost.connectedAt)}`;
    if (id === "EXTERNAL" && data.external) return `${data.external.url} · connected ${dateTime(data.external.connectedAt)}`;
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

      <div className="panel progress">
        <div className="progress__head">
          <div>
            <h2 style={{ marginBottom: 2 }}>Automatic return labels</h2>
            <p className="settings-row__hint">
              {steps.filter((s) => s.done).length} of {steps.length} steps done. Once a carrier, a return location and a
              package size are set, choose them per zone under routing rules and labels are made at approval.
            </p>
          </div>
        </div>
        <ol className="progress__steps">
          {steps.map((step) => (
            <li key={step.label} className={`progress__step${step.done ? " is-done" : ""}`}>
              <span className="progress__mark" aria-hidden="true">
                {step.done ? "✓" : ""}
              </span>
              <span className="progress__label">
                {step.label}
                {step.optional && <span className="progress__optional"> (optional)</span>}
              </span>
              {!step.done &&
                (step.to ? (
                  step.to.startsWith("#") ? (
                    <a className="progress__cta" href={step.to}>
                      {step.cta}
                    </a>
                  ) : (
                    <Link className="progress__cta" to={step.to}>
                      {step.cta}
                    </Link>
                  )
                ) : (
                  <button type="button" className="progress__cta link-btn" onClick={step.action}>
                    {step.cta}
                  </button>
                ))}
            </li>
          ))}
        </ol>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">Carrier accounts and services</h3>
          <p className="split__blurb">Connect your own carrier accounts, and choose which one makes return labels by default.</p>
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
          <h3 className="split__title">Package sizes</h3>
          <p className="split__blurb">
            Carriers price and accept parcels by size, and orders don't carry one, so every return label is booked at
            a package size from this list. The default applies unless a routing rule names another.
          </p>
        </div>
        <div className="panel">
          <h2>Package sizes</h2>
          {data.packageSizes.length === 0 ? (
            <div className="services__empty">
              <span aria-hidden="true">ⓘ</span> No package sizes yet — labels can't be made without one
            </div>
          ) : (
            <div className="services">
              {data.packageSizes.map((p) => (
                <div key={p.id} className="service-row">
                  <span className="service-row__logo" aria-hidden="true">
                    ▭
                  </span>
                  <span className="service-row__body">
                    <span className="service-row__name">
                      {p.name}
                      {p.isDefault && <span className="chip chip--accent">Default</span>}
                    </span>
                    <span className="service-row__meta">{p.summary}</span>
                  </span>
                  <span className="service-row__actions">
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDialog({ kind: "package", size: p })}>
                      Edit
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="services__foot">
            <button type="button" className="btn btn--sm" onClick={() => setDialog({ kind: "package", size: null })}>
              Add package size
            </button>
          </div>
        </div>
      </div>

      <div className="split" id="return-labels">
        <div>
          <h3 className="split__title">Return labels</h3>
          <p className="split__blurb">What happens to labels after they're made, and what's printed on them.</p>
        </div>
        <div className="panel">
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Auto-cancel return labels</div>
              <div className="settings-row__hint">
                Cancel a label that has no shipping update this many days after the return was approved. The return
                expires and the prepaid label is voided.
              </div>
            </div>
            <Switch
              on={settings.autoCancelDays !== null}
              label="Auto-cancel return labels"
              onChange={(on) => void patchSettings({ autoCancelDays: on ? 28 : null }, on ? "Labels auto-cancel after 28 days without a scan." : "Labels are left alone.")}
            />
          </div>
          {settings.autoCancelDays !== null && (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Days after approval</div>
              </div>
              <NumberField
                value={settings.autoCancelDays}
                min={1}
                max={365}
                unit="days"
                onChange={(autoCancelDays) => void patchSettings({ autoCancelDays })}
              />
            </div>
          )}
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Customize label references</div>
              <div className="settings-row__hint">
                Up to three fields printed in the label's reference slots, so the warehouse can read what a parcel is
                before opening it. Carriers print what their labels have room for.
              </div>
            </div>
            <LabelReferencesEditor value={settings.labelReferences} disabled={busy} onSave={(labelReferences) => void patchSettings({ labelReferences }, "Label references saved.")} />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Print additional labels for a return</div>
              <div className="settings-row__hint">One label per parcel isn't available yet: each return is booked as a single parcel.</div>
            </div>
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

      <div className="split" id="shipping-documents">
        <div>
          <h3 className="split__title">Shipping documents</h3>
          <p className="split__blurb">
            A printable packing slip the customer puts in the parcel, with the items coming back and a barcode for the
            warehouse. These are the defaults for returns under your store policy; a regional policy sets its own under
            Labels &amp; shipping.
          </p>
        </div>
        <div className="panel">
          <PackingSlipFields
            value={settings}
            disabled={busy}
            onChange={(changes) => void patchSettings(changes)}
          />
          {settings.packingSlips && (
            <>
              <div className="pairing__divider" />
              <div className="field-label">Select return methods</div>
              <p className="settings-row__hint" style={{ marginBottom: 8 }}>
                Which ways of sending items back show the packing slip.
              </p>
              <div className="check-list">
                {(
                  [
                    ["LABEL", "Ship with a return label"],
                    ["CARRIER", "Ship with the carrier customers choose"],
                    ["STORE", "Return to a retail store"],
                    ["KEEP", "Green returns"],
                  ] as Array<[ReturnMethodKind, string]>
                ).map(([kind, label]) => (
                  <label key={kind} className="check-list__item">
                    <input
                      type="checkbox"
                      checked={settings.packingSlipMethods.includes(kind)}
                      disabled={busy}
                      onChange={(e) =>
                        void patchSettings({
                          packingSlipMethods: e.target.checked
                            ? [...settings.packingSlipMethods, kind]
                            : settings.packingSlipMethods.filter((k) => k !== kind),
                        })
                      }
                    />
                    <span>
                      <span className="radio-list__label">{label}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">Warehouse locations</h3>
          <p className="split__blurb">
            The carrier delivers to the location chosen here, unless a routing rule or the customer's regional policy
            names one of its own. The location's contact, company and address go on the label. Indian couriers need a
            10-digit mobile number and a postcode for it.
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

      {dialog?.kind === "package" && (
        <PackageSizeDialog
          size={dialog.size}
          first={data.packageSizes.length === 0}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (body) => {
            const ok = await run(
              () =>
                dialog.size
                  ? api.patch(`/admin/settings/package-sizes/${dialog.size.id}`, body, { auth: "admin" })
                  : api.post("/admin/settings/package-sizes", body, { auth: "admin" }),
              `Saved "${body.name}".`,
            );
            if (ok) setDialog(null);
          }}
          onDelete={
            dialog.size
              ? async () => {
                  if (!window.confirm(`Delete "${dialog.size!.name}"?`)) return;
                  const ok = await run(() => api.delete(`/admin/settings/package-sizes/${dialog.size!.id}`, { auth: "admin" }), "Package size deleted.");
                  if (ok) setDialog(null);
                }
              : undefined
          }
        />
      )}

      {dialog?.kind === "connect" && (
        <ConnectDialog
          connected={connected}
          busy={busy}
          onClose={() => setDialog(null)}
          onConnect={async (provider, body) => {
            const ok = await run(() => api.post(`/admin/settings/${PATHS[provider]}/connect`, body, { auth: "admin" }), `${NAMES[provider]} connected.`);
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
  const [ss, setSs] = useState({ apiKey: "", apiSecret: "", currency: "USD" });
  const [sc, setSc] = useState({ publicKey: "", secretKey: "", testMode: true });
  /** The direct carriers share one shape: two secrets, an account, a test switch. */
  const [dc, setDc] = useState({ a: "", b: "", c: "", account: "", testMode: true });
  const [ex, setEx] = useState({ url: "", secret: "" });

  const ready =
    picked === "EXTERNAL"
      ? Boolean(ex.url.trim())
      : picked === "SHIPROCKET"
      ? Boolean(sr.email.trim() && sr.password)
      : picked === "DELHIVERY"
        ? Boolean(dl.token.trim() && dl.warehouseName.trim())
        : picked === "EASYPOST"
          ? Boolean(ep.apiKey.trim())
          : picked === "SHIPPO"
            ? Boolean(sp.token.trim())
            : picked === "SHIPSTATION"
              ? Boolean(ss.apiKey.trim() && ss.apiSecret.trim())
              : picked === "SENDCLOUD"
                ? Boolean(sc.publicKey.trim() && sc.secretKey.trim())
                : picked === "DEUTSCHE_POST"
                  ? Boolean(dc.a.trim() && dc.b.trim() && dc.c.trim() && dc.account.trim())
                  : picked
                    ? Boolean(dc.a.trim() && dc.b.trim() && dc.account.trim())
                    : false;

  const submit = () => {
    if (!picked || !ready) return;
    const body =
      picked === "EXTERNAL"
        ? { url: ex.url.trim(), secret: ex.secret.trim() || null }
        : picked === "SHIPROCKET"
        ? { email: sr.email.trim(), password: sr.password }
        : picked === "DELHIVERY"
          ? { token: dl.token.trim(), staging: dl.staging, warehouseName: dl.warehouseName.trim() }
          : picked === "EASYPOST"
            ? { apiKey: ep.apiKey.trim() }
            : picked === "SHIPPO"
              ? { token: sp.token.trim() }
              : picked === "SHIPSTATION"
                ? { apiKey: ss.apiKey.trim(), apiSecret: ss.apiSecret.trim(), currency: ss.currency.trim().toUpperCase() || "USD" }
                : picked === "SENDCLOUD"
                  ? { publicKey: sc.publicKey.trim(), secretKey: sc.secretKey.trim(), testMode: sc.testMode }
                  : picked === "DHL_EXPRESS"
                    ? { apiKey: dc.a.trim(), apiSecret: dc.b.trim(), accountNumber: dc.account.trim(), testMode: dc.testMode }
                    : picked === "FEDEX"
                      ? { clientId: dc.a.trim(), clientSecret: dc.b.trim(), accountNumber: dc.account.trim(), testMode: dc.testMode }
                      : picked === "AUSPOST"
                        ? { apiKey: dc.a.trim(), password: dc.b.trim(), accountNumber: dc.account.trim(), testMode: dc.testMode }
                        : { apiKey: dc.a.trim(), username: dc.b.trim(), password: dc.c.trim(), billingNumber: dc.account.trim(), testMode: dc.testMode };
    void onConnect(picked, body);
  };

  return (
    <Modal
      title={picked ? `Connect ${NAMES[picked]}` : "Connect shipping service"}
      wide={!picked}
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
        <div className="carrier-cards">
          {CATALOGUE.map((s) => {
            const done = s.id ? connected.includes(s.id) : false;
            return (
              <div key={s.name} className="carrier-card">
                <div className="carrier-card__head">
                  <span className={`carrier-card__logo carrier-card__logo--${s.brand}`}>{s.name}</span>
                  {s.beta && <span className="carrier-card__beta">Beta version</span>}
                  <span className="carrier-card__action">
                    {done ? (
                      <span className="carrier-card__active">
                        <span aria-hidden="true">✓</span> Active
                      </span>
                    ) : s.id ? (
                      <button type="button" className="carrier-card__connect" onClick={() => setPicked(s.id!)}>
                        <span aria-hidden="true">⊕</span> Activate
                      </button>
                    ) : (
                      <span className="carrier-card__soon">Coming soon</span>
                    )}
                  </span>
                </div>
                <div className="carrier-card__foot">
                  <span>Region: {s.region}</span>
                  {s.learnMore && (
                    <a href={s.learnMore} target="_blank" rel="noreferrer">
                      Learn more
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : picked === "EXTERNAL" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            For a label system of your own. Every approved return that needs a label is posted to this URL as JSON,
            signed with a shared secret in the <code>x-returns-signature</code> header. Answer with the label straight
            away, or later by posting to the events URL shown under Manage. The URL has to answer a ping to connect.
          </p>
          <div className="field">
            <label htmlFor="ex-url">Connector URL</label>
            <input id="ex-url" type="url" value={ex.url} autoComplete="off" onChange={(e) => setEx({ ...ex, url: e.target.value })} placeholder="https://labels.yourstore.com/returns" required />
          </div>
          <div className="field">
            <label htmlFor="ex-secret">Shared secret (optional)</label>
            <input id="ex-secret" type="password" value={ex.secret} autoComplete="off" onChange={(e) => setEx({ ...ex, secret: e.target.value })} placeholder="Leave blank to have one made for you" />
          </div>
        </form>
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
      ) : picked === "SHIPSTATION" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            In ShipStation, open Account → API Settings and generate API keys. There's no sandbox: the app asks for test
            labels, which ShipStation voids and never charges for, until you switch that off under Manage. ShipStation
            doesn't report tracking, so returns are marked received by hand or from the carrier's own page.
          </p>
          <div className="field">
            <label htmlFor="ss-key">API key</label>
            <input id="ss-key" type="password" value={ss.apiKey} autoComplete="off" onChange={(e) => setSs({ ...ss, apiKey: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="ss-secret">API secret</label>
            <input id="ss-secret" type="password" value={ss.apiSecret} autoComplete="off" onChange={(e) => setSs({ ...ss, apiSecret: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="ss-currency">Account currency</label>
            <input id="ss-currency" type="text" value={ss.currency} maxLength={3} onChange={(e) => setSs({ ...ss, currency: e.target.value })} placeholder="USD" />
          </div>
        </form>
      ) : picked === "SENDCLOUD" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            In Sendcloud, open Settings → Integrations → API and create an integration; paste its public and secret key.
            The account needs a sender address, which becomes where returns are delivered. Sendcloud has no sandbox: in
            test mode parcels are announced without a label and nothing is charged.
          </p>
          <div className="field">
            <label htmlFor="sc-public">Public key</label>
            <input id="sc-public" type="text" value={sc.publicKey} autoComplete="off" onChange={(e) => setSc({ ...sc, publicKey: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="sc-secret">Secret key</label>
            <input id="sc-secret" type="password" value={sc.secretKey} autoComplete="off" onChange={(e) => setSc({ ...sc, secretKey: e.target.value })} required />
          </div>
          <label className="check-list__item">
            <input type="checkbox" checked={sc.testMode} onChange={(e) => setSc({ ...sc, testMode: e.target.checked })} />
            <span>
              <span className="radio-list__label">Test mode</span>
              <span className="radio-list__hint">Announce parcels without a label; nothing is charged.</span>
            </span>
          </label>
        </form>
      ) : picked === "DHL_EXPRESS" || picked === "FEDEX" || picked === "AUSPOST" || picked === "DEUTSCHE_POST" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="settings-row__hint" style={{ marginBottom: 12 }}>
            {picked === "DHL_EXPRESS" &&
              "From the DHL developer portal, create an app with the MyDHL API and paste its key and secret, plus your DHL Express account number. The test environment is the test mode."}
            {picked === "FEDEX" &&
              "From the FedEx Developer Portal, create a project with the Ship, Rate and Track APIs and paste its client id and secret, plus your FedEx account number. The sandbox is the test mode."}
            {picked === "AUSPOST" &&
              "From your MyPost Business or eParcel account, paste the Shipping and Tracking API key, its password, and your account number. The test environment is the test mode."}
            {picked === "DEUTSCHE_POST" &&
              "From the DHL developer portal, create an app with the Parcel DE Shipping API and paste its key, your business customer portal login, and the 14-digit billing number labels are charged to. The sandbox is the test mode."}
          </p>
          <div className="field">
            <label htmlFor="dc-a">{picked === "FEDEX" ? "Client id" : "API key"}</label>
            <input id="dc-a" type="password" value={dc.a} autoComplete="off" onChange={(e) => setDc({ ...dc, a: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="dc-b">{picked === "FEDEX" ? "Client secret" : picked === "AUSPOST" ? "API password" : picked === "DEUTSCHE_POST" ? "Business customer portal user" : "API secret"}</label>
            <input id="dc-b" type={picked === "DEUTSCHE_POST" ? "text" : "password"} value={dc.b} autoComplete="off" onChange={(e) => setDc({ ...dc, b: e.target.value })} required />
          </div>
          {picked === "DEUTSCHE_POST" && (
            <div className="field">
              <label htmlFor="dc-c">Business customer portal password</label>
              <input id="dc-c" type="password" value={dc.c} autoComplete="off" onChange={(e) => setDc({ ...dc, c: e.target.value })} required />
            </div>
          )}
          <div className="field">
            <label htmlFor="dc-account">{picked === "DEUTSCHE_POST" ? "Billing number" : "Account number"}</label>
            <input id="dc-account" type="text" value={dc.account} autoComplete="off" onChange={(e) => setDc({ ...dc, account: e.target.value })} required />
          </div>
          <label className="check-list__item">
            <input type="checkbox" checked={dc.testMode} onChange={(e) => setDc({ ...dc, testMode: e.target.checked })} />
            <span>
              <span className="radio-list__label">Use the test environment</span>
              <span className="radio-list__hint">Test labels, nothing charged. The credentials have to match the environment.</span>
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
  const path = `/admin/settings/${PATHS[provider]}`;
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

      {provider === "EXTERNAL" && data.external && (
        <>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Connector URL</div>
              <div className="settings-row__hint">
                Each approved return is posted here as a <code>label.requested</code> event: the return id and reference, the order number, both addresses, the items and the parcel. Reply with{" "}
                <code>labelUrl</code> (or <code>labelPdfBase64</code>), <code>trackingNumber</code>, <code>trackingUrl</code> and <code>carrier</code>, or reply empty and send them later. Connected {dateTime(data.external.connectedAt)}.
              </div>
            </div>
            <div style={{ width: "100%" }}>
              <CopyLink url={data.external.url} label="Connector URL" />
            </div>
          </div>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Shared secret</div>
              <div className="settings-row__hint">
                Requests to your connector carry <code>x-returns-signature: sha256=&lt;HMAC of the body&gt;</code> with this secret. Your connector sends it back as <code>x-api-key</code> on events.
              </div>
            </div>
            <div className="ship-secret">
              <code className="ship-secret__value">{showSecret ? data.external.secret : "•".repeat(24)}</code>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowSecret((v) => !v)}>
                {showSecret ? "Hide" : "Show"}
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void navigator.clipboard.writeText(data.external!.secret)}>
                Copy
              </button>
            </div>
          </div>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Events URL</div>
              <div className="settings-row__hint">
                Where your connector posts a label it made later, or where the parcel is: JSON with <code>returnId</code> (or <code>reference</code>), the label fields above, and optionally <code>status</code> of LABEL_CREATED, IN_TRANSIT, DELIVERED or FAILED.
              </div>
            </div>
            <div style={{ width: "100%" }}>
              <CopyLink url={data.external.eventsUrl} label="Events URL" />
            </div>
          </div>
        </>
      )}

      {(provider === "DHL_EXPRESS" || provider === "FEDEX" || provider === "AUSPOST" || provider === "DEUTSCHE_POST") && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Test environment</div>
              <div className="settings-row__hint">
                Test labels, nothing charged. The credentials have to belong to the environment chosen here; switching usually means reconnecting with the other set.
              </div>
            </div>
            <Switch
              on={Boolean(accountOf(data, provider)?.testMode)}
              label={`${name} test environment`}
              onChange={(testMode) => void run(() => api.patch(path, { testMode }, { auth: "admin" }), testMode ? "Test environment on." : "Production on — labels are real.")}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">How labels work</div>
              <div className="settings-row__hint">
                {provider === "DEUTSCHE_POST"
                  ? "A DHL Paket label from the customer to your return destination, charged to your billing number at your contract rate, which the API doesn't quote. Deleted before manifesting, it isn't charged."
                  : provider === "DHL_EXPRESS"
                    ? "Every DHL Express product on the lane is quoted at approval; the customer prints the label and hands the parcel to DHL. DHL doesn't cancel labels — an unused one isn't billed."
                    : provider === "FEDEX"
                      ? "Every FedEx service on the lane is quoted at approval; a print return label the customer drops off at FedEx. Cancelled labels are voided."
                      : "Every Australia Post product for the parcel is priced at approval; the customer prints the label and lodges the parcel. The label is hosted by Australia Post."}
              </div>
            </div>
          </div>
        </>
      )}

      {provider === "SHIPSTATION" && data.shipstation && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Test labels</div>
              <div className="settings-row__hint">ShipStation voids test labels and never charges for them. Off, labels buy real postage.</div>
            </div>
            <Switch
              on={data.shipstation.testMode}
              label="ShipStation test labels"
              onChange={(testMode) => void run(() => api.patch(path, { testMode }, { auth: "admin" }), testMode ? "Test labels on." : "Test labels off — labels are real again.")}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Tracking</div>
              <div className="settings-row__hint">
                ShipStation has no tracking API. The return page links to the carrier's own tracking; mark the return received when the parcel arrives.
              </div>
            </div>
          </div>
        </>
      )}

      {provider === "SENDCLOUD" && data.sendcloud && (
        <>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Test mode</div>
              <div className="settings-row__hint">Parcels are announced without a label and nothing is charged; the customer gets the app's test label.</div>
            </div>
            <Switch
              on={data.sendcloud.testMode}
              label="Sendcloud test mode"
              onChange={(testMode) => void run(() => api.patch(path, { testMode }, { auth: "admin" }), testMode ? "Test mode on." : "Test mode off — labels are real again.")}
            />
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Sender address</div>
              <div className="settings-row__hint">{data.sendcloud.senderAddress} — the first sender address on the Sendcloud account.</div>
            </div>
          </div>
          <div className="settings-row settings-row--stacked">
            <div>
              <div className="settings-row__label">Status webhook</div>
              <div className="settings-row__hint">
                In Sendcloud, open Settings → Integrations → your integration → Webhooks, and paste this URL. Sendcloud signs it with your secret key. Without it, open parcels are checked every half hour.
              </div>
            </div>
            <div style={{ width: "100%" }}>
              <CopyLink url={data.sendcloud.webhookUrl} label="Webhook URL" />
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


// ---------------------------------------------------------------------------
// Packing slips — shared with the policy editor
// ---------------------------------------------------------------------------

/**
 * Loop's "Generate packing slips" block: the switch, then what the slip
 * shows. Used for the store defaults here and per policy on the policies
 * page, so both say the same thing.
 */
export function PackingSlipFields({
  value,
  disabled,
  onChange,
}: {
  value: PackingSlipSettings;
  disabled?: boolean;
  onChange: (changes: Partial<PackingSlipSettings>) => void;
}) {
  return (
    <>
      <div className="settings-row">
        <div>
          <div className="settings-row__label">Generate packing slips</div>
          <div className="settings-row__hint">Automatically generate packing slips for a return.</div>
        </div>
        <Switch on={value.packingSlips} label="Generate packing slips" disabled={disabled} onChange={(packingSlips) => onChange({ packingSlips })} />
      </div>
      {value.packingSlips && (
        <div className="check-list" style={{ marginTop: 4 }}>
          <label className="check-list__item">
            <input type="checkbox" checked={value.packingSlipTaxInclusive} disabled={disabled} onChange={(e) => onChange({ packingSlipTaxInclusive: e.target.checked })} />
            <span>
              <span className="radio-list__label">Show tax-inclusive pricing on the packing slip</span>
              <span className="radio-list__hint">If enabled, the packing slip will display tax-inclusive pricing for each item.</span>
            </span>
          </label>
          <label className="check-list__item">
            <input type="checkbox" checked={value.packingSlipBarcode} disabled={disabled} onChange={(e) => onChange({ packingSlipBarcode: e.target.checked })} />
            <span>
              <span className="radio-list__label">Include barcode</span>
              <span className="radio-list__hint">Include a scannable barcode on the packing slip.</span>
            </span>
          </label>
          {value.packingSlipBarcode && (
            <div className="packing-barcode">
              <div className="field-label">Select what information to include in the barcode:</div>
              <div className="radio-list">
                {(
                  [
                    ["RETURN_ID", "Return ID", "Populate barcode on packing slip with the return's reference."],
                    ["ORDER_NUMBER", "Order number", "Populate barcode on packing slip with the order number."],
                  ] as Array<[PackingSlipBarcode, string, string]>
                ).map(([id, label, hint]) => (
                  <label key={id} className="radio-list__item">
                    <input type="radio" name="packing-barcode" checked={value.packingSlipBarcodeSource === id} disabled={disabled} onChange={() => onChange({ packingSlipBarcodeSource: id })} />
                    <span>
                      <span className="radio-list__label">{label}</span>
                      <span className="radio-list__hint">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}


// ---------------------------------------------------------------------------
// Package sizes
// ---------------------------------------------------------------------------

function PackageSizeDialog({
  size,
  first,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  size: PackageSize | null;
  /** The first size is the default whether or not it's asked to be. */
  first: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Omit<PackageSize, "id" | "summary">) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Omit<PackageSize, "id" | "summary">>(
    size
      ? { name: size.name, length: size.length, width: size.width, height: size.height, unit: size.unit, weight: size.weight, massUnit: size.massUnit, isDefault: size.isDefault }
      : { name: "", length: 30, width: 20, height: 10, unit: "CM", weight: 0.2, massUnit: "KG", isDefault: first },
  );
  const ready = draft.name.trim().length > 0 && draft.length > 0 && draft.width > 0 && draft.height > 0 && draft.weight >= 0;
  const dimension = (key: "length" | "width" | "height", label: string) => (
    <label className="label-defaults__field">
      <span className="settings-row__label">{label}</span>
      <NumberField value={draft[key]} min={0.1} step="0.1" unit={draft.unit.toLowerCase()} onChange={(value) => setDraft({ ...draft, [key]: value })} />
    </label>
  );
  return (
    <Modal
      title={size ? "Edit package size" : "Add package size"}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <button type="button" className="btn btn--danger btn--sm" disabled={busy} onClick={() => void onDelete()}>
              Delete
            </button>
          )}
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--sm" disabled={busy || !ready} onClick={() => void onSave({ ...draft, name: draft.name.trim() })}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="pkg-name">Name</label>
        <input id="pkg-name" type="text" value={draft.name} maxLength={80} placeholder="Small box" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="pkg-units">
        <label className="label-defaults__field">
          <span className="settings-row__label">Length unit</span>
          <select className="settings-input" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as PackageSize["unit"] })}>
            <option value="CM">Centimetres</option>
            <option value="IN">Inches</option>
          </select>
        </label>
        <label className="label-defaults__field">
          <span className="settings-row__label">Weight unit</span>
          <select className="settings-input" value={draft.massUnit} onChange={(e) => setDraft({ ...draft, massUnit: e.target.value as PackageSize["massUnit"] })}>
            <option value="KG">Kilograms</option>
            <option value="LB">Pounds</option>
          </select>
        </label>
      </div>
      <div className="label-defaults" style={{ marginTop: 14 }}>
        {dimension("length", "Length")}
        {dimension("width", "Width")}
        {dimension("height", "Height")}
        <label className="label-defaults__field">
          <span className="settings-row__label">Weight when empty</span>
          <NumberField value={draft.weight} min={0} step="0.05" unit={draft.massUnit.toLowerCase()} onChange={(weight) => setDraft({ ...draft, weight })} />
        </label>
      </div>
      <p className="settings-row__hint" style={{ marginTop: 10 }}>
        Most carriers bill on the parcel's actual weight; a large, light parcel may be billed on its volume. Pay-on-scan
        services reweigh the parcel when it's dropped off.
      </p>
      <label className="check-list__item" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={draft.isDefault} disabled={first || Boolean(size?.isDefault)} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
        <span>
          <span className="radio-list__label">Make this the default package size</span>
          <span className="radio-list__hint">Used for every label unless a routing rule names another.{first && " Your first size is the default."}</span>
        </span>
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Label references
// ---------------------------------------------------------------------------

const REFERENCE_TYPES: Array<[LabelReferenceType, string]> = [
  ["RMA_ID", "RMA ID (the return's reference)"],
  ["ORDER_NUMBER", "Order number"],
  ["PRODUCT_TITLE", "Product title"],
  ["RETURN_VALUE", "Return value"],
  ["CUSTOM", "Custom text"],
];

function LabelReferencesEditor({
  value,
  disabled,
  onSave,
}: {
  value: LabelReference[];
  disabled?: boolean;
  onSave: (references: LabelReference[]) => void;
}) {
  const [rows, setRows] = useState<LabelReference[]>(value);
  useEffect(() => setRows(value), [value]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(value);
  const set = (i: number, patch: Partial<LabelReference>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div style={{ width: "100%" }}>
      {rows.length > 0 && (
        <div className="refs">
          {rows.map((r, i) => (
            <div key={i} className="refs__row">
              <span className="refs__n">{i + 1}.</span>
              <select className="settings-input" value={r.type} aria-label={`Reference ${i + 1}`} onChange={(e) => set(i, { type: e.target.value as LabelReferenceType, text: e.target.value === "CUSTOM" ? (r.text ?? "") : undefined })}>
                {REFERENCE_TYPES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              {r.type === "CUSTOM" && (
                <input type="text" className="settings-input" value={r.text ?? ""} maxLength={35} placeholder="Up to 35 characters" aria-label={`Reference ${i + 1} text`} onChange={(e) => set(i, { text: e.target.value })} />
              )}
              <button type="button" className="steps__del" aria-label={`Remove reference ${i + 1}`} onClick={() => setRows(rows.filter((_, n) => n !== i))}>
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="ship-secret" style={{ marginTop: rows.length ? 10 : 0 }}>
        <button type="button" className="btn btn--secondary btn--sm" disabled={disabled || rows.length >= 3} onClick={() => setRows([...rows, { type: rows.length === 0 ? "RMA_ID" : "ORDER_NUMBER" }])}>
          + Add reference
        </button>
        <button type="button" className="btn btn--sm" disabled={disabled || !dirty} onClick={() => onSave(rows.map((r) => (r.type === "CUSTOM" ? { type: r.type, text: (r.text ?? "").trim() } : { type: r.type })))}>
          Save
        </button>
      </div>
    </div>
  );
}
