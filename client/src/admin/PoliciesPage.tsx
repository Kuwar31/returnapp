import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker } from "react-router";
import { api } from "../lib/api";
import { countryName, flagOf, searchCountries } from "../lib/countries";
import type {
  OutcomeKey,
  RegionalOutcome,
  RegionalPoliciesResponse,
  RegionalPolicy,
  ShopLocation,
  StorePolicySummary,
  WindowStart,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { useAuth } from "./AuthContext";
import { storePath } from "./store-path";

/**
 * Return policies by region, the way Loop lays them out.
 *
 * The store policy (Settings → Return policy) stays the source of every
 * mechanic. A policy here claims a set of countries and decides, for orders
 * shipped to them, only what a region is allowed to: which outcomes are on,
 * how long each stays open, what each costs, when the clock starts, whether
 * review is skipped, and where the parcel goes back to. The "Default" card is
 * the store policy itself, shown so the merchant can see the whole picture
 * in one place.
 */

type Draft = Omit<RegionalPolicy, "id" | "sortOrder"> & { id: string | null };
type Tab = "zone" | "outcomes" | "advanced";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "zone", label: "Policy name & zone", icon: "◎" },
  { id: "outcomes", label: "Return outcomes", icon: "▣" },
  { id: "advanced", label: "Advanced settings", icon: "⚙" },
];

const OUTCOMES: Array<{ key: OutcomeKey; title: string; blurb: string }> = [
  {
    key: "REFUND",
    title: "Refund",
    blurb: "Allow customers to receive a refund on the original order.",
  },
  {
    key: "EXCHANGE",
    title: "Exchange",
    blurb: "Allow customers to exchange an item for a new variant.",
  },
  {
    key: "STORE_CREDIT",
    title: "Store credit",
    blurb: "Allow customers to receive store credit to spend with you.",
  },
  {
    key: "GIFT_CARD",
    title: "Gift card",
    blurb: "Allow customers to receive a Shopify gift card.",
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
  destinationLocationId: null,
  windowStartsFrom: base?.windowStartsFrom ?? "DELIVERY",
  bypassReview: base?.autoApprove ?? false,
  instructions: [],
  outcomes: outcomesFrom(base),
});

const formatMoney = (value: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
};

/** "30 days, 5% handling fee" — one line per outcome on a card. */
const describeOutcome = (o: RegionalOutcome, currency: string): string => {
  if (!o.enabled) return "Disabled";
  const window = o.windowDays === null ? "Unlimited" : `${o.windowDays} days`;
  if (!o.fee || o.fee.value <= 0) return window;
  const fee =
    o.fee.type === "PERCENT"
      ? `${o.fee.value}%`
      : formatMoney(o.fee.value, currency);
  return `${window}, ${fee} handling fee`;
};

function Switch({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch__knob" />
    </button>
  );
}

/**
 * A number that stays text while it's typed.
 *
 * Bound straight to a number, clearing the field to type a new value would
 * snap it back to something and eat the keystrokes. The parent only hears
 * about values that parse and clear the floor; on blur the field settles
 * back to whatever the parent holds.
 */
function NumberField({
  value,
  min,
  max,
  step,
  unit,
  unitFirst = false,
  onChange,
}: {
  value: number;
  min: number;
  max?: number;
  step?: string;
  unit: string;
  unitFirst?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // Only when the parent's value moves, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const unitEl = (
    <span className={`unit-field__unit${unitFirst ? " unit-field__unit--lead" : ""}`}>
      {unit}
    </span>
  );
  return (
    <span className="unit-field">
      {unitFirst && unitEl}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min) {
            onChange(max !== undefined && n > max ? max : n);
          }
        }}
        onBlur={() => setText(String(value))}
      />
      {!unitFirst && unitEl}
    </span>
  );
}

/** Search-and-add, with the chosen countries as chips beneath. */
function CountryPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (codes: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchCountries(query, selected), [query, selected]);

  const add = (code: string) => {
    onChange([...selected, code]);
    setQuery("");
  };

  return (
    <div className="cpick">
      <div className="cpick__search">
        <div className="search">
          <span className="search__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="text"
            value={query}
            placeholder="Search countries"
            aria-label="Search countries"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault();
                add(matches[0].code);
              }
              if (e.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <button
              type="button"
              className="search__clear"
              aria-label="Clear"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
        {query.trim() !== "" && (
          <div className="cpick__menu" role="listbox">
            {matches.length === 0 ? (
              <div className="cpick__empty">No country matches "{query}".</div>
            ) : (
              matches.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="cpick__option"
                  onClick={() => add(c.code)}
                >
                  <span aria-hidden="true">{c.flag}</span>
                  {c.name}
                  <span className="cpick__code">{c.code}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {selected.length > 0 ? (
        <div className="chips">
          {selected.map((code) => (
            <span key={code} className="chip cchip">
              <span aria-hidden="true">{flagOf(code)}</span>
              {countryName(code)}
              <button
                type="button"
                className="cchip__x"
                aria-label={`Remove ${countryName(code)}`}
                onClick={() => onChange(selected.filter((c) => c !== code))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="settings-row__hint" style={{ marginTop: 10 }}>
          Add every country this policy covers. An order shipped to any of them
          follows this policy instead of your store policy.
        </p>
      )}
    </div>
  );
}

/** The store's locations, one of which the region's returns go back to. */
function DestinationsModal({
  locations,
  selected,
  onSelect,
  onClose,
}: {
  locations: ShopLocation[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
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
        aria-labelledby="dest-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="dest-title">Manage destinations</h2>
          <button
            type="button"
            className="modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="modal__body">
          {locations.length === 0 ? (
            <p className="muted" style={{ padding: "12px 0" }}>
              Connect your Shopify store to choose a destination. Its locations
              will appear here.
            </p>
          ) : (
            locations.map((l) => (
              <label key={l.id} className="dest-row">
                <input
                  type="checkbox"
                  checked={selected === l.id}
                  onChange={() => onSelect(selected === l.id ? null : l.id)}
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
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** One outcome: the switch, then its window and fee once it's on. */
function OutcomePanel({
  title,
  blurb,
  value,
  currency,
  onChange,
}: {
  title: string;
  blurb: string;
  value: RegionalOutcome;
  currency: string;
  onChange: (value: RegionalOutcome) => void;
}) {
  const set = (patch: Partial<RegionalOutcome>) => onChange({ ...value, ...patch });
  const fee = value.fee;

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

          <div className="pairing__divider" />
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={fee !== null}
              onChange={(e) =>
                set({ fee: e.target.checked ? { type: "PERCENT", value: 0 } : null })
              }
            />
            <span>
              <span className="radio-list__label">Handling fees</span>
              <span className="radio-list__hint">
                Charge a handling fee for returns with this outcome. It's
                deducted from what the customer gets back.
              </span>
            </span>
          </label>

          {fee && (
            <div className="fee">
              <div className="radio-list">
                <label className="radio-list__item">
                  <input
                    type="radio"
                    name={`fee-${title}`}
                    checked={fee.type === "FLAT"}
                    onChange={() => set({ fee: { ...fee, type: "FLAT" } })}
                  />
                  <span>
                    <span className="radio-list__label">Flat rate</span>
                    <span className="radio-list__hint">
                      Charge a handling fee as a fixed amount, once per return.
                    </span>
                  </span>
                </label>
                <label className="radio-list__item">
                  <input
                    type="radio"
                    name={`fee-${title}`}
                    checked={fee.type === "PERCENT"}
                    onChange={() =>
                      set({ fee: { type: "PERCENT", value: Math.min(fee.value, 100) } })
                    }
                  />
                  <span>
                    <span className="radio-list__label">Percentage of return value</span>
                    <span className="radio-list__hint">
                      Charge a dynamic handling fee based on the value of the
                      items being returned.
                    </span>
                  </span>
                </label>
              </div>

              <div className="pairing__divider" />
              <div className="field-label">Handling fee</div>
              <NumberField
                value={fee.value}
                min={0}
                max={fee.type === "PERCENT" ? 100 : undefined}
                step="0.01"
                unit={fee.type === "PERCENT" ? "%" : currency}
                unitFirst={fee.type === "FLAT"}
                onChange={(amount) => set({ fee: { ...fee, value: amount } })}
              />
            </div>
          )}
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

export default function PoliciesPage() {
  const { session } = useAuth();
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
        destinationLocationId: editing.destinationLocationId,
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

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Return policies</h1>
        <ErrorAlert message={error ?? "Couldn't load your policies."} />
      </>
    );
  }

  const { policies, base, locations, defaultLocationId, currency } = data;
  const basePath = storePath(session!.merchant.slug);
  const locationName = (id: string | null) =>
    id ? (locations.find((l) => l.id === id)?.name ?? "A location no longer in your store") : null;

  const cardRows = (
    outcomes: Record<OutcomeKey, RegionalOutcome>,
    bypassReview: boolean,
  ): Array<[string, string]> => [
    ...OUTCOMES.filter(
      (o) => o.key !== "GIFT_CARD" || outcomes[o.key].enabled,
    ).map((o): [string, string] => [o.title, describeOutcome(outcomes[o.key], currency)]),
    ...(bypassReview ? [["Review", "Skipped — approved on submission"] as [string, string]] : []),
  ];

  const destination = editing ? locationName(editing.destinationLocationId) : null;
  const destinationAddress = editing?.destinationLocationId
    ? locations.find((l) => l.id === editing.destinationLocationId)?.address ?? null
    : null;

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
                to={locationName(defaultLocationId) ?? "Where each order shipped from"}
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
                to={
                  locationName(policy.destinationLocationId) ??
                  (locationName(defaultLocationId) ?? "Where each order shipped from")
                }
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
              is skipped, and where returns are sent. Product tag rules, bonus
              credit, exchange settings and everything else are shared, from
              your store policy.
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
                  {destination ? (
                    <div className="dest" style={{ marginTop: 14 }}>
                      <span className="dest-row__icon" aria-hidden="true">
                        ⌂
                      </span>
                      <div>
                        <div className="dest__name">{destination}</div>
                        <div className="muted">
                          {destinationAddress ?? "No address on file in Shopify"}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 14 }}>
                      <div className="settings-row__label">No destination selected</div>
                      <div className="settings-row__hint">
                        Select a destination for this return policy. Returns are
                        restocked there and customers are shown its address.
                        Without one, your store's default location applies.
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
                    Choose when the shopper's return window starts for all
                    return outcomes below.
                  </p>
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
                  {editing.windowStartsFrom === "DELIVERY" && (
                    <p className="settings-row__hint" style={{ marginTop: 10 }}>
                      Counted from the shipment if the carrier never confirms
                      delivery.
                    </p>
                  )}
                </div>

                {OUTCOMES.map((o) => (
                  <OutcomePanel
                    key={o.key}
                    title={o.title}
                    blurb={o.blurb}
                    value={editing.outcomes[o.key]}
                    currency={currency}
                    onChange={(value) =>
                      patch({ outcomes: { ...editing.outcomes, [o.key]: value } })
                    }
                  />
                ))}

                {base?.allowInstantExchange && (
                  <p className="settings-row__hint">
                    Instant exchanges follow the Exchange outcome above.
                  </p>
                )}
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
          locations={locations}
          selected={editing.destinationLocationId}
          onSelect={(destinationLocationId) => patch({ destinationLocationId })}
          onClose={() => setChoosingDestination(false)}
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
