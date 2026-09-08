import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type {
  BonusType,
  ExchangeCollection,
  PortalBranding,
  StoreSettings,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";

/**
 * The recommendation screen's words, and what they say when the merchant
 * hasn't written their own. The defaults are the English of the app's own
 * translation; a store in another language gets that language until it
 * types something here.
 */
const AI_COPY: Array<{
  key: keyof Pick<
    PortalBranding,
    | "aiSwitchLabel"
    | "aiDetailsTitle"
    | "aiSimilarTitle"
    | "aiPriceCaption"
    | "aiPrimaryLabel"
    | "aiSecondaryLabel"
  >;
  label: string;
  fallback: string;
}> = [
  { key: "aiSwitchLabel", label: "Switch option link", fallback: "Show another option" },
  { key: "aiDetailsTitle", label: "Product details title", fallback: "Product details" },
  { key: "aiSimilarTitle", label: "Similar choices title", fallback: "Similar choices" },
  { key: "aiPriceCaption", label: "Price caption", fallback: "your price" },
  { key: "aiPrimaryLabel", label: "Primary button", fallback: "Get it now" },
  { key: "aiSecondaryLabel", label: "Secondary button", fallback: "No, thanks" },
];

/**
 * "AI exchange": the switch, and the words on the screen it turns on.
 *
 * Lives under the groups because it draws on them — a matching group's
 * products lead the recommendation — and because the two are the same
 * decision from the merchant's side: what a return is allowed to become.
 */
function AiExchangePanel() {
  const [store, setStore] = useState<StoreSettings | null>(null);
  const [branding, setBranding] = useState<PortalBranding | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [edits, setEdits] = useState<Partial<PortalBranding>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<StoreSettings>("/admin/settings/store", { auth: "admin" })
      .then((s) => active && setStore(s))
      .catch(() => undefined);
    api
      .get<PortalBranding>("/admin/settings/branding", { auth: "admin" })
      .then((b) => active && setBranding(b))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const toggle = async () => {
    if (!store || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = !store.aiExchangeEnabled;
      await api.patch("/admin/settings/store", { aiExchangeEnabled: next }, { auth: "admin" });
      setStore({ ...store, aiExchangeEnabled: next });
      setStatus(next ? "AI exchange is on." : "AI exchange is off.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setBusy(false);
    }
  };

  const shown = (key: (typeof AI_COPY)[number]["key"]) =>
    (edits[key] !== undefined ? edits[key] : branding?.[key]) ?? "";

  const saveCopy = async () => {
    if (!branding || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string | null> = {};
      for (const { key } of AI_COPY) {
        if (edits[key] !== undefined) body[key] = (edits[key] ?? "").trim() || null;
      }
      const next = await api.put<PortalBranding>("/admin/settings/branding", body, {
        auth: "admin",
      });
      setBranding(next);
      setEdits({});
      setCustomizing(false);
      setStatus("Saved. Your portal is updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the content.");
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;
  const preview = (key: (typeof AI_COPY)[number]["key"]) =>
    shown(key).trim() || AI_COPY.find((c) => c.key === key)!.fallback;

  return (
    <div className="panel ai-panel">
      <div className="panel__head">
        <h2>
          AI exchange <span className="ai-spark" aria-hidden="true">✦</span>
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={store.aiExchangeEnabled}
          aria-label="AI exchange"
          className={`switch${store.aiExchangeEnabled ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <p className="settings-row__hint" style={{ marginTop: 6 }}>
        Recommends one replacement the moment a customer has given their
        return reason — from the reason itself, the exchange groups above, and
        what's alike in your catalogue — before the usual choice of exchange
        or return. "No, thanks" takes them to that choice as normal.
      </p>
      <div className="alert alert--info" style={{ marginTop: 12 }}>
        If a recommended product is the same item being returned, your Variant
        exchange settings apply to the price difference.
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      <div className="ai-panel__rows">
        <div className="ai-panel__row">
          <span>
            Checkout method: <strong>Shopify checkout</strong>
          </span>
        </div>
        <div className="ai-panel__row">
          <span>Returns page customization</span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setCustomizing(!customizing)}
          >
            {customizing ? "Close" : "Customize content"}
          </button>
        </div>
      </div>

      {customizing && branding && (
        <div className="portal-settings" style={{ marginTop: 18 }}>
          <div className="settings-form">
            {AI_COPY.map(({ key, label, fallback }) => (
              <div key={key} className="settings-row settings-row--stacked">
                <div className="settings-row__label">{label}</div>
                <div className="counted">
                  <input
                    type="text"
                    className="settings-input"
                    maxLength={50}
                    value={shown(key)}
                    placeholder={fallback}
                    onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                  />
                  <span className="counted__count">{shown(key).length}/50</span>
                </div>
              </div>
            ))}
            <div className="rule-actions">
              <div className="rule-actions__right">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setEdits({});
                    setCustomizing(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || Object.keys(edits).length === 0}
                  onClick={() => void saveCopy()}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>

          {/* The screen as the customer sees it, with these words in place. */}
          <div className="portal-settings__preview">
            <div className="panel">
              <h2>Preview</h2>
              <div className="gp aip">
                <div className="aip__title">
                  <span className="ai-spark">✦</span> A better match for you
                </div>
                <div className="aip__intro">
                  Based on your return, we found an exchange option you may prefer.
                </div>
                <div className="aip__switch">↻ {preview("aiSwitchLabel")}</div>
                <div className="aip__card">
                  <div className="aip__media">
                    <span className="aip__flag">✦ Best match</span>
                  </div>
                  <div>
                    <div className="aip__name">Recommended exchange</div>
                    <div className="aip__price">
                      <s>$29.00</s> <strong>$0.00</strong>{" "}
                      <span className="muted">{preview("aiPriceCaption")}</span>
                    </div>
                    <span className="chip">Free exchange</span>
                    <div className="aip__axis">Size</div>
                    <div className="aip__sizes">
                      <span>S</span>
                      <span className="is-selected">✦ M</span>
                      <span>L</span>
                    </div>
                    <div className="aip__details">{preview("aiDetailsTitle")} ⌄</div>
                  </div>
                </div>
                <div className="aip__similar">{preview("aiSimilarTitle")}</div>
                <div className="aip__actions">
                  <span className="aip__btn aip__btn--secondary">
                    {preview("aiSecondaryLabel")}
                  </span>
                  <span className="aip__btn">{preview("aiPrimaryLabel")}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Exchange groups — "advanced exchanges".
 *
 * Without a group, an exchange offers the whole catalogue. A group pairs the
 * items it applies to with the products they may become: a return condition
 * on the item coming back and an offer condition on what's shown instead.
 * Its name is what the customer reads on the option. Every group that matches
 * an item is offered; the order here is the order the customer sees them in.
 */

type MatchBy = "PRODUCT_TAG" | "PRODUCT_TYPE" | "PRODUCT_NAME" | "COLLECTION";
type OfferBy = "PRODUCT_TAG" | "PRODUCT_TYPE" | "COLLECTION";
type Pricing = "EVEN" | "DIFFERENCE";

interface Group {
  id: string;
  name: string;
  active: boolean;
  matchBy: MatchBy;
  matchValues: string[];
  offerBy: OfferBy;
  offerValues: string[];
  pricing: Pricing;
  inStockOnly: boolean;
  allowNote: boolean;
  showProductTitles: boolean;
  /** Null means this group doesn't override the store-wide exchange bonus. */
  bonusType: BonusType | null;
  bonusValue: number | null;
}

const MATCH_LABELS: Record<MatchBy, string> = {
  PRODUCT_TAG: "Product tag",
  PRODUCT_TYPE: "Product type",
  PRODUCT_NAME: "Product name",
  COLLECTION: "Collection",
};

const OFFER_LABELS: Record<OfferBy, string> = {
  PRODUCT_TAG: "Product tag",
  PRODUCT_TYPE: "Product type",
  COLLECTION: "Collection",
};

const PLACEHOLDERS: Record<MatchBy, string> = {
  PRODUCT_TAG: "e.g. snowboard, winter-2026",
  PRODUCT_TYPE: "e.g. Snowboard, Bindings",
  PRODUCT_NAME: "e.g. Collection Snowboard",
  COLLECTION: "",
};

/** A group that has never been saved, so the editor has something to open on. */
const blankGroup = (): Group => ({
  id: "",
  name: "",
  active: true,
  matchBy: "PRODUCT_TAG",
  matchValues: [],
  offerBy: "COLLECTION",
  offerValues: [],
  pricing: "EVEN",
  inStockOnly: true,
  allowNote: false,
  showProductTitles: false,
  bonusType: "PERCENT",
  bonusValue: null,
});

const splitValues = (text: string) =>
  [...new Set(text.split(",").map((v) => v.trim()).filter(Boolean))];

/**
 * One half of the product pairing: what kind of thing to match on, and the
 * values it may be any of. Collections are picked from the store's list; the
 * rest are typed, comma-separated, and shown back as chips.
 */
function Condition<K extends string>({
  label,
  kinds,
  kind,
  onKind,
  text,
  onText,
  picked,
  onToggle,
  collections,
  hint,
}: {
  label: string;
  kinds: Record<K, string>;
  kind: K;
  onKind: (kind: K) => void;
  text: string;
  onText: (text: string) => void;
  picked: string[];
  onToggle: (collectionId: string) => void;
  collections: ExchangeCollection[];
  hint: string;
}) {
  return (
    <div className="pairing">
      <div className="pairing__label">{label}</div>
      <div className="pairing__head">
        <select value={kind} onChange={(e) => onKind(e.target.value as K)}>
          {(Object.keys(kinds) as K[]).map((k) => (
            <option key={k} value={k}>
              {kinds[k]}
            </option>
          ))}
        </select>
        <span className="pairing__op">is any of</span>
      </div>

      {kind === "COLLECTION" ? (
        <div className="collection-picker">
          {collections.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              No collections found in your store. Connect Shopify, or add a
              collection there first.
            </p>
          )}
          {collections.map((c) => (
            <label key={c.id} className="collection-picker__item">
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                onChange={() => onToggle(c.id)}
              />
              {c.title}
            </label>
          ))}
        </div>
      ) : (
        <>
          <input
            type="text"
            className="settings-input pairing__input"
            value={text}
            placeholder={PLACEHOLDERS[kind as MatchBy] ?? ""}
            onChange={(e) => onText(e.target.value)}
          />
          {splitValues(text).length > 0 && (
            <div className="chips">
              {splitValues(text).map((v) => (
                <span key={v} className="chip">
                  {v}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <p className="settings-row__hint" style={{ marginTop: 8 }}>
        {hint}
      </p>
    </div>
  );
}

export default function ExchangeRulesPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [collections, setCollections] = useState<ExchangeCollection[]>([]);
  const [editing, setEditing] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Typed values stay text until save; see splitValues. */
  const [matchText, setMatchText] = useState("");
  const [offerText, setOfferText] = useState("");
  /** Text while it's being typed; "1." on the way to "1.5" must survive. */
  const [bonusText, setBonusText] = useState("");

  const load = () =>
    api
      .get<{ rules: Group[]; collections: ExchangeCollection[] }>(
        "/admin/settings/exchange-rules",
        { auth: "admin" },
      )
      .then((r) => {
        setGroups(r.rules);
        setCollections(r.collections);
      })
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const open = (group: Group) => {
    setEditing(group);
    setMatchText(group.matchBy === "COLLECTION" ? "" : group.matchValues.join(", "));
    setOfferText(group.offerBy === "COLLECTION" ? "" : group.offerValues.join(", "));
    setBonusText(group.bonusValue === null ? "" : String(group.bonusValue));
    setStatus(null);
    setError(null);
  };

  const collectionName = (id: string) =>
    collections.find((c) => c.id === id)?.title ?? "a collection no longer in your store";

  /** The values as they'll be saved, whichever way they're being edited. */
  const matchValues = (g: Group) =>
    g.matchBy === "COLLECTION" ? g.matchValues : splitValues(matchText);
  const offerValues = (g: Group) =>
    g.offerBy === "COLLECTION" ? g.offerValues : splitValues(offerText);

  const describeValues = (kind: string, values: string[]) =>
    values.length === 0
      ? "—"
      : kind === "COLLECTION"
        ? values.map(collectionName).join(", ")
        : values.join(", ");

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: editing.name.trim(),
        active: editing.active,
        matchBy: editing.matchBy,
        matchValues: matchValues(editing),
        offerBy: editing.offerBy,
        offerValues: offerValues(editing),
        pricing: editing.pricing,
        inStockOnly: editing.inStockOnly,
        allowNote: editing.allowNote,
        showProductTitles: editing.showProductTitles,
        bonusType: editing.bonusType ?? "PERCENT",
        bonusValue: bonusText.trim() === "" ? null : Number(bonusText),
      };
      if (editing.id) {
        await api.patch(`/admin/settings/exchange-rules/${editing.id}`, body, {
          auth: "admin",
        });
      } else {
        await api.post("/admin/settings/exchange-rules", body, { auth: "admin" });
      }
      await load();
      setEditing(null);
      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that group.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (group: Group) => {
    if (!window.confirm(`Delete "${group.name}"? Customers will stop seeing it as an option.`)) {
      return;
    }
    setError(null);
    try {
      await api.delete(`/admin/settings/exchange-rules/${group.id}`, {
        auth: "admin",
      });
      await load();
      setEditing(null);
      setStatus("Group deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that group.");
    }
  };

  /** Order is only meaningful across the whole set, so it moves one at a time. */
  const move = async (index: number, delta: number) => {
    const next = [...groups];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setGroups(next);
    await api
      .post(
        "/admin/settings/exchange-rules/reorder",
        { ids: next.map((r) => r.id) },
        { auth: "admin" },
      )
      .catch((e) => setError(e instanceof Error ? e.message : null));
  };

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id];

  if (loading) return <Loading />;

  const canSave =
    editing !== null &&
    !saving &&
    editing.name.trim().length > 0 &&
    matchValues(editing).length > 0 &&
    offerValues(editing).length > 0;

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>{editing ? (editing.id ? "Edit exchange group" : "Create exchange group") : "Advanced exchanges"}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {editing
              ? "Pair the items a customer returns with the products they can exchange them for."
              : "Decide what a returned item can be exchanged for. Without a group, customers can exchange into anything in your catalogue. Every group that matches an item is offered, in the order below."}
          </p>
        </div>
        {!editing && (
          <button className="btn btn--sm" onClick={() => open(blankGroup())}>
            Create exchange group
          </button>
        )}
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      {!editing && (
        <div className="settings-form">
          {groups.length === 0 ? (
            <div className="panel">
              <p className="muted">
                No exchange groups yet. Every exchange offers the whole catalogue.
              </p>
            </div>
          ) : (
            groups.map((group, index) => (
              <div key={group.id} className="panel rule-row">
                <div className="rule-row__body">
                  <div className="settings-row__label">
                    {group.name}
                    {!group.active && (
                      <span className="chip" style={{ marginLeft: 8 }}>
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="settings-row__hint">
                    {MATCH_LABELS[group.matchBy]}:{" "}
                    {describeValues(group.matchBy, group.matchValues)} →{" "}
                    {OFFER_LABELS[group.offerBy]}:{" "}
                    {describeValues(group.offerBy, group.offerValues)}
                    {" · "}
                    {group.pricing === "EVEN"
                      ? "Even exchange"
                      : "Price difference charged or refunded"}
                    {group.bonusValue !== null &&
                      ` · ${group.bonusValue}${group.bonusType === "PERCENT" ? "%" : ""} bonus`}
                  </div>
                </div>
                <div className="rule-row__actions">
                  {/* Every matching group applies, so this orders the cards the
                      customer sees rather than deciding which group wins. */}
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
                    disabled={index === groups.length - 1}
                    onClick={() => void move(index, 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => open(group)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))
          )}
          <AiExchangePanel />
        </div>
      )}

      {editing && (
        <div className="portal-settings">
          <div className="settings-form">
            <div className="panel">
              <h2>Group name</h2>
              <div className="counted">
                <input
                  type="text"
                  className="settings-input"
                  maxLength={200}
                  value={editing.name}
                  placeholder="Exchange for a new style"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
                <span className="counted__count">{editing.name.length}/200</span>
              </div>
              <p className="settings-row__hint" style={{ marginTop: 8 }}>
                Customers will see this name as an exchange option.
              </p>
            </div>

            <div className="panel">
              <h2>Product pairing</h2>
              <p className="settings-row__hint" style={{ marginBottom: 16 }}>
                Define which return items are eligible for an exchange, and
                which new products they can be exchanged for.
              </p>

              <Condition
                label="Return item condition"
                kinds={MATCH_LABELS}
                kind={editing.matchBy}
                onKind={(matchBy) => {
                  setEditing({ ...editing, matchBy, matchValues: [] });
                  setMatchText("");
                }}
                text={matchText}
                onText={setMatchText}
                picked={editing.matchValues}
                onToggle={(id) =>
                  setEditing({
                    ...editing,
                    matchValues: toggleIn(editing.matchValues, id),
                  })
                }
                collections={collections}
                hint={
                  editing.matchBy === "PRODUCT_NAME"
                    ? "Separate with commas. An item matches if its name contains any of them."
                    : editing.matchBy === "COLLECTION"
                      ? "An item matches if its product is in any of these collections, checked when the customer starts a return."
                      : "Separate with commas. Tags and types are read from the order as it was placed, so retagging a product later won't change an existing order's options."
                }
              />

              <div className="pairing__divider" />

              <Condition
                label="Exchange item condition"
                kinds={OFFER_LABELS}
                kind={editing.offerBy}
                onKind={(offerBy) => {
                  setEditing({ ...editing, offerBy, offerValues: [] });
                  setOfferText("");
                }}
                text={offerText}
                onText={setOfferText}
                picked={editing.offerValues}
                onToggle={(id) =>
                  setEditing({
                    ...editing,
                    offerValues: toggleIn(editing.offerValues, id),
                  })
                }
                collections={collections}
                hint={
                  editing.offerBy === "COLLECTION"
                    ? "Customers can pick anything in these collections."
                    : "Separate with commas. Customers can pick any product carrying one of them, as your catalogue is now."
                }
              />
            </div>

            <div className="panel">
              <h2>Additional settings</h2>

              <div className="radio-list">
                <label className="radio-list__item">
                  <input
                    type="radio"
                    name="pricing"
                    checked={editing.pricing === "EVEN"}
                    onChange={() => setEditing({ ...editing, pricing: "EVEN" })}
                  />
                  <span>
                    <span className="radio-list__label">Treat as an even exchange</span>
                    <span className="radio-list__hint">
                      The customer pays nothing more and is credited nothing back,
                      whatever the price of what they pick.
                    </span>
                  </span>
                </label>
                <label className="radio-list__item">
                  <input
                    type="radio"
                    name="pricing"
                    checked={editing.pricing === "DIFFERENCE"}
                    onChange={() =>
                      setEditing({ ...editing, pricing: "DIFFERENCE" })
                    }
                  />
                  <span>
                    <span className="radio-list__label">
                      Charge or refund the price difference
                    </span>
                    <span className="radio-list__hint">
                      A dearer pick is paid for at checkout; a cheaper one leaves
                      credit, settled the way the customer chooses.
                    </span>
                  </span>
                </label>
                {editing.pricing === "DIFFERENCE" && (
                  <div className="checkout-method">
                    Checkout method: <strong>Shopify checkout</strong>
                  </div>
                )}
              </div>

              <div className="pairing__divider" />

              <label className="check-list__item">
                <input
                  type="checkbox"
                  checked={editing.inStockOnly}
                  onChange={(e) =>
                    setEditing({ ...editing, inStockOnly: e.target.checked })
                  }
                />
                <span>
                  <span className="radio-list__label">
                    Only show in-stock products
                  </span>
                  <span className="radio-list__hint">
                    Off shows sold-out products too, greyed out, so customers
                    know they exist.
                  </span>
                </span>
              </label>
              <label className="check-list__item">
                <input
                  type="checkbox"
                  checked={editing.allowNote}
                  onChange={(e) =>
                    setEditing({ ...editing, allowNote: e.target.checked })
                  }
                />
                <span>
                  <span className="radio-list__label">
                    Allow customers to leave a note for their exchange
                  </span>
                  <span className="radio-list__hint">
                    Shown to you beside the item they picked.
                  </span>
                </span>
              </label>
              <label className="check-list__item">
                <input
                  type="checkbox"
                  checked={editing.showProductTitles}
                  onChange={(e) =>
                    setEditing({ ...editing, showProductTitles: e.target.checked })
                  }
                />
                <span>
                  <span className="radio-list__label">
                    Show product names under the pictures
                  </span>
                </span>
              </label>

              <div className="pairing__divider" />

              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Credit bonus</div>
                  <div className="settings-row__hint">
                    Extra credit for exchanging an item this group matches,
                    overriding the store-wide exchange bonus. Leave empty to
                    use that instead.
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
                  <div className="settings-row__label">Active</div>
                  <div className="settings-row__hint">
                    A disabled group is offered to nobody; any other matching
                    groups still are.
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
                  disabled={!canSave}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : editing.id ? "Save" : "Create"}
                </button>
              </div>
            </div>
          </div>

          {/* What the settings add up to, and what the customer will see. */}
          <div className="portal-settings__preview">
            <div className="panel group-summary">
              <h2>Summary</h2>
              <div className="group-summary__head">Group name</div>
              <ul>
                <li>{editing.name.trim() || "—"}</li>
              </ul>
              <div className="group-summary__head">Product pairing</div>
              <ul>
                <li>
                  Return item: {MATCH_LABELS[editing.matchBy]} (
                  {describeValues(editing.matchBy, matchValues(editing))})
                </li>
                <li>
                  Exchange item: {OFFER_LABELS[editing.offerBy]} (
                  {describeValues(editing.offerBy, offerValues(editing))})
                </li>
              </ul>
              <div className="group-summary__head">Additional settings</div>
              <ul>
                <li>
                  {editing.pricing === "EVEN"
                    ? "Treat as an even exchange"
                    : "Charge or refund the price difference"}
                </li>
                {editing.inStockOnly && <li>Only in-stock products</li>}
                {editing.allowNote && <li>Customers can leave a note</li>}
                {bonusText.trim() !== "" && (
                  <li>
                    {bonusText}
                    {(editing.bonusType ?? "PERCENT") === "PERCENT" ? "%" : ""}{" "}
                    credit bonus
                  </li>
                )}
              </ul>
            </div>

            <div className="panel">
              <h2>Preview</h2>
              <div className="gp">
                <div className="gp__title">How would you like to proceed?</div>
                <div className="gp__card gp__card--group">
                  <div className="gp__card-label">
                    {editing.name.trim() || "Exchange for a new style"}
                  </div>
                  <div className="gp__strip">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
                <div className="gp__card">Return item</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
