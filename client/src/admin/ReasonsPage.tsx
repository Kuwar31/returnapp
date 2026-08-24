import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ErrorAlert, Loading } from "../components/Feedback";

/**
 * A reason as the merchant edits it — carries the Shopify `code` the shopper
 * never sees, plus the nesting.
 */
interface AdminReason {
  id: string;
  code: string;
  label: string;
  requiresNote: boolean;
  requiresPhoto: boolean;
  active: boolean;
  sortOrder: number;
  children?: AdminReason[];
}

interface AdminGroup {
  id: string;
  title: string;
  productTypes: string[];
  randomizeOrder: boolean;
  isDefault: boolean;
  reasons: AdminReason[];
}

interface Payload {
  groups: AdminGroup[];
  shopifyCodes: string[];
}

/** A row in the reason tree: parent or child, editable in place. */
function ReasonRow({
  reason,
  codes,
  depth,
  busy,
  onSave,
  onDelete,
  onAddChild,
}: {
  reason: AdminReason;
  codes: string[];
  depth: number;
  busy: boolean;
  onSave: (patch: Partial<AdminReason>) => void;
  onDelete: () => void;
  onAddChild?: () => void;
}) {
  const [label, setLabel] = useState(reason.label);
  const dirty = label.trim() !== reason.label;

  return (
    <div className={`rz rz--d${depth}${reason.active ? "" : " rz--off"}`}>
      <input
        className="rz__label"
        value={label}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => dirty && label.trim() && onSave({ label: label.trim() })}
      />

      {/*
        The Shopify code is the merchant's mapping for reporting, not the
        shopper's wording — several reasons can share one, which is why this is
        a separate field rather than derived from the label.
      */}
      <select
        className="rz__code"
        value={reason.code}
        disabled={busy}
        onChange={(e) => onSave({ code: e.target.value })}
        title="How this reports to Shopify"
      >
        {codes.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <label className="rz__flag" title="Shopper must explain">
        <input
          type="checkbox"
          checked={reason.requiresNote}
          disabled={busy}
          onChange={(e) => onSave({ requiresNote: e.target.checked })}
        />
        Note
      </label>
      <label className="rz__flag" title="Shopper must upload a photo">
        <input
          type="checkbox"
          checked={reason.requiresPhoto}
          disabled={busy}
          onChange={(e) => onSave({ requiresPhoto: e.target.checked })}
        />
        Photo
      </label>
      <label className="rz__flag" title="Offer this reason in the portal">
        <input
          type="checkbox"
          checked={reason.active}
          disabled={busy}
          onChange={(e) => onSave({ active: e.target.checked })}
        />
        Live
      </label>

      <div className="rz__actions">
        {onAddChild && (
          <button className="linkish" disabled={busy} onClick={onAddChild}>
            + Sub-reason
          </button>
        )}
        <button className="linkish rz__del" disabled={busy} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

export default function ReasonsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<Payload>("/admin/settings/reason-groups", { auth: "admin" })
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  /** Every mutation reloads the tree — it's one small payload, and it keeps
      parent/child ordering authoritative on the server. */
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return error ? <ErrorAlert message={error} /> : <Loading />;
  }

  const codes = data.shopifyCodes;

  return (
    <>
      <div className="admin__header">
        <div>
          <h1>Return reasons</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            What shoppers pick from when they start a return. Group reasons by
            product type when different ranges need different wording.
          </p>
        </div>
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => {
            const title = window.prompt("Name this group (staff only)");
            if (!title?.trim()) return;
            void run(
              () =>
                api.post(
                  "/admin/settings/reason-groups",
                  { title: title.trim() },
                  { auth: "admin" },
                ),
              "Group created.",
            );
          }}
        >
          Add group
        </button>
      </div>

      <ErrorAlert message={error} />
      {notice && <div className="alert alert--success">{notice}</div>}

      {data.groups.map((group) => (
        <div className="panel" key={group.id}>
          <div className="panel__head">
            <h2>
              {group.title}
              {group.isDefault && <span className="chip rz__chip">Default</span>}
            </h2>
            {!group.isDefault && (
              <button
                className="linkish rz__del"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete "${group.title}" and its reasons?`))
                    return;
                  void run(
                    () =>
                      api.delete(`/admin/settings/reason-groups/${group.id}`, {
                        auth: "admin",
                      }),
                    "Group deleted.",
                  );
                }}
              >
                Delete group
              </button>
            )}
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Associated product types</div>
              <div className="settings-row__hint">
                {group.isDefault
                  ? "Any product no other group claims uses this group."
                  : "Comma-separated Shopify product types, e.g. Footwear, Outerwear."}
              </div>
            </div>
            <input
              type="text"
              defaultValue={group.productTypes.join(", ")}
              disabled={busy}
              placeholder="Footwear, Outerwear"
              onBlur={(e) => {
                const next = e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
                if (next.join("|") === group.productTypes.join("|")) return;
                void run(() =>
                  api.patch(
                    `/admin/settings/reason-groups/${group.id}`,
                    { productTypes: next },
                    { auth: "admin" },
                  ),
                );
              }}
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Randomise reason order</div>
              <div className="settings-row__hint">
                Shuffles the top-level reasons per shopper, so the first option
                stops absorbing every ambiguous return.
              </div>
            </div>
            <input
              type="checkbox"
              checked={group.randomizeOrder}
              disabled={busy}
              onChange={(e) =>
                void run(() =>
                  api.patch(
                    `/admin/settings/reason-groups/${group.id}`,
                    { randomizeOrder: e.target.checked },
                    { auth: "admin" },
                  ),
                )
              }
            />
          </div>

          <h3 className="rz__heading">Reasons</h3>
          <div className="rz__legend">
            <span>Wording the shopper sees</span>
            <span>Reports to Shopify as</span>
          </div>

          {group.reasons.map((parent) => (
            <div key={parent.id}>
              <ReasonRow
                reason={parent}
                codes={codes}
                depth={0}
                busy={busy}
                onSave={(patch) =>
                  void run(() =>
                    api.patch(`/admin/settings/reasons/${parent.id}`, patch, {
                      auth: "admin",
                    }),
                  )
                }
                onDelete={() =>
                  void run(async () => {
                    const res = await api.delete<{ retired: boolean }>(
                      `/admin/settings/reasons/${parent.id}`,
                      { auth: "admin" },
                    );
                    if (res?.retired) {
                      setNotice(
                        "That reason is used by past returns, so it was switched off rather than deleted.",
                      );
                    }
                  })
                }
                onAddChild={() => {
                  const label = window.prompt("Sub-reason wording");
                  if (!label?.trim()) return;
                  void run(() =>
                    api.post(
                      "/admin/settings/reasons",
                      {
                        groupId: group.id,
                        parentId: parent.id,
                        code: parent.code,
                        label: label.trim(),
                      },
                      { auth: "admin" },
                    ),
                  );
                }}
              />
              {(parent.children ?? []).map((child) => (
                <ReasonRow
                  key={child.id}
                  reason={child}
                  codes={codes}
                  depth={1}
                  busy={busy}
                  onSave={(patch) =>
                    void run(() =>
                      api.patch(`/admin/settings/reasons/${child.id}`, patch, {
                        auth: "admin",
                      }),
                    )
                  }
                  onDelete={() =>
                    void run(async () => {
                      const res = await api.delete<{ retired: boolean }>(
                        `/admin/settings/reasons/${child.id}`,
                        { auth: "admin" },
                      );
                      if (res?.retired) {
                        setNotice(
                          "That reason is used by past returns, so it was switched off rather than deleted.",
                        );
                      }
                    })
                  }
                />
              ))}
            </div>
          ))}

          <button
            className="btn btn--secondary btn--sm"
            style={{ marginTop: 14 }}
            disabled={busy}
            onClick={() => {
              const label = window.prompt("Reason wording");
              if (!label?.trim()) return;
              void run(() =>
                api.post(
                  "/admin/settings/reasons",
                  { groupId: group.id, code: "OTHER", label: label.trim() },
                  { auth: "admin" },
                ),
              );
            }}
          >
            Add reason
          </button>
        </div>
      ))}
    </>
  );
}
