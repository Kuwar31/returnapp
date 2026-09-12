import { useEffect, useState } from "react";
import { useBlocker } from "react-router";
import { api } from "../lib/api";
import type {
  LibraryReason,
  ReasonGroupSummary,
  ReasonsResponse,
} from "../lib/types";
import { ErrorAlert, Loading } from "../components/Feedback";
import { Modal } from "./Modal";
import { Counted } from "./policy-controls";

/**
 * Return reasons, laid out as AfterShip's.
 *
 * Two lists: the reason library — each reason with its sub-reasons and what
 * it asks of the shopper — and the reason groups, which pick reasons from
 * the library and say, by product type or tag, which products they apply
 * to. Each is created and edited on its own screen.
 */

const PAGE = 10;
const NAME_MAX = 60;

type ConditionType = "productTypes" | "productTags";

const CONDITION_TYPES: Array<{ type: ConditionType; label: string; placeholder: string }> = [
  { type: "productTypes", label: "Product type", placeholder: "Footwear, Outerwear" },
  { type: "productTags", label: "Product tag", placeholder: "fragile, oversized" },
];

interface GroupDraft {
  kind: "group";
  id: string | null;
  isDefault: boolean;
  title: string;
  /** Comma-separated while typed; a key present is a condition shown. */
  conditions: Partial<Record<ConditionType, string>>;
  randomizeOrder: boolean;
  reasonIds: string[];
}

interface SubDraft {
  id: string | null;
  label: string;
  code: string;
  requiresNote: boolean;
  requiresPhoto: boolean;
}

interface ReasonDraft {
  kind: "reason";
  id: string | null;
  label: string;
  code: string;
  requiresNote: boolean;
  requiresPhoto: boolean;
  children: SubDraft[];
}

type Draft = GroupDraft | ReasonDraft;

const splitList = (raw: string): string[] => [
  ...new Set(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

const groupDraft = (g?: ReasonGroupSummary): GroupDraft => ({
  kind: "group",
  id: g?.id ?? null,
  isDefault: g?.isDefault ?? false,
  title: g?.title ?? "",
  conditions: {
    ...(g?.productTypes.length ? { productTypes: g.productTypes.join(", ") } : {}),
    ...(g?.productTags.length ? { productTags: g.productTags.join(", ") } : {}),
  },
  randomizeOrder: g?.randomizeOrder ?? false,
  reasonIds: g?.reasonIds ?? [],
});

const reasonDraft = (r?: LibraryReason): ReasonDraft => ({
  kind: "reason",
  id: r?.id ?? null,
  label: r?.label ?? "",
  code: r?.code ?? "OTHER",
  requiresNote: r?.requiresNote ?? false,
  requiresPhoto: r?.requiresPhoto ?? false,
  children: (r?.children ?? []).map((c) => ({ ...c })),
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Product type: Footwear, Outerwear · Product tag: fragile" */
const describeConditions = (g: ReasonGroupSummary): string => {
  if (g.isDefault) return "Every product no other group claims";
  const parts: string[] = [];
  if (g.productTypes.length) parts.push(`Product type: ${g.productTypes.join(", ")}`);
  if (g.productTags.length) parts.push(`Product tag: ${g.productTags.join(", ")}`);
  return parts.length ? parts.join(" · ") : "No conditions yet, so no products fall into it";
};

/** A sub-reason, added or changed, in a dialog. */
function SubReasonModal({
  initial,
  codes,
  onSave,
  onClose,
}: {
  initial: SubDraft;
  codes: string[];
  onSave: (draft: SubDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SubDraft>(initial);
  return (
    <Modal
      title={initial.label ? "Edit sub-reason" : "Add sub-reason"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!draft.label.trim()}
            onClick={() => onSave({ ...draft, label: draft.label.trim() })}
          >
            {initial.label ? "Save" : "Add"}
          </button>
        </>
      }
    >
      <div className="rform">
        <div className="rform__field">
          <div className="rform__label">Sub-reason name</div>
          <Counted
            value={draft.label}
            max={NAME_MAX}
            label="Sub-reason name"
            onChange={(label) => setDraft({ ...draft, label })}
          />
        </div>
        <div className="rform__field">
          <div className="rform__label">Reports to Shopify as</div>
          <select
            className="settings-input"
            value={draft.code}
            aria-label="Reports to Shopify as"
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          >
            {codes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="rform__field">
          <div className="rform__label">Detailed information</div>
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={draft.requiresNote}
              onChange={(e) => setDraft({ ...draft, requiresNote: e.target.checked })}
            />
            <span className="radio-list__label">Additional details</span>
          </label>
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={draft.requiresPhoto}
              onChange={(e) => setDraft({ ...draft, requiresPhoto: e.target.checked })}
            />
            <span className="radio-list__label">Image upload</span>
          </label>
          <p className="settings-row__hint" style={{ marginTop: 8 }}>
            On top of whatever the reason itself asks for.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** The library, to pick a group's reasons from. */
function LibraryPicker({
  library,
  selected,
  onConfirm,
  onClose,
}: {
  library: LibraryReason[];
  selected: string[];
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected));
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Modal
      title="Add return reasons from library"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              onConfirm([
                // Keep the group's own order; new picks join at the end.
                ...selected.filter((id) => chosen.has(id)),
                ...library.map((r) => r.id).filter((id) => chosen.has(id) && !selected.includes(id)),
              ])
            }
          >
            Done
          </button>
        </>
      }
    >
      {library.length === 0 ? (
        <p className="settings-row__hint" style={{ padding: "12px 0" }}>
          Your library is empty. Add a reason first.
        </p>
      ) : (
        <div className="rsn-picker">
          {library.map((r) => (
            <label key={r.id} className="check-list__item">
              <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} />
              <span>
                <span className="radio-list__label">{r.label}</span>
                <span className="radio-list__hint">
                  {r.children.length ? r.children.map((c) => c.label).join(" · ") : "No sub-reasons"}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function ReasonsPage() {
  const [data, setData] = useState<ReasonsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [original, setOriginal] = useState("");
  /** Whether a group's condition builder is open; opened by "Set up conditions". */
  const [building, setBuilding] = useState(false);
  const [page, setPage] = useState(1);
  const [picking, setPicking] = useState(false);
  /** The sub-reason being added (index null) or changed. */
  const [sub, setSub] = useState<{ index: number | null; draft: SubDraft } | null>(null);

  const load = () =>
    api
      .get<ReasonsResponse>("/admin/settings/reasons", { auth: "admin" })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const dirty = editing !== null && JSON.stringify(editing) !== original;
  const blocker = useBlocker(dirty);

  const open = (draft: Draft) => {
    setEditing(draft);
    setOriginal(JSON.stringify(draft));
    setBuilding(draft.kind === "group" && Object.keys(draft.conditions).length > 0);
    setStatus(null);
    setError(null);
    window.scrollTo({ top: 0 });
  };

  const close = () => {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    setEditing(null);
  };

  const patchGroup = (changes: Partial<GroupDraft>) =>
    setEditing((prev) => (prev?.kind === "group" ? { ...prev, ...changes } : prev));

  const patchReason = (changes: Partial<ReasonDraft>) =>
    setEditing((prev) => (prev?.kind === "reason" ? { ...prev, ...changes } : prev));

  const setCondition = (type: ConditionType, value: string | undefined) =>
    setEditing((prev) => {
      if (prev?.kind !== "group") return prev;
      const conditions = { ...prev.conditions };
      if (value === undefined) delete conditions[type];
      else conditions[type] = value;
      return { ...prev, conditions };
    });

  const save = async () => {
    if (!editing || saving) return;
    setSaving(true);
    setError(null);
    try {
      let name: string;
      if (editing.kind === "group") {
        name = editing.title.trim();
        if (!name) {
          setError("Give the group a name.");
          return;
        }
        const body = {
          title: name,
          productTypes: splitList(editing.conditions.productTypes ?? ""),
          productTags: splitList(editing.conditions.productTags ?? ""),
          randomizeOrder: editing.randomizeOrder,
          reasonIds: editing.reasonIds,
        };
        if (editing.id) {
          await api.patch(`/admin/settings/reason-groups/${editing.id}`, body, { auth: "admin" });
        } else {
          await api.post("/admin/settings/reason-groups", body, { auth: "admin" });
        }
      } else {
        name = editing.label.trim();
        if (!name) {
          setError("Give the reason a name.");
          return;
        }
        const body = {
          label: name,
          code: editing.code,
          requiresNote: editing.requiresNote,
          requiresPhoto: editing.requiresPhoto,
          children: editing.children.map((c) => ({
            id: c.id ?? undefined,
            label: c.label,
            code: c.code,
            requiresNote: c.requiresNote,
            requiresPhoto: c.requiresPhoto,
          })),
        };
        if (editing.id) {
          await api.put(`/admin/settings/reasons/${editing.id}`, body, { auth: "admin" });
        } else {
          await api.post("/admin/settings/reasons", body, { auth: "admin" });
        }
      }
      await load();
      setEditing(null);
      setStatus(`Saved "${name}".`);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    const isGroup = editing.kind === "group";
    const name = isGroup ? editing.title : editing.label;
    const warning = isGroup
      ? `Delete "${name}"? Its products will use the default group's reasons.`
      : `Delete "${name}"? It's removed from every group.`;
    if (!window.confirm(warning)) return;
    setError(null);
    try {
      if (isGroup) {
        await api.delete(`/admin/settings/reason-groups/${editing.id}`, { auth: "admin" });
        setStatus("Group deleted.");
      } else {
        const res = await api.delete<{ retired: boolean }>(`/admin/settings/reasons/${editing.id}`, {
          auth: "admin",
        });
        setStatus(
          res?.retired
            ? "Past returns used that reason, so it's kept for their history but no longer offered."
            : "Reason deleted.",
        );
      }
      await load();
      setEditing(null);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that.");
    }
  };

  if (loading) return <Loading />;
  if (!data) {
    return (
      <>
        <h1>Return reasons</h1>
        <ErrorAlert message={error ?? "Couldn't load your return reasons."} />
      </>
    );
  }

  const { groups, library, shopifyCodes } = data;
  const reasonById = new Map(library.map((r) => [r.id, r]));

  // -------------------------------------------------------------------------
  // The overview: groups, then the library
  // -------------------------------------------------------------------------
  if (!editing) {
    const pages = Math.ceil(library.length / PAGE);
    const current = Math.min(Math.max(page, 1), Math.max(pages, 1));
    const rows = library.slice((current - 1) * PAGE, current * PAGE);

    return (
      <>
        <div className="admin__header">
          <div>
            <div className="admin__eyebrow">Settings</div>
            <h1>Return reasons</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Find out why products are being returned by allowing customers to
              select a return reason.
            </p>
          </div>
        </div>

        <ErrorAlert message={error} />
        {status && <div className="alert alert--info">{status}</div>}

        <div className="split">
          <div>
            <h3 className="split__title">Reason groups</h3>
            <p className="split__blurb">
              Group return reasons by different conditions to display reasons
              relevant to the returned products.
            </p>
          </div>
          <div className="panel">
            <div className="panel__head">
              <h2>Return reasons</h2>
              <button type="button" className="link-btn" onClick={() => open(groupDraft())}>
                Add reason group
              </button>
            </div>
            {groups.map((g) => (
              <div key={g.id} className="rsn-row">
                <div className="rsn-row__body">
                  <div className="rsn-row__title">
                    {g.title}
                    {g.isDefault && <span className="pcard__badge dest-row__badge">Default</span>}
                  </div>
                  <div className="rsn-row__hint">{describeConditions(g)}</div>
                  <div className="rsn-row__hint">{plural(g.reasonIds.length, "reason")}</div>
                </div>
                <div className="rsn-row__actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => open(groupDraft(g))}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="split">
          <div>
            <h3 className="split__title">Reason library</h3>
            <p className="split__blurb">
              Provide return reasons to help identify why your customers have
              requested a return. You can add sub-reasons for each reason.
            </p>
          </div>
          <div className="panel">
            <div className="panel__head">
              <h2>Reason library</h2>
              <button type="button" className="link-btn" onClick={() => open(reasonDraft())}>
                Add reason
              </button>
            </div>
            {rows.map((r) => (
              <div key={r.id} className="rsn-row">
                <div className="rsn-row__body">
                  <div className="rsn-row__title">{r.label}</div>
                  <div className="rsn-row__hint">
                    {r.children.length
                      ? r.children.map((c) => c.label).join(" · ")
                      : "No sub-reasons"}
                  </div>
                  <div className="rsn-row__hint">
                    {r.groupCount ? `In ${plural(r.groupCount, "group")}` : "Not in any group"}
                    {" · "}Reports to Shopify as {r.code}
                  </div>
                </div>
                <div className="rsn-row__actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => open(reasonDraft(r))}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
            <div className="pager">
              <button
                type="button"
                className="pager__btn"
                aria-label="Previous page"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              >
                ‹
              </button>
              <span>
                {current}/{pages}
              </span>
              <button
                type="button"
                className="pager__btn"
                aria-label="Next page"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              >
                ›
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // The editors, with the save bar they share
  // -------------------------------------------------------------------------
  const isGroup = editing.kind === "group";
  const currentName = isGroup ? editing.title : editing.label;

  const bar =
    blocker.state === "blocked" ? (
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
            {dirty ? "Unsaved changes" : editing.id ? currentName : isGroup ? "New reason group" : "New reason"}
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
    );

  const header = (title: string) => (
    <div className="admin__header">
      <div>
        <button type="button" className="link-btn peditor__back" onClick={close}>
          ‹ Return reasons
        </button>
        <h1>{title}</h1>
      </div>
    </div>
  );

  if (editing.kind === "group") {
    const conditionTypes = Object.keys(editing.conditions) as ConditionType[];
    const available = CONDITION_TYPES.filter((c) => !conditionTypes.includes(c.type));
    const chosen = editing.reasonIds.flatMap((id) => {
      const r = reasonById.get(id);
      return r ? [r] : [];
    });
    const moveReason = (index: number, delta: number) => {
      const ids = [...editing.reasonIds];
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      patchGroup({ reasonIds: ids });
    };

    return (
      <>
        {header(editing.id ? "Edit reason group" : "Create reason group")}
        <ErrorAlert message={error} />

        <div className="settings-form rform">
          <div className="panel">
            <h2>Reason group name</h2>
            <input
              type="text"
              className="settings-input"
              value={editing.title}
              maxLength={80}
              aria-label="Reason group name"
              onChange={(e) => patchGroup({ title: e.target.value })}
            />
            <p className="settings-row__hint" style={{ marginTop: 8 }}>
              For your reference only. Not shown to customers.
            </p>
          </div>

          <div className="panel">
            <h2>Conditions</h2>
            <p className="settings-row__hint" style={{ marginBottom: 14 }}>
              Define when a product falls into this reason group.
            </p>
            {editing.isDefault ? (
              <p className="settings-row__hint">
                The default group has no conditions: it applies to every
                product that no other group claims.
              </p>
            ) : !building ? (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setBuilding(true)}>
                Set up conditions
              </button>
            ) : (
              <>
                {conditionTypes.map((type) => {
                  const meta = CONDITION_TYPES.find((c) => c.type === type)!;
                  return (
                    <div key={type} className="cond">
                      <div className="cond__head">
                        <span className="cond__label">
                          {meta.label}
                          <span className="muted"> is any of</span>
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
                      <input
                        type="text"
                        className="settings-input"
                        value={editing.conditions[type] ?? ""}
                        placeholder={meta.placeholder}
                        aria-label={meta.label}
                        onChange={(e) => setCondition(type, e.target.value)}
                      />
                      <p className="settings-row__hint" style={{ marginTop: 6 }}>
                        Separate with commas. Matched as the product was when
                        the order was placed.
                      </p>
                    </div>
                  );
                })}
                {available.length > 0 && (
                  <select
                    className="cond__add"
                    value=""
                    aria-label="Add condition"
                    onChange={(e) => {
                      if (e.target.value) setCondition(e.target.value as ConditionType, "");
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
                {conditionTypes.length > 1 && (
                  <p className="settings-row__hint" style={{ marginTop: 10 }}>
                    A product has to meet every condition.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2>Return reasons</h2>
              <button type="button" className="link-btn" onClick={() => setPicking(true)}>
                Add return reasons from library
              </button>
            </div>
            {chosen.length === 0 ? (
              <div className="rsn-empty">
                <h3>No return reasons</h3>
                <p>Add return reasons to get feedback from your customers.</p>
              </div>
            ) : (
              chosen.map((r, index) => (
                <div key={r.id} className="rsn-row">
                  <div className="rsn-row__body">
                    <div className="rsn-row__title">{r.label}</div>
                    <div className="rsn-row__hint">
                      {r.children.length
                        ? r.children.map((c) => c.label).join(" · ")
                        : "No sub-reasons"}
                    </div>
                  </div>
                  <div className="rsn-row__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => moveReason(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      aria-label="Move down"
                      disabled={index === chosen.length - 1}
                      onClick={() => moveReason(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      aria-label={`Remove ${r.label}`}
                      onClick={() =>
                        patchGroup({ reasonIds: editing.reasonIds.filter((id) => id !== r.id) })
                      }
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="panel">
            <h2>Randomize reasons</h2>
            <label className="check-list__item">
              <input
                type="checkbox"
                checked={editing.randomizeOrder}
                onChange={(e) => patchGroup({ randomizeOrder: e.target.checked })}
              />
              <span className="radio-list__label">Show return reasons in random order to customers</span>
            </label>
          </div>

          {editing.id && !editing.isDefault && (
            <div className="panel">
              <h2 style={{ marginBottom: 4 }}>Delete this group</h2>
              <p className="settings-row__hint" style={{ marginBottom: 12 }}>
                Products it claimed use the default group's reasons instead.
                The reasons themselves stay in your library.
              </p>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove()}>
                Delete group
              </button>
            </div>
          )}
        </div>

        {picking && (
          <LibraryPicker
            library={library}
            selected={editing.reasonIds}
            onClose={() => setPicking(false)}
            onConfirm={(reasonIds) => {
              patchGroup({ reasonIds });
              setPicking(false);
            }}
          />
        )}
        {bar}
      </>
    );
  }

  return (
    <>
      {header(editing.id ? "Edit reason" : "Create reason")}
      <ErrorAlert message={error} />

      <div className="settings-form rform">
        <div className="panel">
          <h2>Reason name</h2>
          <Counted
            value={editing.label}
            max={NAME_MAX}
            label="Reason name"
            onChange={(label) => patchReason({ label })}
          />
        </div>

        <div className="panel">
          <div className="panel__head">
            <h2>Sub-reasons</h2>
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                setSub({
                  index: null,
                  draft: {
                    id: null,
                    label: "",
                    code: editing.code,
                    requiresNote: false,
                    requiresPhoto: false,
                  },
                })
              }
            >
              Add sub-reason
            </button>
          </div>
          {editing.children.length === 0 ? (
            <div className="rsn-empty">
              <h3>No sub-reason</h3>
              <p>Add sub-reason to get more accurate feedback from your customers.</p>
            </div>
          ) : (
            editing.children.map((c, index) => (
              <div key={c.id ?? `new-${index}`} className="rsn-row">
                <div className="rsn-row__body">
                  <div className="rsn-row__title">{c.label}</div>
                  <div className="rsn-row__hint">
                    Reports to Shopify as {c.code}
                    {c.requiresNote && " · Additional details"}
                    {c.requiresPhoto && " · Image upload"}
                  </div>
                </div>
                <div className="rsn-row__actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => setSub({ index, draft: { ...c } })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    aria-label={`Remove ${c.label}`}
                    onClick={() =>
                      patchReason({ children: editing.children.filter((_, i) => i !== index) })
                    }
                  >
                    ×
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <h2>Detailed information</h2>
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={editing.requiresNote}
              onChange={(e) => patchReason({ requiresNote: e.target.checked })}
            />
            <span>
              <span className="radio-list__label">Additional details</span>
              <span className="radio-list__hint">
                Customers must explain in their own words before continuing.
              </span>
            </span>
          </label>
          <label className="check-list__item">
            <input
              type="checkbox"
              checked={editing.requiresPhoto}
              onChange={(e) => patchReason({ requiresPhoto: e.target.checked })}
            />
            <span>
              <span className="radio-list__label">Image upload</span>
              <span className="radio-list__hint">
                Customers can't upload photos in the portal yet, so this is
                saved but not asked for.
              </span>
            </span>
          </label>
        </div>

        <div className="panel">
          <h2>Shopify return reason</h2>
          <select
            className="settings-input"
            value={editing.code}
            aria-label="Shopify return reason"
            onChange={(e) => patchReason({ code: e.target.value })}
          >
            {shopifyCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p className="settings-row__hint" style={{ marginTop: 8 }}>
            How this reason is recorded on the return in Shopify. Customers
            never see it, and several reasons can share one.
          </p>
        </div>

        {editing.id && (
          <div className="panel">
            <h2 style={{ marginBottom: 4 }}>Delete this reason</h2>
            <p className="settings-row__hint" style={{ marginBottom: 12 }}>
              It's removed from every group. If past returns used it, it's
              kept for their history but no longer offered.
            </p>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove()}>
              Delete reason
            </button>
          </div>
        )}
      </div>

      {sub && (
        <SubReasonModal
          initial={sub.draft}
          codes={shopifyCodes}
          onClose={() => setSub(null)}
          onSave={(draft) => {
            const children = [...editing.children];
            if (sub.index === null) children.push(draft);
            else children[sub.index] = draft;
            patchReason({ children });
            setSub(null);
          }}
        />
      )}
      {bar}
    </>
  );
}
