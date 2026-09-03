import { useEffect, useState } from "react";
import { useBlocker } from "react-router";
import { api } from "../lib/api";
import { ErrorAlert, Loading } from "../components/Feedback";
import type { NotificationSettings } from "../lib/types";

/** Blank means "no reply address", which is a real answer rather than an error. */
const cleanEmail = (raw: string): string | null => raw.trim() || null;

export default function NotificationsPage() {
  const [saved, setSaved] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /**
   * Edits held apart from what the server confirmed, the same way the rest of
   * settings works: a switch that writes the moment it moves gives a merchant
   * no way to change their mind, and no moment where they know it took.
   */
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [senderName, setSenderName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  useEffect(() => {
    let active = true;
    api
      .get<NotificationSettings>("/admin/settings/notifications", {
        auth: "admin",
      })
      .then((data) => {
        if (!active) return;
        setSaved(data);
        setSenderName(data.sender.name);
        setReplyTo(data.sender.replyTo ?? "");
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  /** What the screen shows: the saved answer with any unsaved change on top. */
  const enabledFor = (kind: string, fallback: boolean) =>
    toggles[kind] ?? fallback;

  const changedToggles = (saved?.notifications ?? []).filter(
    (n) => enabledFor(n.kind, n.enabled) !== n.enabled,
  );
  const nameEdited =
    saved !== null && senderName.trim() !== saved.sender.name;
  const replyEdited =
    saved !== null && cleanEmail(replyTo) !== saved.sender.replyTo;
  const dirty =
    changedToggles.length > 0 || nameEdited || replyEdited;

  const blocker = useBlocker(dirty);

  const discard = () => {
    setToggles({});
    setSenderName(saved?.sender.name ?? "");
    setReplyTo(saved?.sender.replyTo ?? "");
    setError(null);
    setStatus(null);
  };

  const save = async () => {
    if (!saved || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {};
      if (changedToggles.length > 0) {
        body.notifications = changedToggles.map((n) => ({
          kind: n.kind,
          enabled: enabledFor(n.kind, n.enabled),
        }));
      }
      // Sent as null rather than "" so the server can tell "use the store's
      // name" from a store that renamed itself to nothing.
      if (nameEdited) body.senderName = senderName.trim() || null;
      if (replyEdited) body.replyTo = cleanEmail(replyTo);

      const next = await api.patch<NotificationSettings>(
        "/admin/settings/notifications",
        body,
        { auth: "admin" },
      );
      setSaved(next);
      setToggles({});
      setSenderName(next.sender.name);
      setReplyTo(next.sender.replyTo ?? "");
      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;
  if (!saved) {
    return (
      <>
        <h1>Notifications</h1>
        <ErrorAlert message={error ?? "Couldn't load your notifications."} />
      </>
    );
  }

  const offCount = saved.notifications.filter(
    (n) => !enabledFor(n.kind, n.enabled),
  ).length;

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Notifications</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            The emails your customers get as their return moves along, and who
            they come from.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      <div className="settings-form">
        <div className="panel">
          <h2>Sender</h2>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Name</div>
              <div className="settings-row__hint">
                What customers see in their inbox. Leave it empty to use your
                store's name.
              </div>
            </div>
            <input
              type="text"
              className="settings-input"
              value={senderName}
              placeholder={saved.sender.name}
              maxLength={80}
              onChange={(e) => {
                setStatus(null);
                setSenderName(e.target.value);
              }}
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Email address</div>
              {/*
                Not editable, and the reason is worth stating rather than
                leaving the field mysteriously greyed out: mail claiming to come
                from a domain this app holds no signing key for is rejected or
                filed as spam by every major provider. Sending on the store's
                own domain needs that domain verified first.
              */}
              <div className="settings-row__hint">
                Sent from our verified address so it reaches inboxes rather than
                spam folders. Sending from your own domain needs it verified
                first — replies still come to you.
              </div>
            </div>
            <input
              type="text"
              className="settings-input"
              value={saved.sender.address}
              readOnly
              disabled
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Replies go to</div>
              <div className="settings-row__hint">
                Where a customer's reply lands. This is the same support address
                shown on your returns page.
              </div>
            </div>
            <input
              type="email"
              className="settings-input"
              value={replyTo}
              placeholder="help@yourstore.com"
              onChange={(e) => {
                setStatus(null);
                setReplyTo(e.target.value);
              }}
            />
          </div>
        </div>

        <div className="panel">
          <h2>Customer emails</h2>
          <p className="settings-row__hint" style={{ marginBottom: 6 }}>
            {offCount === 0
              ? "Every notification is on. Turning one off stops it for future returns only."
              : `${offCount} turned off. Returns still move through every stage — the customer just isn't told about that one.`}
          </p>

          {saved.notifications.map((n) => {
            const on = enabledFor(n.kind, n.enabled);
            return (
              <div className="settings-row" key={n.kind}>
                <div>
                  <div className="settings-row__label">{n.label}</div>
                  <div className="settings-row__hint">{n.description}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={n.label}
                  className={`switch${on ? " is-on" : ""}`}
                  onClick={() => {
                    setStatus(null);
                    setToggles((prev) => ({ ...prev, [n.kind]: !on }));
                  }}
                >
                  <span className="switch__knob" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {blocker.state === "blocked" ? (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar settings-bar--warn" role="alertdialog">
            <span className="settings-bar__label">
              Leave without saving your changes?
            </span>
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
                discard();
                blocker.proceed();
              }}
            >
              Discard and leave
            </button>
          </div>
        </>
      ) : dirty ? (
        <>
          <div className="settings-bar__spacer" />
          <div className="settings-bar" role="status">
            <span className="settings-bar__label">Unsaved changes</span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={discard}
              disabled={saving}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
