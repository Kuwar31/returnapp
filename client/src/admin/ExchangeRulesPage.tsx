import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BonusType, ExchangeCollection } from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";

/**
 * Advanced exchanges: what a returned item may be swapped into.
 *
 * Without a rule an exchange offers the whole catalogue. A rule names the items
 * it covers — by product tag, or by a fragment of the title — and lists what
 * they may become, each list backed by a collection. Every rule that matches an
 * item contributes its options; the order here is the order the customer sees
 * them in.
 */

type MatchBy = "PRODUCT_TAG" | "PRODUCT_NAME";

interface RuleOption {
  id?: string;
  label: string;
  collectionId: string;
  collectionTitle: string;
}

interface Rule {
  id: string;
  name: string;
  active: boolean;
  matchBy: MatchBy;
  matchValues: string[];
  showProductTitles: boolean;
  /** Null means this rule doesn't override the store-wide exchange bonus. */
  bonusType: BonusType | null;
  bonusValue: number | null;
  options: RuleOption[];
}

/** A rule that has never been saved, so the editor has something to open on. */
const blankRule = (): Rule => ({
  id: "",
  name: "",
  active: true,
  matchBy: "PRODUCT_TAG",
  matchValues: [],
  showProductTitles: false,
  bonusType: "PERCENT",
  bonusValue: null,
  options: [],
});

export default function ExchangeRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [collections, setCollections] = useState<ExchangeCollection[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Tags are typed as text and split on save; see the hint under the field. */
  const [valuesText, setValuesText] = useState("");
  /** Text while it's being typed; "1." on the way to "1.5" must survive. */
  const [bonusText, setBonusText] = useState("");

  const load = () =>
    api
      .get<{ rules: Rule[]; collections: ExchangeCollection[] }>(
        "/admin/settings/exchange-rules",
        { auth: "admin" },
      )
      .then((r) => {
        setRules(r.rules);
        setCollections(r.collections);
      })
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const open = (rule: Rule) => {
    setEditing(rule);
    setValuesText(rule.matchValues.join(", "));
    setBonusText(rule.bonusValue === null ? "" : String(rule.bonusValue));
    setStatus(null);
    setError(null);
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: editing.name.trim(),
        active: editing.active,
        matchBy: editing.matchBy,
        matchValues: valuesText
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        showProductTitles: editing.showProductTitles,
        bonusType: editing.bonusType ?? "PERCENT",
        bonusValue: bonusText.trim() === "" ? null : Number(bonusText),
        options: editing.options.map((o) => ({
          label: o.label.trim(),
          collectionId: o.collectionId,
          collectionTitle: o.collectionTitle,
        })),
      };
      if (editing.id) {
        await api.patch(`/admin/settings/exchange-rules/${editing.id}`, body, {
          auth: "admin",
        });
      } else {
        await api.post("/admin/settings/exchange-rules", body, {
          auth: "admin",
        });
      }
      await load();
      setEditing(null);
      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that rule.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: Rule) => {
    setError(null);
    try {
      await api.delete(`/admin/settings/exchange-rules/${rule.id}`, {
        auth: "admin",
      });
      await load();
      setEditing(null);
      setStatus("Rule deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that rule.");
    }
  };

  /** Order is only meaningful across the whole set, so it moves one at a time. */
  const move = async (index: number, delta: number) => {
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRules(next);
    await api
      .post(
        "/admin/settings/exchange-rules/reorder",
        { ids: next.map((r) => r.id) },
        { auth: "admin" },
      )
      .catch((e) => setError(e instanceof Error ? e.message : null));
  };

  const setOption = (index: number, patch: Partial<RuleOption>) =>
    setEditing((prev) =>
      prev
        ? {
            ...prev,
            options: prev.options.map((o, i) =>
              i === index ? { ...o, ...patch } : o,
            ),
          }
        : prev,
    );

  if (loading) return <Loading />;

  return (
    <>
      <div className="admin__header">
        <div>
          <h1>Advanced exchanges</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Decide what a returned item can be exchanged for. Without a rule,
            customers can exchange into anything in your catalogue. Every rule
            that matches an item contributes its options, in the order below.
          </p>
        </div>
        {!editing && (
          <button className="btn btn--sm" onClick={() => open(blankRule())}>
            New rule
          </button>
        )}
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      {!editing && (
        <div className="settings-form">
          {rules.length === 0 ? (
            <div className="panel">
              <p className="muted">
                No rules yet. Every exchange offers the whole catalogue.
              </p>
            </div>
          ) : (
            rules.map((rule, index) => (
              <div key={rule.id} className="panel rule-row">
                <div className="rule-row__body">
                  <div className="settings-row__label">
                    {rule.name}
                    {!rule.active && (
                      <span className="chip" style={{ marginLeft: 8 }}>
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="settings-row__hint">
                    {rule.matchBy === "PRODUCT_TAG"
                      ? "Tags: "
                      : "Title contains: "}
                    {rule.matchValues.join(", ") || "—"} ·{" "}
                    {rule.options.length} option
                    {rule.options.length === 1 ? "" : "s"}
                    {rule.bonusValue !== null &&
                      ` · ${rule.bonusValue}${rule.bonusType === "PERCENT" ? "%" : ""} bonus`}
                  </div>
                </div>
                <div className="rule-row__actions">
                  {/* Every matching rule applies, so this orders the cards the
                      customer sees rather than deciding which rule wins. */}
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
                    disabled={index === rules.length - 1}
                    onClick={() => void move(index, 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => open(rule)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {editing && (
        <div className="settings-form">
          <div className="panel">
            <h2>{editing.id ? "Edit rule" : "New rule"}</h2>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Name</div>
                <div className="settings-row__hint">
                  For your own reference; customers never see it.
                </div>
              </div>
              <input
                type="text"
                style={{ width: 240 }}
                value={editing.name}
                placeholder="e.g. footwear"
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Which items</div>
                <div className="settings-row__hint">
                  How this rule recognises the item being returned. Tags are
                  read from the order as it was placed, so retagging a product
                  later won't change an existing order's options.
                </div>
              </div>
              <select
                value={editing.matchBy}
                onChange={(e) =>
                  setEditing({ ...editing, matchBy: e.target.value as MatchBy })
                }
              >
                <option value="PRODUCT_TAG">By product tag</option>
                <option value="PRODUCT_NAME">By product name</option>
              </select>
            </div>

            <div className="settings-row settings-row--stacked">
              <div>
                <div className="settings-row__label">
                  {editing.matchBy === "PRODUCT_TAG"
                    ? "Product tags"
                    : "Words in the product name"}
                </div>
                <div className="settings-row__hint">
                  Separate with commas. An item matches if it has any one of
                  them.
                </div>
              </div>
              <input
                type="text"
                value={valuesText}
                placeholder="department:footwear, brand:alohas"
                onChange={(e) => setValuesText(e.target.value)}
              />
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Credit bonus</div>
                <div className="settings-row__hint">
                  Extra credit for exchanging an item this rule matches,
                  overriding the store-wide exchange bonus. Leave empty to use
                  that instead. Where several rules match, the first one with a
                  bonus applies.
                </div>
              </div>
              <div className="bonus-field">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={bonusText}
                  placeholder="Store default"
                  onChange={(e) => setBonusText(e.target.value)}
                />
                <select
                  value={editing.bonusType ?? "PERCENT"}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      bonusType: e.target.value as BonusType,
                    })
                  }
                >
                  <option value="PERCENT">%</option>
                  <option value="FIXED">flat</option>
                </select>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Show product titles</div>
                <div className="settings-row__hint">
                  Whether names appear under the pictures on the customer's
                  choice screen.
                </div>
              </div>
              <input
                type="checkbox"
                checked={editing.showProductTitles}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    showProductTitles: e.target.checked,
                  })
                }
              />
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Active</div>
                <div className="settings-row__hint">
                  A disabled rule contributes nothing; any other matching rules
                  still do.
                </div>
              </div>
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) =>
                  setEditing({ ...editing, active: e.target.checked })
                }
              />
            </div>
          </div>

          <div className="panel">
            <h2>Exchange options</h2>
            <p className="settings-row__hint" style={{ marginBottom: 14 }}>
              What a matching item can be exchanged for. Each option is one
              collection, shown to the customer as its own card — add several
              here to offer several. A collection already offered by an earlier
              rule isn't shown twice.
            </p>

            {collections.length === 0 && (
              <div className="alert alert--warn">
                No collections found in your store, so there's nothing to point
                an option at yet.
              </div>
            )}

            {editing.options.map((option, index) => (
              <div key={index} className="settings-row settings-row--stacked">
                <input
                  type="text"
                  value={option.label}
                  placeholder="Exchange for a new style"
                  onChange={(e) => setOption(index, { label: e.target.value })}
                />
                <div className="rule-option__row">
                  <select
                    value={option.collectionId}
                    onChange={(e) => {
                      const chosen = collections.find(
                        (c) => c.id === e.target.value,
                      );
                      setOption(index, {
                        collectionId: e.target.value,
                        collectionTitle: chosen?.title ?? "",
                      });
                    }}
                  >
                    <option value="">Choose a collection…</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        options: editing.options.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            <button
              className="btn btn--secondary btn--sm"
              style={{ marginTop: 12 }}
              disabled={collections.length === 0}
              onClick={() =>
                setEditing({
                  ...editing,
                  options: [
                    ...editing.options,
                    { label: "", collectionId: "", collectionTitle: "" },
                  ],
                })
              }
            >
              Add exchange option
            </button>
          </div>

          <div className="rule-actions">
            {editing.id && (
              <button
                className="btn btn--danger btn--sm"
                onClick={() => void remove(editing)}
              >
                Delete
              </button>
            )}
            <div className="rule-actions__right">
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn--sm"
                disabled={
                  saving ||
                  !editing.name.trim() ||
                  editing.options.some((o) => !o.label.trim() || !o.collectionId)
                }
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save rule"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
