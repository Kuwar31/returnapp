import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { ErrorAlert, Loading } from "../components/Feedback";
import type { OrderNoteRule, OrderNotesSettings } from "../lib/types";
import { useAuth } from "./AuthContext";
import { Switch } from "./policy-controls";
import { storePath } from "./store-path";

/**
 * Tags and notes — AfterShip's page of the same name. Each moment in a
 * return's life can add tags to the shopper's Shopify order and append a
 * note, so staff working in Shopify see where a return stands without
 * opening this app. Two groups: what goes on the original order, and what
 * goes on the exchange order the app raises.
 */

const key = (r: Pick<OrderNoteRule, "event" | "target">) => `${r.event}:${r.target}`;

export default function OrderNotesPage() {
  const { session } = useAuth();
  const base = storePath(session!.merchant.slug);
  const [data, setData] = useState<OrderNotesSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Edits not yet saved, by rule. */
  const [drafts, setDrafts] = useState<Record<string, OrderNoteRule>>({});

  useEffect(() => {
    api
      .get<OrderNotesSettings>("/admin/settings/order-notes", { auth: "admin" })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));
  }, []);

  const save = async (rules: OrderNoteRule[], message: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await api.patch<{ rules: OrderNoteRule[] }>(
        "/admin/settings/order-notes",
        { rules: rules.map((r) => ({ event: r.event, target: r.target, enabled: r.enabled, tags: r.tags, note: r.note })) },
        { auth: "admin" },
      );
      setData((d) => (d ? { ...d, rules: next.rules } : d));
      setDrafts((d) => {
        const copy = { ...d };
        for (const r of rules) delete copy[key(r)];
        return copy;
      });
      setStatus(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Tags and notes</h1>
        <ErrorAlert message={error ?? "Couldn't load the tags and notes."} />
      </>
    );
  }

  const original = data.rules.filter((r) => r.target === "ORIGINAL");
  const exchange = data.rules.filter((r) => r.target === "EXCHANGE");

  const card = (saved: OrderNoteRule) => {
    const k = key(saved);
    const draft = drafts[k] ?? saved;
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const patch = (changes: Partial<OrderNoteRule>) => {
      setStatus(null);
      setDrafts((d) => ({ ...d, [k]: { ...(d[k] ?? saved), ...changes } }));
    };
    return (
      <div key={k} className="panel onote">
        <div className="onote__head">
          <h2>{saved.label}</h2>
          <Switch
            on={draft.enabled}
            label={saved.label}
            disabled={busy}
            onChange={(enabled) => void save([{ ...draft, enabled }], enabled ? `${saved.label}: on.` : `${saved.label}: off.`)}
          />
        </div>
        <p className="settings-row__hint" style={{ marginTop: -4, marginBottom: 14 }}>
          {saved.description}
        </p>
        <TagInput value={draft.tags} disabled={busy} placeholders={data.placeholders} onChange={(tags) => patch({ tags })} />
        <div className="field-label" style={{ marginTop: 14 }}>
          Order notes
        </div>
        <textarea
          className="settings-input onote__note"
          rows={5}
          value={draft.note}
          maxLength={2000}
          placeholder="Leave empty to add no note at this step."
          onChange={(e) => patch({ note: e.target.value })}
        />
        <div className="onote__foot">
          <details className="onote__help">
            <summary>Placeholders</summary>
            <div className="onote__chips">
              {data.placeholders.map((p) => (
                <button key={p} type="button" className="onote__chip" onClick={() => patch({ note: draft.note ? `${draft.note} ${p}` : p })}>
                  {p}
                </button>
              ))}
            </div>
          </details>
          <button type="button" className="btn btn--sm" disabled={busy || !dirty} onClick={() => void save([draft], `${saved.label}: saved.`)}>
            Save
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Tags and notes</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Auto-generate tags and notes on your customers' Shopify orders as their returns and exchanges move along.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}
      {data.canWrite === false && (
        <div className="alert alert--warn">
          This store's Shopify connection can't edit orders yet: the app was installed before it asked for that
          permission. <Link to={`${base}/settings`}>Reconnect the store</Link> under General to grant it, and tags and
          notes will start being written. Until then each attempt is recorded on the return's timeline.
        </div>
      )}
      {data.canWrite === null && (
        <div className="alert alert--warn">
          Shopify isn't connected on this store, so nothing can be written yet. The rules below still save.
        </div>
      )}

      <div className="split">
        <div>
          <h3 className="split__title">For original orders</h3>
          <p className="split__blurb">
            These tags and notes are attached to the order the customer is returning from. Tags are added to the
            order's tags; notes are appended under whatever is already there.
          </p>
        </div>
        <div className="onote__list">{original.map(card)}</div>
      </div>

      <div className="split">
        <div>
          <h3 className="split__title">For exchange orders</h3>
          <p className="split__blurb">
            Attached to the exchange order the app creates in Shopify for a replacement. Applies to exchanges that
            open a draft order; a native Shopify exchange stays on the original order.
          </p>
        </div>
        <div className="onote__list">{exchange.map(card)}</div>
      </div>
    </>
  );
}

/** Tags as chips, typed one at a time; Enter or a comma adds, × removes. */
function TagInput({
  value,
  disabled,
  placeholders,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  placeholders: string[];
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const tag = text.trim().replace(/,+$/, "").trim();
    if (!tag) return;
    if (!value.includes(tag) && value.length < 10) onChange([...value, tag]);
    setText("");
  };
  return (
    <div>
      <div className="field-label">Order tags</div>
      <div className="onote__tagbox">
        <input
          type="text"
          className="settings-input"
          value={text}
          maxLength={40}
          disabled={disabled || value.length >= 10}
          placeholder={value.length >= 10 ? "Ten tags is the most" : "Type a tag and press Enter"}
          list="onote-placeholders"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <span className="onote__count">{text.length}/40</span>
      </div>
      <datalist id="onote-placeholders">
        {placeholders.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {value.length > 0 && (
        <div className="onote__tags">
          {value.map((tag) => (
            <span key={tag} className="onote__tag">
              {tag}
              <button type="button" aria-label={`Remove tag ${tag}`} disabled={disabled} onClick={() => onChange(value.filter((t) => t !== tag))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
