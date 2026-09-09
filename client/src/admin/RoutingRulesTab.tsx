import { useEffect, useState } from "react";
import { useBlocker } from "react-router";
import { api } from "../lib/api";
import { countryName } from "../lib/countries";
import type {
  OutcomeKey,
  ReturnCostMode,
  ReturnMethodKind,
  RoutingConditions,
  RoutingMethod,
  RoutingRule,
  RoutingRulesResponse,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { CountryPicker, NumberField, Switch } from "./policy-controls";

/**
 * Return routing rules, laid out as AfterShip's are.
 *
 * A rule names the returns it applies to — by policy, country, product,
 * reason, outcome or value — and which ways of sending items back those
 * shoppers are offered, each with its own name, description, cost,
 * instructions and auto-approval. Rules are checked top to bottom; the
 * store's Default rule, which has no conditions, catches everything else.
 */

type Draft = Omit<RoutingRule, "id" | "sortOrder"> & { id: string | null };
type ConditionType = keyof RoutingConditions;

const KINDS: Array<{ kind: ReturnMethodKind; title: string; blurb: string }> = [
  {
    kind: "LABEL",
    title: "Ship with a return label",
    blurb: "Customers can ship back items with a label you provide.",
  },
  {
    kind: "CARRIER",
    title: "Ship with the carrier customers choose",
    blurb: "Allow customers to ship back items with any carrier of their choice.",
  },
  {
    kind: "STORE",
    title: "Return to a retail store",
    blurb: "Customers can return items to a physical store instead of shipping them back.",
  },
  {
    kind: "KEEP",
    title: "Green returns",
    blurb: "Allow customers to keep items they request a return for.",
  },
];

/** What each method says to shoppers until the merchant writes their own. */
const METHOD_DEFAULTS: Record<ReturnMethodKind, { name: string; description: string }> = {
  LABEL: {
    name: "Ship with a return label",
    description: "You'll get a return label after your request is approved.",
  },
  CARRIER: {
    name: "Ship with any carrier of your choice",
    description: "You'll get the shipping instructions after your request is approved.",
  },
  STORE: {
    name: "Return to a retail store",
    description: "Return items to our retail store near you.",
  },
  KEEP: {
    name: "Green returns",
    description: "You can keep the items without shipping them back.",
  },
};

const CONDITION_TYPES: Array<{ type: ConditionType; label: string }> = [
  { type: "policies", label: "Return policy" },
  { type: "countries", label: "Shipping country" },
  { type: "productTags", label: "Product tag" },
  { type: "productTypes", label: "Product type" },
  { type: "reasonIds", label: "Return reason" },
  { type: "resolutions", label: "Return outcome" },
  { type: "valueUnder", label: "Return value is under" },
  { type: "valueAtLeast", label: "Return value is at least" },
];

const RESOLUTIONS: Array<[OutcomeKey, string]> = [
  ["REFUND", "Refund"],
  ["EXCHANGE", "Exchange"],
  ["STORE_CREDIT", "Store credit"],
  ["GIFT_CARD", "Gift card"],
];

const COST_MODES: Array<[ReturnCostMode, string, string]> = [
  ["HIDDEN", "Do not display", "The cost will not be shown to customers."],
  ["FREE", "Free", "Shown to customers as free."],
  ["FIXED", "Fixed amount", "Shown to customers and deducted from what they get back."],
];

const blankMethod = (kind: ReturnMethodKind): RoutingMethod => ({
  enabled: false,
  name: METHOD_DEFAULTS[kind].name,
  description: METHOD_DEFAULTS[kind].description,
  costMode: "HIDDEN",
  costAmount: null,
  instructions: null,
  autoApprove: false,
  storeUrl: null,
});

const blankRule = (): Draft => ({
  id: null,
  name: "",
  isDefault: false,
  conditions: {},
  methods: {
    LABEL: blankMethod("LABEL"),
    CARRIER: blankMethod("CARRIER"),
    STORE: blankMethod("STORE"),
    KEEP: blankMethod("KEEP"),
  },
});

const formatMoney = (value: number, currency: string): string => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
};

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

const splitList = (raw: string): string[] => [
  ...new Set(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

/** A counted text field, as AfterShip's are: the length beside the box. */
function Counted({
  value,
  max,
  onChange,
  placeholder,
  multiline = false,
  label,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  label: string;
}) {
  return (
    <div className={`counted${multiline ? " counted--multi" : ""}`}>
      {multiline ? (
        <textarea
          className="settings-input settings-textarea"
          maxLength={max}
          value={value}
          rows={5}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="settings-input"
          maxLength={max}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <span className="counted__count">
        {value.length}/{max}
      </span>
    </div>
  );
}

export function RoutingRulesTab({
  subtabs,
}: {
  /** The tab bar shared with the other Return policies screens. */
  subtabs: React.ReactNode;
}) {
  const [data, setData] = useState<RoutingRulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [original, setOriginal] = useState("");
  /** Whether the condition builder is open; opened by "Set up conditions". */
  const [building, setBuilding] = useState(false);
  /** Comma-separated lists stay text while typed; see splitList. */
  const [texts, setTexts] = useState({ productTags: "", productTypes: "" });

  const load = () =>
    api
      .get<RoutingRulesResponse>("/admin/settings/routing-rules", { auth: "admin" })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const dirty = editing !== null && JSON.stringify(editing) !== original;
  const blocker = useBlocker(dirty);

  const open = (rule: Draft) => {
    setEditing(rule);
    setOriginal(JSON.stringify(rule));
    setBuilding(Object.keys(rule.conditions).length > 0);
    setTexts({
      productTags: (rule.conditions.productTags ?? []).join(", "),
      productTypes: (rule.conditions.productTypes ?? []).join(", "),
    });
    setStatus(null);
    setError(null);
    window.scrollTo({ top: 0 });
  };

  const close = () => {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setEditing(null);
  };

  const patch = (changes: Partial<Draft>) =>
    setEditing((prev) => (prev ? { ...prev, ...changes } : prev));

  const patchMethod = (kind: ReturnMethodKind, changes: Partial<RoutingMethod>) =>
    setEditing((prev) =>
      prev
        ? { ...prev, methods: { ...prev.methods, [kind]: { ...prev.methods[kind], ...changes } } }
        : prev,
    );

  const setCondition = <K extends ConditionType>(type: K, value: RoutingConditions[K] | undefined) =>
    setEditing((prev) => {
      if (!prev) return prev;
      const conditions = { ...prev.conditions };
      if (value === undefined) delete conditions[type];
      else conditions[type] = value;
      return { ...prev, conditions };
    });

  /** The conditions as they'll be saved: typed lists parsed, empties dropped. */
  const cleanConditions = (draft: Draft): RoutingConditions => {
    const c: RoutingConditions = { ...draft.conditions };
    if ("productTags" in c) c.productTags = splitList(texts.productTags);
    if ("productTypes" in c) c.productTypes = splitList(texts.productTypes);
    for (const key of Object.keys(c) as ConditionType[]) {
      const v = c[key];
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete c[key];
    }
    return c;
  };

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name.trim()) return setError("Give the rule a name.");
    const enabled = KINDS.filter((k) => editing.methods[k.kind].enabled);
    if (enabled.length === 0) return setError("Turn on at least one return method.");
    for (const k of enabled) {
      const m = editing.methods[k.kind];
      if (!m.name.trim()) return setError(`${k.title}: give the method a name.`);
      if (m.costMode === "FIXED" && (m.costAmount === null || m.costAmount < 0)) {
        return setError(`${k.title}: enter the cost of return.`);
      }
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: editing.name.trim(),
        conditions: editing.isDefault ? {} : cleanConditions(editing),
        methods: Object.fromEntries(
          KINDS.map((k) => {
            const m = editing.methods[k.kind];
            return [
              k.kind,
              {
                ...m,
                name: m.name.trim(),
                description: m.description?.trim() || null,
                instructions: m.instructions?.trim() || null,
                storeUrl: k.kind === "STORE" ? m.storeUrl?.trim() || null : null,
                costAmount: m.costMode === "FIXED" ? m.costAmount : null,
              },
            ];
          }),
        ),
      };
      if (editing.id) {
        await api.patch(`/admin/settings/routing-rules/${editing.id}`, body, { auth: "admin" });
      } else {
        await api.post("/admin/settings/routing-rules", body, { auth: "admin" });
      }
      await load();
      setEditing(null);
      setStatus(`Saved "${body.name}".`);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that rule.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing?.id || editing.isDefault) return;
    if (!window.confirm(`Delete "${editing.name}"? Returns it matched will follow the next rule.`)) {
      return;
    }
    setError(null);
    try {
      await api.delete(`/admin/settings/routing-rules/${editing.id}`, { auth: "admin" });
      await load();
      setEditing(null);
      setStatus("Rule deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that rule.");
    }
  };

  /** Priority is the whole list's order; the default stays put at the bottom. */
  const move = async (index: number, delta: number) => {
    if (!data) return;
    const ordered = data.rules.filter((r) => !r.isDefault);
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setData({ ...data, rules: [...ordered, ...data.rules.filter((r) => r.isDefault)] });
    await api
      .post(
        "/admin/settings/routing-rules/reorder",
        { ids: ordered.map((r) => r.id) },
        { auth: "admin" },
      )
      .catch((e) => setError(e instanceof Error ? e.message : null));
  };

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Routing rules</h1>
        <ErrorAlert message={error ?? "Couldn't load your routing rules."} />
      </>
    );
  }

  const { rules, policies, reasons, currency } = data;
  const policyName = (id: string) =>
    id === "DEFAULT" ? "Store default policy" : (policies.find((p) => p.id === id)?.name ?? "a deleted policy");
  const reasonLabel = (id: string) => reasons.find((r) => r.id === id)?.label ?? "a deleted reason";

  /** "Country: France, Italy · Outcome: Refund" — the list's one-line summary. */
  const describeConditions = (c: RoutingConditions): string => {
    const parts: string[] = [];
    if (c.policies?.length) parts.push(`Policy: ${c.policies.map(policyName).join(", ")}`);
    if (c.countries?.length) parts.push(`Country: ${c.countries.map(countryName).join(", ")}`);
    if (c.productTags?.length) parts.push(`Tags: ${c.productTags.join(", ")}`);
    if (c.productTypes?.length) parts.push(`Types: ${c.productTypes.join(", ")}`);
    if (c.reasonIds?.length) parts.push(`Reason: ${c.reasonIds.map(reasonLabel).join(", ")}`);
    if (c.resolutions?.length) {
      parts.push(
        `Outcome: ${c.resolutions.map((r) => RESOLUTIONS.find(([k]) => k === r)?.[1] ?? r).join(", ")}`,
      );
    }
    if (c.valueUnder !== undefined) parts.push(`Value under ${formatMoney(c.valueUnder, currency)}`);
    if (c.valueAtLeast !== undefined) parts.push(`Value at least ${formatMoney(c.valueAtLeast, currency)}`);
    return parts.length ? parts.join(" · ") : "Every return";
  };

  const describeMethods = (rule: RoutingRule): string => {
    const on = KINDS.filter((k) => rule.methods[k.kind].enabled).map((k) => rule.methods[k.kind].name);
    return on.length ? on.join(" · ") : "No return method on";
  };

  const ordered = rules.filter((r) => !r.isDefault);
  const defaultRule = rules.find((r) => r.isDefault) ?? null;

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------
  if (!editing) {
    return (
      <>
        <div className="admin__header">
          <div>
            <div className="admin__eyebrow">Settings</div>
            <h1>Routing rules</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Decide which ways of sending items back are offered, by
              conditions on the return.
            </p>
          </div>
          <button className="btn btn--sm" onClick={() => open(blankRule())}>
            Add routing rule
          </button>
        </div>
        {subtabs}
        <ErrorAlert message={error} />
        {status && <div className="alert alert--info">{status}</div>}

        <div className="split">
          <div>
            <h3 className="split__title">Return routing rules</h3>
            <p className="split__blurb">
              Rules are checked from the top; the first whose conditions all
              match decides what a customer is offered on the review step.
              The Default rule has no conditions and catches every return
              the others don't.
            </p>
            <p className="split__blurb">
              Each way of returning has its own name and description,
              cost, instructions and auto-approval.
            </p>
          </div>

          <div className="panel">
            {[...ordered, ...(defaultRule ? [defaultRule] : [])].map((rule, index) => (
              <div key={rule.id} className="rrule">
                <div className="rrule__body">
                  <div className="settings-row__label">
                    {rule.name}
                    {rule.isDefault && <span className="pcard__badge dest-row__badge">Default</span>}
                  </div>
                  <div className="settings-row__hint">
                    {rule.isDefault ? "Every return no other rule matches" : describeConditions(rule.conditions)}
                  </div>
                  <div className="settings-row__hint rrule__methods">{describeMethods(rule)}</div>
                </div>
                <div className="rule-row__actions">
                  {!rule.isDefault && (
                    <>
                      <button
                        className="btn btn--secondary btn--sm"
                        disabled={index === 0}
                        onClick={() => void move(index, -1)}
                        aria-label="Move up"
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn--secondary btn--sm"
                        disabled={index === ordered.length - 1}
                        onClick={() => void move(index, 1)}
                        aria-label="Move down"
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <button className="btn btn--secondary btn--sm" onClick={() => open({ ...rule })}>
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------
  const conditionTypes = Object.keys(editing.conditions) as ConditionType[];
  const available = CONDITION_TYPES.filter((c) => !conditionTypes.includes(c.type));

  const conditionEditor = (type: ConditionType) => {
    const c = editing.conditions;
    switch (type) {
      case "policies": {
        const chosen = c.policies ?? [];
        const toggle = (id: string) =>
          setCondition(
            "policies",
            chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
          );
        return (
          <div className="check-list">
            {[{ id: "DEFAULT", name: "Store default policy" }, ...policies].map((p) => (
              <label key={p.id} className="check-list__item">
                <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
                <span className="radio-list__label">{p.name}</span>
              </label>
            ))}
          </div>
        );
      }
      case "countries":
        return (
          <CountryPicker
            selected={c.countries ?? []}
            onChange={(countries) => setCondition("countries", countries)}
            emptyHint="Add the countries this rule applies to."
          />
        );
      case "productTags":
      case "productTypes":
        return (
          <>
            <input
              type="text"
              className="settings-input"
              value={texts[type]}
              placeholder={type === "productTags" ? "fragile, oversized" : "Furniture, Shoes"}
              aria-label={type === "productTags" ? "Product tags" : "Product types"}
              onChange={(e) => setTexts({ ...texts, [type]: e.target.value })}
            />
            <p className="settings-row__hint" style={{ marginTop: 6 }}>
              Separate with commas. The rule applies when any returned item
              matches, as the product was when the order was placed.
            </p>
          </>
        );
      case "reasonIds": {
        const chosen = c.reasonIds ?? [];
        const toggle = (id: string) =>
          setCondition(
            "reasonIds",
            chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
          );
        return reasons.length === 0 ? (
          <p className="settings-row__hint">No return reasons yet.</p>
        ) : (
          <div className="collection-picker">
            {reasons.map((r) => (
              <label key={r.id} className="collection-picker__item">
                <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} />
                {r.label}
              </label>
            ))}
          </div>
        );
      }
      case "resolutions": {
        const chosen = c.resolutions ?? [];
        const toggle = (key: OutcomeKey) =>
          setCondition(
            "resolutions",
            chosen.includes(key) ? chosen.filter((x) => x !== key) : [...chosen, key],
          );
        return (
          <div className="check-list">
            {RESOLUTIONS.map(([key, label]) => (
              <label key={key} className="check-list__item">
                <input type="checkbox" checked={chosen.includes(key)} onChange={() => toggle(key)} />
                <span className="radio-list__label">{label}</span>
              </label>
            ))}
          </div>
        );
      }
      case "valueUnder":
      case "valueAtLeast":
        return (
          <NumberField
            value={c[type] ?? 0}
            min={0}
            step="0.01"
            unit={currencySymbol(currency)}
            unitFirst
            onChange={(value) => setCondition(type, value)}
          />
        );
      default:
        return null;
    }
  };

  const startCondition = (type: ConditionType) => {
    switch (type) {
      case "valueUnder":
      case "valueAtLeast":
        return setCondition(type, 0);
      default:
        return setCondition(type, [] as never);
    }
  };

  return (
    <>
      <div className="admin__header">
        <div>
          <button type="button" className="link-btn peditor__back" onClick={close}>
            ‹ Routing rules
          </button>
          <h1>{editing.id ? "Edit routing rule" : "Add routing rule"}</h1>
        </div>
      </div>

      <ErrorAlert message={error} />

      <div className="settings-form rform">
        <div className="panel">
          <h2>Rule name</h2>
          <Counted
            value={editing.name}
            max={200}
            label="Rule name"
            onChange={(name) => patch({ name })}
          />
          <p className="settings-row__hint" style={{ marginTop: 8 }}>
            For your reference only. Not shown to customers.
          </p>
        </div>

        <div className="panel">
          <h2>Conditions</h2>
          {editing.isDefault ? (
            <p className="settings-row__hint">
              The Default rule has no conditions: it applies to every return
              that no other rule matches.
            </p>
          ) : !building ? (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setBuilding(true)}>
              Set up conditions
            </button>
          ) : (
            <>
              <p className="settings-row__hint" style={{ marginBottom: 14 }}>
                Every condition must match for the rule to apply. With none,
                the rule applies to every return.
              </p>
              {conditionTypes.map((type) => (
                <div key={type} className="cond">
                  <div className="cond__head">
                    <span className="cond__label">
                      {CONDITION_TYPES.find((c) => c.type === type)?.label}
                      {["policies", "countries", "productTags", "productTypes", "reasonIds", "resolutions"].includes(type) && (
                        <span className="muted"> is any of</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="cchip__x"
                      aria-label="Remove condition"
                      onClick={() => setCondition(type, undefined)}
                    >
                      ×
                    </button>
                  </div>
                  {conditionEditor(type)}
                </div>
              ))}
              {available.length > 0 && (
                <select
                  className="cond__add"
                  value=""
                  aria-label="Add condition"
                  onChange={(e) => {
                    if (e.target.value) startCondition(e.target.value as ConditionType);
                  }}
                >
                  <option value="">+ Add condition</option>
                  {available.map((c) => (
                    <option key={c.type} value={c.type}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>

        <div className="rform__section">
          <h2>Return shipping methods</h2>
          <p className="settings-row__hint">
            Offer one or multiple options for customers to return items.
          </p>
        </div>

        {KINDS.map(({ kind, title, blurb }) => {
          const m = editing.methods[kind];
          const modeHint = COST_MODES.find(([mode]) => mode === m.costMode)?.[2];
          return (
            <div key={kind} className="panel">
              <div className="panel__head">
                <div>
                  <h2 style={{ marginBottom: 0 }}>{title}</h2>
                  <p className="settings-row__hint">{blurb}</p>
                </div>
                <Switch on={m.enabled} label={title} onChange={(enabled) => patchMethod(kind, { enabled })} />
              </div>

              {m.enabled && (
                <>
                  <div className="pairing__divider" />
                  <div className="field-label" style={{ marginBottom: 2 }}>
                    Display to customers
                  </div>
                  <p className="settings-row__hint" style={{ marginBottom: 14 }}>
                    Customize what your customers will see when requesting a return.
                  </p>
                  <div className="rform__field">
                    <div className="rform__label">Name</div>
                    <Counted
                      value={m.name}
                      max={200}
                      label={`${title} name`}
                      onChange={(name) => patchMethod(kind, { name })}
                    />
                  </div>
                  <div className="rform__field">
                    <div className="rform__label">Description</div>
                    <Counted
                      value={m.description ?? ""}
                      max={200}
                      label={`${title} description`}
                      onChange={(description) => patchMethod(kind, { description })}
                    />
                  </div>

                  {kind === "LABEL" && (
                    <>
                      <div className="pairing__divider" />
                      <div className="field-label">Prepaid return labels</div>
                      <p className="settings-row__hint">
                        Automatic label generation isn't set up yet, so you'll
                        send the label yourself once the return is approved.
                        The instructions below tell the customer what to expect.
                      </p>
                    </>
                  )}

                  <div className="pairing__divider" />
                  <div className="field-label" style={{ marginBottom: 2 }}>
                    Cost of return
                  </div>
                  <p className="settings-row__hint" style={{ marginBottom: 10 }}>
                    Set the shipping and handling fee of this return method
                  </p>
                  <div className="window-fields">
                    <select
                      value={m.costMode}
                      aria-label={`${title} cost of return`}
                      onChange={(e) =>
                        patchMethod(kind, {
                          costMode: e.target.value as ReturnCostMode,
                          costAmount: e.target.value === "FIXED" ? (m.costAmount ?? 0) : m.costAmount,
                        })
                      }
                    >
                      {COST_MODES.map(([mode, label]) => (
                        <option key={mode} value={mode}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {m.costMode === "FIXED" && (
                      <NumberField
                        value={m.costAmount ?? 0}
                        min={0}
                        step="0.01"
                        unit={currencySymbol(currency)}
                        unitFirst
                        onChange={(costAmount) => patchMethod(kind, { costAmount })}
                      />
                    )}
                  </div>
                  <p className="settings-row__hint" style={{ marginTop: 8 }}>
                    {modeHint}
                  </p>

                  <div className="pairing__divider" />
                  <div className="field-label">Return instructions</div>
                  <Counted
                    value={m.instructions ?? ""}
                    max={2000}
                    multiline
                    label={`${title} instructions`}
                    placeholder={"1. Pack the items you're returning.\n2. …"}
                    onChange={(instructions) => patchMethod(kind, { instructions })}
                  />
                  <p className="settings-row__hint" style={{ marginTop: 8 }}>
                    These will be shown on the returns page and in the "return
                    request approved" emails.
                  </p>

                  {kind === "STORE" && (
                    <>
                      <div className="pairing__divider" />
                      <div className="field-label">Retail store location</div>
                      <input
                        type="text"
                        className="settings-input"
                        value={m.storeUrl ?? ""}
                        placeholder="https://"
                        aria-label="Retail store location"
                        onChange={(e) => patchMethod(kind, { storeUrl: e.target.value })}
                      />
                      <p className="settings-row__hint" style={{ marginTop: 8 }}>
                        Enter a valid URL. This will be shown to customers on the returns page.
                      </p>
                    </>
                  )}

                  <div className="pairing__divider" />
                  <div className="field-label">Auto-approval</div>
                  <label className="check-list__item">
                    <input
                      type="checkbox"
                      checked={m.autoApprove}
                      onChange={(e) => patchMethod(kind, { autoApprove: e.target.checked })}
                    />
                    <span>
                      <span className="radio-list__label">
                        Automatically approve a return request for this return method
                      </span>
                      <span className="radio-list__hint">
                        The return is approved the moment it's submitted, and
                        the customer gets the approval email with these
                        instructions straight away.
                      </span>
                    </span>
                  </label>
                </>
              )}
            </div>
          );
        })}

        {editing.id && !editing.isDefault && (
          <div className="panel">
            <h2 style={{ marginBottom: 4 }}>Delete this rule</h2>
            <p className="settings-row__hint" style={{ marginBottom: 12 }}>
              Returns it would have matched follow the next rule instead.
            </p>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove()}>
              Delete rule
            </button>
          </div>
        )}
      </div>

      {blocker.state === "blocked" ? (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar settings-bar--warn" role="alertdialog">
            <span className="settings-bar__label">Leave without saving your changes?</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => blocker.reset()}>
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
      ) : (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar" role="status">
            <span className="settings-bar__label">
              {dirty ? "Unsaved changes" : editing.id ? editing.name : "New rule"}
            </span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={close} disabled={saving}>
              {editing.id && !dirty ? "Back" : "Discard"}
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
      )}
    </>
  );
}
