import { useEffect, useState } from "react";
import { Link, useBlocker, useLocation } from "react-router";
import { api } from "../lib/api";
import { COUNTRIES, countryName, flagOf } from "../lib/countries";
import type {
  FeeType,
  OutcomeKey,
  RegionalOutcome,
  RegionalPoliciesResponse,
  RegionalPolicy,
  ReturnDestination,
  ShopLocation,
  StorePolicySummary,
  WindowStart,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";
import { CountryPicker, NumberField, Switch } from "./policy-controls";
import { RoutingRulesTab } from "./RoutingRulesTab";

/**
 * Return policies by region, the way Loop lays them out, in four tabs.
 *
 * Policies: the store policy (Settings → Return policy) stays the source of
 * every mechanic. A policy here claims a set of countries and decides, for
 * orders shipped to them, only what a region is allowed to: which outcomes
 * are on, how long each stays open, what each costs, when the clock starts,
 * whether review is skipped, where the parcel goes back to, and how
 * exchanges behave. The "Default" card is the store policy itself.
 *
 * Destinations: the addresses returned goods are sent to, one of them the
 * default. Locations: which Shopify locations' stock counts for exchanges.
 */

type Draft = Omit<RegionalPolicy, "id" | "sortOrder"> & { id: string | null };
type Tab = "zone" | "outcomes" | "advanced";
type Page = "policies" | "destinations" | "locations" | "routing";

const PAGES: Array<{ id: Page; label: string; path: string }> = [
  { id: "policies", label: "Policies", path: "" },
  { id: "destinations", label: "Destinations", path: "/destinations" },
  { id: "locations", label: "Locations", path: "/locations" },
  { id: "routing", label: "Routing rules", path: "/routing" },
];

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "zone", label: "Policy name & zone", icon: "◎" },
  { id: "outcomes", label: "Return outcomes", icon: "▣" },
  { id: "advanced", label: "Advanced settings", icon: "⚙" },
];

const OUTCOMES: Array<{ key: OutcomeKey; title: string; blurb: string; noun: string }> = [
  {
    key: "REFUND",
    title: "Refund",
    blurb: "Allow customers to receive a refund on the original order.",
    noun: "a refund",
  },
  {
    key: "EXCHANGE",
    title: "Exchange",
    blurb: "Allow customers to exchange an item for a new variant.",
    noun: "an exchange",
  },
  {
    key: "STORE_CREDIT",
    title: "Store credit",
    blurb: "Allow customers to receive store credit to spend with you.",
    noun: "a store credit",
  },
  {
    key: "GIFT_CARD",
    title: "Gift card",
    blurb: "Allow customers to receive a Shopify gift card.",
    noun: "a gift card",
  },
];

const START_EVENTS: Array<[WindowStart, string]> = [
  ["FULFILLMENT", "Fulfillment date"],
  ["DELIVERY", "Delivery date"],
  ["ORDER_DATE", "Order date"],
];

/**
 * A new policy starts as a copy of the store policy's answers, so creating
 * one for a region that only needs a different fee is a one-field edit.
 */
const outcomesFrom = (
  base: StorePolicySummary | null,
): Record<OutcomeKey, RegionalOutcome> => {
  const fee =
    base && base.restockingFeePercent > 0
      ? { type: "PERCENT" as const, value: base.restockingFeePercent }
      : null;
  const days = base?.returnWindowDays ?? 30;
  const outcome = (enabled: boolean): RegionalOutcome => ({
    enabled,
    windowDays: days,
    fee,
  });
  return {
    REFUND: outcome(base?.allowRefund ?? true),
    EXCHANGE: outcome(base?.allowExchange ?? true),
    STORE_CREDIT: outcome(base?.allowStoreCredit ?? true),
    GIFT_CARD: outcome(base?.allowGiftCard ?? false),
  };
};

const blankPolicy = (base: StorePolicySummary | null): Draft => ({
  id: null,
  name: "",
  countries: [],
  destinationId: null,
  inventoryLocationIds: [],
  allowInstantExchange: base?.allowInstantExchange ?? false,
  allowAdvancedExchange: true,
  exchangeShippingMethod: null,
  windowStartsFrom: base?.windowStartsFrom ?? "DELIVERY",
  bypassReview: base?.autoApprove ?? false,
  instructions: [],
  outcomes: outcomesFrom(base),
});

const blankDestination = (): DestinationDraft => ({
  id: null,
  name: "",
  address1: "",
  address2: "",
  city: "",
  province: "",
  zip: "",
  countryCode: "",
  phone: "",
  isDefault: false,
  locationId: null,
});

type DestinationDraft = {
  id: string | null;
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  countryCode: string;
  phone: string;
  isDefault: boolean;
  locationId: string | null;
};

const formatMoney = (value: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
};

/** The currency's symbol on its own, for the fee field's prefix. */
const currencySymbol = (currency: string): string => {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
};

/** "30 days, 5% handling fee" — one line per outcome on a card. */
const describeOutcome = (o: RegionalOutcome, currency: string): string => {
  if (!o.enabled) return "Disabled";
  const window = o.windowDays === null ? "Unlimited" : `${o.windowDays} days`;
  if (!o.fee) return window;
  if (o.fee.type === "PRODUCT_TAG") return `${window}, handling fee by product tag`;
  if (o.fee.value <= 0) return window;
  const fee =
    o.fee.type === "PERCENT"
      ? `${o.fee.value}%`
      : formatMoney(o.fee.value, currency);
  return `${window}, ${fee} handling fee`;
};

/** A dialog, dimmed behind, closed by its button, the backdrop or Escape. */
function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
        <div className="modal__foot">{footer}</div>
      </div>
    </div>
  );
}

/** The store's destinations, one of which the region's returns go to. */
function DestinationsModal({
  destinations,
  selected,
  destinationsPath,
  onSelect,
  onClose,
}: {
  destinations: ReturnDestination[];
  selected: string | null;
  destinationsPath: string;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Manage destinations"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          Close
        </button>
      }
    >
      {destinations.length === 0 ? (
        <p className="muted" style={{ padding: "12px 0" }}>
          No destinations yet.{" "}
          <Link to={destinationsPath}>Add one on the Destinations tab</Link> and it
          will appear here.
        </p>
      ) : (
        destinations.map((d) => (
          <label key={d.id} className="dest-row">
            <input
              type="checkbox"
              checked={selected === d.id}
              onChange={() => onSelect(selected === d.id ? null : d.id)}
            />
            <span className="dest-row__icon" aria-hidden="true">
              {flagOf(d.countryCode)}
            </span>
            <span>
              <span className="dest-row__name">
                {d.name}
                {d.isDefault && <span className="pcard__badge dest-row__badge">Default</span>}
              </span>
              <span className="dest-row__addr">{d.address}</span>
            </span>
          </label>
        ))
      )}
    </Modal>
  );
}

/** Tick the Shopify locations whose stock should count. Saved on "Done". */
function LocationsModal({
  locations,
  selected,
  onSave,
  onClose,
}: {
  locations: ShopLocation[];
  selected: string[];
  onSave: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  return (
    <Modal
      title="Manage locations"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginLeft: 8 }}
            onClick={() => onSave(picked)}
          >
            Done
          </button>
        </>
      }
    >
      {locations.length === 0 ? (
        <p className="muted" style={{ padding: "12px 0" }}>
          Connect your Shopify store to choose locations. Its locations will
          appear here.
        </p>
      ) : (
        locations.map((l) => (
          <label key={l.id} className="dest-row">
            <input
              type="checkbox"
              checked={picked.includes(l.id)}
              onChange={() => toggle(l.id)}
            />
            <span className="dest-row__icon" aria-hidden="true">
              ⌂
            </span>
            <span>
              <span className="dest-row__name">{l.name}</span>
              <span className="dest-row__addr">
                {l.address ?? "No address on file in Shopify"}
              </span>
            </span>
          </label>
        ))
      )}
    </Modal>
  );
}

/**
 * The handling fee for one outcome: the switch, the four ways of charging
 * it, and the amount. Laid out as Loop's is, including the label-cost option
 * this app can't yet compute, which is shown but not offered.
 */
function HandlingFees({
  noun,
  value,
  currency,
  onChange,
}: {
  noun: string;
  value: RegionalOutcome;
  currency: string;
  onChange: (fee: RegionalOutcome["fee"]) => void;
}) {
  const fee = value.fee;
  const setType = (type: FeeType) => onChange({ type, value: fee?.value ?? 0 });

  return (
    <>
      <label className="check-list__item">
        <input
          type="checkbox"
          checked={fee !== null}
          onChange={(e) => onChange(e.target.checked ? { type: "FLAT", value: 0 } : null)}
        />
        <span>
          <span className="radio-list__label">Handling fees</span>
          <span className="radio-list__hint">
            Charge a handling fee for returns with {noun} outcome. It's deducted
            from what the customer gets back.
          </span>
        </span>
      </label>

      {fee && (
        <div className="fee">
          <div className="radio-list">
            <label className="radio-list__item">
              <input
                type="radio"
                checked={fee.type === "FLAT"}
                onChange={() => setType("FLAT")}
              />
              <span>
                <span className="radio-list__label">Flat rate</span>
                <span className="radio-list__hint">
                  Charge a handling fee as a fixed amount, once per return.
                </span>
              </span>
            </label>
            <label className="radio-list__item is-disabled">
              <input type="radio" checked={false} disabled onChange={() => undefined} />
              <span>
                <span className="radio-list__label">Percentage of estimated label cost</span>
                <span className="radio-list__hint">
                  Charge a dynamic handling fee that is based on the estimated
                  label cost. Needs return labels, which aren't set up yet.
                </span>
              </span>
            </label>
            <label className="radio-list__item">
              <input
                type="radio"
                checked={fee.type === "PERCENT"}
                onChange={() => onChange({ type: "PERCENT", value: Math.min(fee.value, 100) })}
              />
              <span>
                <span className="radio-list__label">Percentage of return value</span>
                <span className="radio-list__hint">
                  Charge a dynamic handling fee based on the value of the items
                  being returned.
                </span>
              </span>
            </label>
            <label className="radio-list__item">
              <input
                type="radio"
                checked={fee.type === "PRODUCT_TAG"}
                onChange={() => setType("PRODUCT_TAG")}
              />
              <span>
                <span className="radio-list__label">Product tag</span>
                <span className="radio-list__hint">
                  Charge a fee based on the products being returned.
                </span>
              </span>
            </label>
          </div>

          {fee.type === "PRODUCT_TAG" && (
            <div className="infobox" style={{ marginTop: 14 }}>
              <span className="infobox__icon" aria-hidden="true">
                i
              </span>
              <div>
                <strong>Tag products in Shopify with the fee.</strong> Add{" "}
                <code>handling-fee:10</code> to charge 10 {currency}, or{" "}
                <code>handling-fee:free</code> to exempt a product. Use{" "}
                <code>refund-fee</code>, <code>exchange-fee</code>, <code>credit-fee</code> or{" "}
                <code>gift-card-fee</code> for an amount that applies to one outcome
                only. The highest tag on a return is charged once; a product tagged
                free exempts the whole return; untagged products use the fallback
                below.
              </div>
            </div>
          )}

          <div className="pairing__divider" />
          <div className="field-label">
            {fee.type === "PRODUCT_TAG" ? "Fallback handling fee" : "Handling Fee"}
          </div>
          <NumberField
            value={fee.value}
            min={0}
            max={fee.type === "PERCENT" ? 100 : undefined}
            step="0.01"
            unit={fee.type === "PERCENT" ? "%" : currencySymbol(currency)}
            unitFirst={fee.type !== "PERCENT"}
            wide
            onChange={(amount) => onChange({ ...fee, value: amount })}
          />
          {fee.type === "PRODUCT_TAG" && (
            <p className="settings-row__hint" style={{ marginTop: 8 }}>
              Charged, once per return, when a returned product carries no fee
              tag. Leave at 0 to charge untagged products nothing.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** One outcome: the switch, then its window, fee and any extras once it's on. */
function OutcomePanel({
  title,
  blurb,
  noun,
  value,
  currency,
  onChange,
  afterWindow,
  afterFees,
}: {
  title: string;
  blurb: string;
  noun: string;
  value: RegionalOutcome;
  currency: string;
  onChange: (value: RegionalOutcome) => void;
  afterWindow?: React.ReactNode;
  afterFees?: React.ReactNode;
}) {
  const set = (patch: Partial<RegionalOutcome>) => onChange({ ...value, ...patch });

  return (
    <div className="panel">
      <div className="panel__head">
        <div>
          <h2 style={{ marginBottom: 0 }}>{title}</h2>
          <p className="settings-row__hint">{blurb}</p>
        </div>
        <Switch on={value.enabled} label={title} onChange={(on) => set({ enabled: on })} />
      </div>

      {value.enabled && (
        <>
          <div className="pairing__divider" />
          <div className="field-label">Return window duration</div>
          <div className="window-fields">
            <select
              value={value.windowDays === null ? "UNLIMITED" : "LIMITED"}
              aria-label="Return window"
              onChange={(e) =>
                set({
                  windowDays:
                    e.target.value === "UNLIMITED" ? null : (value.windowDays ?? 30),
                })
              }
            >
              <option value="LIMITED">Limited window</option>
              <option value="UNLIMITED">Unlimited window</option>
            </select>
            {value.windowDays !== null && (
              <NumberField
                value={value.windowDays}
                min={1}
                max={3650}
                unit="days"
                onChange={(windowDays) => set({ windowDays })}
              />
            )}
          </div>

          {afterWindow}

          <div className="pairing__divider" />
          <HandlingFees
            noun={noun}
            value={value}
            currency={currency}
            onChange={(fee) => set({ fee })}
          />

          {afterFees}
        </>
      )}
    </div>
  );
}

function PolicyCard({
  title,
  badge,
  from,
  to,
  rows,
  edit,
}: {
  title: string;
  badge?: string;
  from: React.ReactNode;
  to: React.ReactNode;
  rows: Array<[string, string]>;
  edit: React.ReactNode;
}) {
  return (
    <div className="pcard">
      <div className="pcard__head">
        <div>
          <div className="pcard__title">{title}</div>
          {badge && <span className="pcard__badge">{badge}</span>}
        </div>
        {edit}
      </div>
      <div className="pcard__row">
        <div className="pcard__label">Returning from:</div>
        <div className="pcard__flags">{from}</div>
      </div>
      <div className="pcard__row">
        <div className="pcard__label">Returning to:</div>
        <div>{to}</div>
      </div>
      <div className="pcard__row">
        <div className="pcard__label">Return outcomes:</div>
        <div className="pcard__outcomes">
          {rows.map(([label, text]) => (
            <div key={label}>
              {label}: {text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A labelled text field in the destination form. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  span = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  span?: boolean;
}) {
  return (
    <label className={`dform__field${span ? " dform__field--span" : ""}`}>
      <span className="field-label">{label}</span>
      <input
        type="text"
        className="settings-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function PoliciesPage() {
  const { session } = useAuth();
  const { pathname } = useLocation();
  const page: Page = pathname.endsWith("/destinations")
    ? "destinations"
    : pathname.endsWith("/locations")
      ? "locations"
      : pathname.endsWith("/routing")
        ? "routing"
        : "policies";

  const [data, setData] = useState<RegionalPoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The policy being edited, and what it looked like when opened. */
  const [editing, setEditing] = useState<Draft | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [tab, setTab] = useState<Tab>("zone");
  const [choosingDestination, setChoosingDestination] = useState(false);
  const [choosingPolicyLocations, setChoosingPolicyLocations] = useState(false);
  /** The destination being added or edited, on the Destinations tab. */
  const [destination, setDestination] = useState<DestinationDraft | null>(null);
  /** The Locations tab's dialog, and whether the store's token can read stock. */
  const [choosingStoreLocations, setChoosingStoreLocations] = useState(false);
  const [inventoryProblem, setInventoryProblem] = useState<string | null | undefined>(
    undefined,
  );

  const load = () =>
    api
      .get<RegionalPoliciesResponse>("/admin/settings/regional-policies", {
        auth: "admin",
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  // Asked once, when the Locations tab is first opened: it's a Shopify call.
  useEffect(() => {
    if (page !== "locations" || inventoryProblem !== undefined) return;
    api
      .get<{ problem: string | null }>("/admin/settings/inventory-access", { auth: "admin" })
      .then((r) => setInventoryProblem(r.problem))
      .catch(() => setInventoryProblem(null));
  }, [page, inventoryProblem]);

  // Leaving the tab closes whatever was being edited on it.
  useEffect(() => {
    setStatus(null);
    setError(null);
    if (page !== "policies") setEditing(null);
    if (page !== "destinations") setDestination(null);
  }, [page]);

  const dirty = editing !== null && JSON.stringify(editing) !== original;
  const blocker = useBlocker(dirty);

  const open = (policy: Draft) => {
    setEditing(policy);
    setOriginal(JSON.stringify(policy));
    setTab("zone");
    setStatus(null);
    setError(null);
    window.scrollTo({ top: 0 });
  };

  const close = () => {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setEditing(null);
    setChoosingDestination(false);
    setChoosingPolicyLocations(false);
  };

  const patch = (changes: Partial<Draft>) =>
    setEditing((prev) => (prev ? { ...prev, ...changes } : prev));

  const problems = (draft: Draft): string[] => {
    const list: string[] = [];
    if (!draft.name.trim()) list.push("Give the policy a name.");
    if (draft.countries.length === 0) list.push("Add at least one country.");
    const on = OUTCOMES.filter((o) => draft.outcomes[o.key].enabled);
    if (on.length === 0) list.push("Turn on at least one return outcome.");
    for (const o of on) {
      const v = draft.outcomes[o.key];
      if (v.windowDays !== null && v.windowDays < 1) {
        list.push(`${o.title}: the window must be at least one day.`);
      }
      if (v.fee && v.fee.type === "PERCENT" && v.fee.value > 100) {
        list.push(`${o.title}: a percentage fee can't be more than 100%.`);
      }
    }
    return list;
  };

  const save = async () => {
    if (!editing || saving) return;
    const issues = problems(editing);
    if (issues.length > 0) {
      setError(issues[0]);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: editing.name.trim(),
        countries: editing.countries,
        destinationId: editing.destinationId,
        inventoryLocationIds: editing.inventoryLocationIds,
        allowInstantExchange: editing.allowInstantExchange,
        allowAdvancedExchange: editing.allowAdvancedExchange,
        exchangeShippingMethod: editing.exchangeShippingMethod?.trim() || null,
        windowStartsFrom: editing.windowStartsFrom,
        bypassReview: editing.bypassReview,
        instructions: editing.instructions.map((s) => s.trim()).filter(Boolean),
        outcomes: editing.outcomes,
      };
      if (editing.id) {
        await api.patch(`/admin/settings/regional-policies/${editing.id}`, body, {
          auth: "admin",
        });
      } else {
        await api.post("/admin/settings/regional-policies", body, { auth: "admin" });
      }
      await load();
      setEditing(null);
      setStatus(`Saved "${body.name}".`);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that policy.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    if (
      !window.confirm(
        `Delete "${editing.name}"? Orders shipped to its countries will follow your store policy again.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api.delete(`/admin/settings/regional-policies/${editing.id}`, {
        auth: "admin",
      });
      await load();
      setEditing(null);
      setStatus("Policy deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that policy.");
    }
  };

  // --- destinations -------------------------------------------------------

  const openDestination = (d: ReturnDestination | null) => {
    setDestination(
      d
        ? {
            id: d.id,
            name: d.name,
            address1: d.address1,
            address2: d.address2 ?? "",
            city: d.city,
            province: d.province ?? "",
            zip: d.zip ?? "",
            countryCode: d.countryCode,
            phone: d.phone ?? "",
            isDefault: d.isDefault,
            locationId: d.locationId,
          }
        : blankDestination(),
    );
    setStatus(null);
    setError(null);
  };

  const saveDestination = async () => {
    if (!destination || saving) return;
    if (!destination.name.trim()) return setError("Give the destination a name.");
    if (!destination.countryCode) return setError("Choose a country.");
    if (!destination.address1.trim()) return setError("Enter the street address.");
    if (!destination.city.trim()) return setError("Enter the city.");
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: destination.name.trim(),
        address1: destination.address1.trim(),
        address2: destination.address2.trim() || null,
        city: destination.city.trim(),
        province: destination.province.trim() || null,
        zip: destination.zip.trim() || null,
        countryCode: destination.countryCode,
        phone: destination.phone.trim() || null,
        isDefault: destination.isDefault,
        locationId: destination.locationId,
      };
      if (destination.id) {
        await api.patch(`/admin/settings/destinations/${destination.id}`, body, {
          auth: "admin",
        });
      } else {
        await api.post("/admin/settings/destinations", body, { auth: "admin" });
      }
      await load();
      setDestination(null);
      setStatus(`Saved "${body.name}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that destination.");
    } finally {
      setSaving(false);
    }
  };

  const removeDestination = async () => {
    if (!destination?.id) return;
    if (!window.confirm(`Delete "${destination.name}"?`)) return;
    setError(null);
    try {
      await api.delete(`/admin/settings/destinations/${destination.id}`, { auth: "admin" });
      await load();
      setDestination(null);
      setStatus("Destination deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that destination.");
    }
  };

  const saveStoreLocations = async (ids: string[]) => {
    setChoosingStoreLocations(false);
    setError(null);
    try {
      await api.patch("/admin/settings/store", { inventoryLocationIds: ids }, { auth: "admin" });
      await load();
      setStatus(
        ids.length === 0
          ? "Inventory is counted across every location."
          : `Inventory is counted at ${ids.length} location${ids.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the locations.");
    }
  };

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Return policies</h1>
        <ErrorAlert message={error ?? "Couldn't load your policies."} />
      </>
    );
  }

  const { policies, base, locations, destinations, inventoryLocationIds, currency } = data;
  const basePath = storePath(session!.merchant.slug);
  const pagePath = (p: Page) => `${basePath}/settings/policies${PAGES.find((x) => x.id === p)!.path}`;
  const locationName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? "A location no longer in your store";
  const defaultDestination = destinations.find((d) => d.isDefault) ?? null;
  const destinationById = (id: string | null) =>
    id ? (destinations.find((d) => d.id === id) ?? null) : null;

  const cardRows = (
    outcomes: Record<OutcomeKey, RegionalOutcome>,
    bypassReview: boolean,
  ): Array<[string, string]> => [
    ...OUTCOMES.filter(
      (o) => o.key !== "GIFT_CARD" || outcomes[o.key].enabled,
    ).map((o): [string, string] => [o.title, describeOutcome(outcomes[o.key], currency)]),
    ...(bypassReview ? [["Review", "Skipped — approved on submission"] as [string, string]] : []),
  ];

  const destinationLabel = (d: ReturnDestination | null) =>
    d ? (
      <span>
        <span aria-hidden="true">{flagOf(d.countryCode)}</span> {d.name}
      </span>
    ) : (
      <span className="muted">No destination set</span>
    );

  const chosenDestination = editing
    ? (destinationById(editing.destinationId) ?? null)
    : null;

  /**
   * The window as one figure, for the panel at the top of the outcomes tab.
   *
   * Every outcome carries its own duration underneath, so the shared control
   * shows the value they all agree on — or, when they differ, the first
   * enabled outcome's — and writes to all of them at once. The summary line
   * beside it always says what each outcome actually has.
   */
  const windowsOn = editing
    ? OUTCOMES.filter((o) => editing.outcomes[o.key].enabled).map((o) => ({
        title: o.title,
        days: editing.outcomes[o.key].windowDays,
      }))
    : [];
  const allWindows = editing ? OUTCOMES.map((o) => editing.outcomes[o.key].windowDays) : [];
  const windowsAgree = allWindows.every((d) => d === allWindows[0]);
  const sharedWindow: number | null = editing
    ? windowsAgree
      ? (allWindows[0] ?? 30)
      : (windowsOn[0]?.days ?? allWindows[0] ?? 30)
    : 30;
  const setAllWindows = (days: number | null) =>
    setEditing((prev) =>
      prev
        ? {
            ...prev,
            outcomes: Object.fromEntries(
              OUTCOMES.map((o) => [o.key, { ...prev.outcomes[o.key], windowDays: days }]),
            ) as Draft["outcomes"],
          }
        : prev,
    );
  const windowSummary =
    windowsOn.length === 0
      ? "No return outcome is on yet."
      : windowsOn
          .map((w) => `${w.title}: ${w.days === null ? "unlimited" : `${w.days} days`}`)
          .join(" · ") + (windowsAgree ? "." : " — set per outcome below.");

  const subtabs = (
    <nav className="tabs subtabs" aria-label="Return policy settings">
      {PAGES.map((p) => (
        <Link
          key={p.id}
          to={pagePath(p.id)}
          className={`tab${page === p.id ? " is-active" : ""}`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );

  // -------------------------------------------------------------------------
  // Routing rules tab — its own component; it loads its own data
  // -------------------------------------------------------------------------
  if (page === "routing") return <RoutingRulesTab subtabs={subtabs} />;

  // -------------------------------------------------------------------------
  // Destinations tab
  // -------------------------------------------------------------------------
  if (page === "destinations") {
    return (
      <>
        <div className="admin__header">
          <div>
            <div className="admin__eyebrow">Settings</div>
            <h1>Destinations</h1>
          </div>
          {!destination && (
            <button className="btn btn--sm" onClick={() => openDestination(null)}>
              Add destination
            </button>
          )}
        </div>
        {subtabs}
        <ErrorAlert message={error} />
        {status && <div className="alert alert--info">{status}</div>}

        <div className="split">
          <div>
            <h3 className="split__title">Destinations</h3>
            <p className="split__blurb">
              Manage the places your returned items are received. Customers are
              shown the address on their confirmation page, and a return policy
              can send its region's returns to a destination of its own.
            </p>
          </div>

          {destination ? (
            <div className="panel">
              <h2>{destination.id ? "Edit destination" : "New destination"}</h2>
              <div className="dform">
                <Field
                  label="Name"
                  value={destination.name}
                  placeholder="Main warehouse"
                  onChange={(name) => setDestination({ ...destination, name })}
                  span
                />
                <label className="dform__field dform__field--span">
                  <span className="field-label">Country</span>
                  <select
                    className="settings-input"
                    value={destination.countryCode}
                    onChange={(e) =>
                      setDestination({ ...destination, countryCode: e.target.value })
                    }
                  >
                    <option value="">Choose a country</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label="Address"
                  value={destination.address1}
                  placeholder="1 Oxford Street"
                  onChange={(address1) => setDestination({ ...destination, address1 })}
                  span
                />
                <Field
                  label="Apartment, suite, etc."
                  value={destination.address2}
                  onChange={(address2) => setDestination({ ...destination, address2 })}
                  span
                />
                <Field
                  label="City"
                  value={destination.city}
                  onChange={(city) => setDestination({ ...destination, city })}
                />
                <Field
                  label="State / province"
                  value={destination.province}
                  onChange={(province) => setDestination({ ...destination, province })}
                />
                <Field
                  label="Postal code"
                  value={destination.zip}
                  onChange={(zip) => setDestination({ ...destination, zip })}
                />
                <Field
                  label="Phone"
                  value={destination.phone}
                  onChange={(phone) => setDestination({ ...destination, phone })}
                />
                <label className="dform__field dform__field--span">
                  <span className="field-label">Restock returned items at</span>
                  <select
                    className="settings-input"
                    value={destination.locationId ?? ""}
                    onChange={(e) =>
                      setDestination({ ...destination, locationId: e.target.value || null })
                    }
                  >
                    <option value="">Don't restock here — use the store default</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <span className="settings-row__hint">
                    The Shopify location this address is, if it's one. Returns
                    sent here are restocked there.
                    {locations.length === 0 && " Connect your Shopify store to choose one."}
                  </span>
                </label>
                <label className="check-list__item dform__field--span">
                  <input
                    type="checkbox"
                    checked={destination.isDefault}
                    disabled={destinations.length === 0 || (destination.id !== null && destinations.find((d) => d.id === destination.id)?.isDefault === true)}
                    onChange={(e) =>
                      setDestination({ ...destination, isDefault: e.target.checked })
                    }
                  />
                  <span>
                    <span className="radio-list__label">Make this the default destination</span>
                    <span className="radio-list__hint">
                      Where returns go unless a policy says otherwise.
                      {destinations.length === 0 && " Your first destination is the default."}
                    </span>
                  </span>
                </label>
              </div>

              <div className="rule-actions">
                {destination.id && (
                  <button className="btn btn--danger btn--sm" onClick={() => void removeDestination()}>
                    Delete
                  </button>
                )}
                <div className="rule-actions__right">
                  <button className="btn btn--secondary btn--sm" onClick={() => setDestination(null)}>
                    Cancel
                  </button>
                  <button className="btn btn--sm" disabled={saving} onClick={() => void saveDestination()}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="panel">
              {destinations.length === 0 ? (
                <p className="muted">
                  No destinations yet. Add one and customers will be told where
                  to send their returns.
                </p>
              ) : (
                destinations.map((d) => (
                  <div key={d.id} className="dest-row dest-row--static">
                    <span className="dest-row__icon" aria-hidden="true">
                      {flagOf(d.countryCode)}
                    </span>
                    <span className="dest-row__body">
                      <span className="dest-row__name">
                        {d.name}
                        {d.isDefault && <span className="pcard__badge dest-row__badge">Default</span>}
                      </span>
                      <span className="dest-row__addr">{d.address}</span>
                    </span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => openDestination(d)}
                    >
                      Edit
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Locations tab
  // -------------------------------------------------------------------------
  if (page === "locations") {
    return (
      <>
        <div className="admin__header">
          <div>
            <div className="admin__eyebrow">Settings</div>
            <h1>Locations</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Choose your location configuration.
            </p>
          </div>
        </div>
        {subtabs}
        <ErrorAlert message={error} />
        {status && <div className="alert alert--info">{status}</div>}
        {inventoryProblem && <div className="alert alert--warn">{inventoryProblem}</div>}

        <div className="split">
          <div>
            <h3 className="split__title">Exchange inventory locations</h3>
            <p className="split__blurb">
              Manage locations from which inventory for exchanges is read. If no
              locations are selected, inventory from all locations in your
              Shopify store is used.
            </p>
            <p className="split__blurb">
              Inventory locations can be further configured within each{" "}
              <Link to={pagePath("policies")}>return policy</Link>.
            </p>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 style={{ marginBottom: 0 }}>Locations</h2>
              <button
                className="btn btn--sm"
                disabled={locations.length === 0}
                onClick={() => setChoosingStoreLocations(true)}
              >
                Manage locations
              </button>
            </div>
            {locations.length === 0 ? (
              <p className="muted">Connect your Shopify store to choose locations.</p>
            ) : inventoryLocationIds.length === 0 ? (
              <p className="muted">
                All locations — a product is offered as an exchange when any of
                your locations has it in stock.
              </p>
            ) : (
              <div className="loc-list">
                {inventoryLocationIds.map((id) => (
                  <div key={id} className="loc-list__item">
                    <span className="dest-row__icon" aria-hidden="true">
                      ⌂
                    </span>
                    <span>
                      <span className="dest-row__name">{locationName(id)}</span>
                      {locations.find((l) => l.id === id)?.address && (
                        <span className="dest-row__addr">
                          {locations.find((l) => l.id === id)!.address}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {choosingStoreLocations && (
          <LocationsModal
            locations={locations}
            selected={inventoryLocationIds}
            onSave={(ids) => void saveStoreLocations(ids)}
            onClose={() => setChoosingStoreLocations(false)}
          />
        )}
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Policies tab — the list, or the editor
  // -------------------------------------------------------------------------
  return (
    <>
      <div className="admin__header">
        <div>
          {editing ? (
            <button type="button" className="link-btn peditor__back" onClick={close}>
              ‹ Return policies
            </button>
          ) : (
            <div className="admin__eyebrow">Settings</div>
          )}
          <h1>{editing ? (editing.id ? "Edit policy" : "Create new policy") : "Return policies"}</h1>
          {!editing && (
            <p className="muted" style={{ marginTop: 4 }}>
              Different rules for different places. A policy covers the
              countries you choose and decides which outcomes those customers
              are offered, for how long, and at what cost. Everything else
              comes from your store policy.
            </p>
          )}
        </div>
        {!editing && (
          <button className="btn btn--sm" onClick={() => open(blankPolicy(base))}>
            Create new policy
          </button>
        )}
      </div>

      {!editing && subtabs}

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      {!editing && (
        <>
          <div className="pgrid">
            {base && (
              <PolicyCard
                title={base.name}
                badge="Default"
                from={
                  <span>
                    <span aria-hidden="true">🌐</span> All other countries
                  </span>
                }
                to={destinationLabel(defaultDestination)}
                rows={cardRows(outcomesFrom(base), base.autoApprove)}
                edit={
                  <Link className="btn btn--secondary btn--sm" to={`${basePath}/settings/policy`}>
                    Edit
                  </Link>
                }
              />
            )}
            {policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                title={policy.name}
                from={
                  <>
                    {policy.countries.slice(0, 6).map((code) => (
                      <span key={code}>
                        <span aria-hidden="true">{flagOf(code)}</span> {countryName(code)}
                      </span>
                    ))}
                    {policy.countries.length > 6 && (
                      <span className="muted">+{policy.countries.length - 6} more</span>
                    )}
                  </>
                }
                to={destinationLabel(destinationById(policy.destinationId) ?? defaultDestination)}
                rows={cardRows(policy.outcomes, policy.bypassReview)}
                edit={
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => open({ ...policy })}
                  >
                    Edit
                  </button>
                }
              />
            ))}
          </div>

          <div className="panel" style={{ marginTop: 20, maxWidth: 820 }}>
            <h2>How policies apply</h2>
            <p className="settings-row__hint">
              When a customer looks up an order, the country it shipped to picks
              the policy: the one that lists that country, or the Default if none
              does. A policy only decides which outcomes are offered, their
              windows and handling fees, when the window starts, whether review
              is skipped, where returns are sent, and how exchanges behave.
              Product tag rules, bonus credit and everything else are shared,
              from your store policy.
            </p>
          </div>
        </>
      )}

      {editing && (
        <div className="peditor">
          <nav className="pnav" aria-label="Policy sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`pnav__item${tab === t.id ? " is-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <span className="pnav__icon" aria-hidden="true">
                  {t.icon}
                </span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-form peditor__body">
            {tab === "zone" && (
              <>
                <div className="panel">
                  <h2>Policy name</h2>
                  <input
                    type="text"
                    className="settings-input"
                    maxLength={80}
                    value={editing.name}
                    placeholder="United Kingdom"
                    aria-label="Policy name"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                  <p className="settings-row__hint" style={{ marginTop: 8 }}>
                    Your shoppers won't see this.
                  </p>
                </div>

                <div className="panel">
                  <h2>Returning from</h2>
                  <CountryPicker
                    selected={editing.countries}
                    onChange={(countries) => patch({ countries })}
                    emptyHint="Add every country this policy covers. An order shipped to any of them follows this policy instead of your store policy."
                  />
                </div>

                <div className="panel">
                  <div className="panel__head">
                    <h2 style={{ marginBottom: 0 }}>Returning to</h2>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setChoosingDestination(true)}
                    >
                      Manage destinations
                    </button>
                  </div>
                  {chosenDestination ? (
                    <div className="dest" style={{ marginTop: 14 }}>
                      <span className="dest-row__icon" aria-hidden="true">
                        {flagOf(chosenDestination.countryCode)}
                      </span>
                      <div>
                        <div className="dest__name">{chosenDestination.name}</div>
                        <div className="muted">{chosenDestination.address}</div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 14 }}>
                      <div className="settings-row__label">No destination selected</div>
                      <div className="settings-row__hint">
                        Select a destination for this return policy.{" "}
                        {defaultDestination
                          ? `Without one, returns go to your default destination, ${defaultDestination.name}.`
                          : "Without one, customers aren't shown an address — add one on the Destinations tab."}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === "outcomes" && (
              <>
                <div className="panel">
                  <h2 style={{ marginBottom: 4 }}>Shopper return window</h2>
                  <p className="settings-row__hint" style={{ marginBottom: 16 }}>
                    Choose when the shopper's return window starts and how long
                    it stays open, for all return outcomes below. Each outcome
                    can then set a duration of its own.
                  </p>
                  <div className="window-grid">
                    <div>
                      <div className="field-label">Start event</div>
                      <div className="window-fields">
                        <select
                          value={editing.windowStartsFrom}
                          aria-label="Start event"
                          onChange={(e) =>
                            patch({ windowStartsFrom: e.target.value as WindowStart })
                          }
                        >
                          {START_EVENTS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div className="field-label">Return window duration</div>
                      <div className="window-fields">
                        <select
                          value={sharedWindow === null ? "UNLIMITED" : "LIMITED"}
                          aria-label="Return window duration for all outcomes"
                          onChange={(e) =>
                            setAllWindows(
                              e.target.value === "UNLIMITED" ? null : (sharedWindow ?? 30),
                            )
                          }
                        >
                          <option value="LIMITED">Limited window</option>
                          <option value="UNLIMITED">Unlimited window</option>
                        </select>
                        {sharedWindow !== null && (
                          <NumberField
                            value={sharedWindow}
                            min={1}
                            max={3650}
                            unit="days"
                            onChange={setAllWindows}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="settings-row__hint" style={{ marginTop: 10 }}>
                    {windowSummary}
                    {editing.windowStartsFrom === "DELIVERY" &&
                      " Counted from the shipment if the carrier never confirms delivery."}
                  </p>
                </div>

                {OUTCOMES.map((o) => (
                  <OutcomePanel
                    key={o.key}
                    title={o.title}
                    blurb={o.blurb}
                    noun={o.noun}
                    value={editing.outcomes[o.key]}
                    currency={currency}
                    onChange={(value) =>
                      patch({ outcomes: { ...editing.outcomes, [o.key]: value } })
                    }
                    afterWindow={
                      o.key === "EXCHANGE" ? (
                        <>
                          <div className="pairing__divider" />
                          <label className="check-list__item">
                            <input
                              type="checkbox"
                              checked={editing.allowInstantExchange}
                              onChange={(e) => patch({ allowInstantExchange: e.target.checked })}
                            />
                            <span>
                              <span className="radio-list__label">Allow instant exchanges</span>
                              <span className="radio-list__hint">
                                The replacement ships as soon as the return is
                                approved, before the original comes back, so
                                customers get their exchanged items sooner.
                              </span>
                            </span>
                          </label>
                        </>
                      ) : undefined
                    }
                    afterFees={
                      o.key === "EXCHANGE" ? (
                        <>
                          <div className="pairing__divider" />
                          <label className="check-list__item">
                            <input
                              type="checkbox"
                              checked={editing.allowAdvancedExchange}
                              onChange={(e) => patch({ allowAdvancedExchange: e.target.checked })}
                            />
                            <span>
                              <span className="radio-list__label">Allow advanced exchanges</span>
                              <span className="radio-list__hint">
                                Offer new product exchange options based on
                                Shopify collections or tags.{" "}
                                <Link to={`${basePath}/settings/rules`}>Configure Advanced Exchanges</Link>
                              </span>
                            </span>
                          </label>

                          <div className="pairing__divider" />
                          <div className="field-label">Exchange Shipping Method</div>
                          <p className="settings-row__hint" style={{ marginBottom: 8 }}>
                            Assign a shipping method to your outbound exchange
                            orders placed in Shopify.
                          </p>
                          <input
                            type="text"
                            className="settings-input"
                            maxLength={120}
                            value={editing.exchangeShippingMethod ?? ""}
                            aria-label="Exchange shipping method"
                            onChange={(e) =>
                              patch({ exchangeShippingMethod: e.target.value })
                            }
                          />
                          <p className="settings-row__hint" style={{ marginTop: 8 }}>
                            Input one shipping method only. Must match a shipping
                            method in Shopify exactly. Leave empty to label the
                            line "Exchange shipping".
                          </p>

                          <div className="pairing__divider" />
                          <div className="field-label">Inventory locations</div>
                          <p className="settings-row__hint">
                            Manage the locations used for exchange inventory for
                            this return policy. Inventory from these locations
                            decides which products are available in the exchange
                            flow and Shop Now.
                          </p>
                          <p className="settings-row__hint" style={{ marginTop: 8 }}>
                            Changes here will only affect this return policy. To
                            set locations globally visit the{" "}
                            <Link to={pagePath("locations")}>locations</Link> page.
                          </p>
                          <div className="panel__head" style={{ marginTop: 14 }}>
                            <div>
                              <div className="settings-row__label">Locations</div>
                              <div className="settings-row__hint">
                                {editing.inventoryLocationIds.length === 0
                                  ? "Optional for a policy"
                                  : `${editing.inventoryLocationIds.length} selected`}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              disabled={locations.length === 0}
                              onClick={() => setChoosingPolicyLocations(true)}
                            >
                              Manage locations
                            </button>
                          </div>
                          {editing.inventoryLocationIds.length === 0 ? (
                            <div className="infobox">
                              <span className="infobox__icon" aria-hidden="true">
                                i
                              </span>
                              <div>
                                <strong>No locations have been selected</strong>
                                <div>
                                  Configuration at the return policy level is
                                  optional. If no locations are set, inventory from
                                  all globally configured locations is used. To
                                  enable, visit the locations page.
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="loc-list">
                              {editing.inventoryLocationIds.map((id) => (
                                <div key={id} className="loc-list__item">
                                  <span className="dest-row__icon" aria-hidden="true">
                                    ⌂
                                  </span>
                                  <span className="dest-row__name">{locationName(id)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </>
            )}

            {tab === "advanced" && (
              <>
                <div className="panel">
                  <div className="panel__head">
                    <div>
                      <h2 style={{ marginBottom: 0 }}>Bypass review</h2>
                      <p className="settings-row__hint">
                        Returns under this policy are approved the moment they're
                        submitted, without waiting for you to review them. Your
                        store's "auto-approve under" limit doesn't apply here.
                      </p>
                    </div>
                    <Switch
                      on={editing.bypassReview}
                      label="Bypass review"
                      onChange={(bypassReview) => patch({ bypassReview })}
                    />
                  </div>
                </div>

                <div className="panel">
                  <h2 style={{ marginBottom: 4 }}>Return instructions</h2>
                  <p className="settings-row__hint" style={{ marginBottom: 16 }}>
                    Guide your customer through the final steps of the return
                    process. Shown on their confirmation page once they've
                    submitted. Leave empty to keep the standard wording.
                  </p>
                  {editing.instructions.length > 0 && (
                    <div className="steps">
                      {editing.instructions.map((step, i) => (
                        <div key={i} className="steps__row">
                          <span className="steps__n">{i + 1}.</span>
                          <input
                            type="text"
                            className="settings-input"
                            maxLength={300}
                            value={step}
                            aria-label={`Step ${i + 1}`}
                            placeholder={
                              i === 0
                                ? "Securely pack items. If available, please use original packaging."
                                : "Attach your return label to the package."
                            }
                            onChange={(e) =>
                              patch({
                                instructions: editing.instructions.map((s, n) =>
                                  n === i ? e.target.value : s,
                                ),
                              })
                            }
                          />
                          <button
                            type="button"
                            className="steps__del"
                            aria-label={`Remove step ${i + 1}`}
                            onClick={() =>
                              patch({
                                instructions: editing.instructions.filter((_, n) => n !== i),
                              })
                            }
                          >
                            🗑
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    style={{ marginTop: editing.instructions.length > 0 ? 12 : 0 }}
                    disabled={editing.instructions.length >= 20}
                    onClick={() => patch({ instructions: [...editing.instructions, ""] })}
                  >
                    + Add step
                  </button>
                </div>

                {editing.id && (
                  <div className="panel">
                    <h2 style={{ marginBottom: 4 }}>Delete this policy</h2>
                    <p className="settings-row__hint" style={{ marginBottom: 12 }}>
                      Orders shipped to {editing.countries.length === 1 ? "its country" : "its countries"}{" "}
                      follow your store policy again. Returns already submitted keep
                      their totals.
                    </p>
                    <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove()}>
                      Delete policy
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {editing && choosingDestination && (
        <DestinationsModal
          destinations={destinations}
          selected={editing.destinationId}
          destinationsPath={pagePath("destinations")}
          onSelect={(destinationId) => patch({ destinationId })}
          onClose={() => setChoosingDestination(false)}
        />
      )}

      {editing && choosingPolicyLocations && (
        <LocationsModal
          locations={locations}
          selected={editing.inventoryLocationIds}
          onSave={(inventoryLocationIds) => {
            patch({ inventoryLocationIds });
            setChoosingPolicyLocations(false);
          }}
          onClose={() => setChoosingPolicyLocations(false)}
        />
      )}

      {/* The save bar, pinned like the other settings screens' — but always
          present while editing, as Loop's is, so Cancel and Save are never
          out of reach on a long form. */}
      {editing && blocker.state === "blocked" ? (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar settings-bar--warn" role="alertdialog">
            <span className="settings-bar__label">Leave without saving your changes?</span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => blocker.reset()}
            >
              Stay
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setEditing(null);
                blocker.proceed();
              }}
            >
              Discard and leave
            </button>
          </div>
        </>
      ) : editing ? (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar" role="status">
            <span className="settings-bar__label">
              {dirty ? "Unsaved changes" : editing.id ? editing.name : "New policy"}
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={close}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void save()}
              disabled={saving || (!dirty && editing.id !== null)}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
