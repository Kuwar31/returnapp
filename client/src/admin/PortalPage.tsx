import { useEffect, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { api } from "../lib/api";
import { CopyLink } from "../components/CopyLink";
import { ErrorAlert, Loading } from "../components/Feedback";
import { ensureFontsLoaded, FONTS, fontStack, RADIUS_PX } from "../lib/fonts";
import { LOCALES, localeDir, makeTranslator } from "../lib/i18n";
import { lookupFieldLabel } from "../lib/lookup";
import type {
  LookupCriterion,
  PortalBranding,
  StoreSettings,
} from "../lib/types";
import { useAuth } from "./AuthContext";

/**
 * A row of the settings form, matching the shape the other settings pages use
 * so this page doesn't read as a different app.
 */
function Row({
  label,
  hint,
  stacked = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** The control drops under the description instead of beside it. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`settings-row${stacked ? " settings-row--stacked" : ""}`}>
      <div>
        <div className="settings-row__label">{label}</div>
        {hint && <div className="settings-row__hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * A colour, as a swatch that opens the browser's own picker with the hex
 * beside it.
 *
 * Both, because they answer different questions: the swatch is how you choose
 * one, and the hex is how you match a colour you already have written down in
 * a brand guide.
 */
function ColorField({
  value,
  onChange,
  fallback,
}: {
  value: string | null;
  onChange: (next: string) => void;
  /** Shown when the field is unset — the colour that actually applies. */
  fallback?: string;
}) {
  return (
    <div className="color-field">
      <input
        type="color"
        aria-label="Colour"
        value={value ?? fallback ?? "#000000"}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        className="color-field__hex"
        value={value ?? ""}
        placeholder={fallback ?? "#000000"}
        maxLength={7}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * The ways a shopper can prove an order is theirs, as the merchant picks
 * them. Email first because it is what every store starts with.
 */
const CRITERIA: Array<{
  key: LookupCriterion;
  label: string;
  hint: string;
}> = [
  {
    key: "EMAIL",
    label: "Email address",
    hint: "The address on the order.",
  },
  {
    key: "ZIP",
    label: "Zip / postal code",
    hint: "The postal code of the shipping address.",
  },
  {
    key: "PHONE",
    label: "Phone number",
    hint: "Shopify only shares phone numbers with apps it has approved for them. Turning this on checks, and tells you if that approval is missing.",
  },
];

/**
 * What the shopper sees, rendered from the same tokens the portal reads.
 *
 * Not an iframe of the real portal: that would need a saved store to point at,
 * so nothing could be previewed until it had already been published. This
 * renders the lookup screen — the one every customer starts on — from the
 * unsaved values directly.
 */
function Preview({ b, storeName }: { b: PortalBranding; storeName: string }) {
  const radius = RADIUS_PX[b.cornerRadius] ?? RADIUS_PX.CURVED;
  const light = b.textTone === "LIGHT";
  // The app's own strings in the chosen language, so switching it shows.
  const t = makeTranslator(b.locale);
  return (
    <div
      className="pv"
      lang={b.locale}
      dir={localeDir(b.locale)}
      style={{
        background: b.backgroundColor,
        ...(b.heroImageUrl
          ? {
              backgroundImage: `linear-gradient(rgba(0,0,0,.15), rgba(0,0,0,.15)), url("${b.heroImageUrl}")`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : {}),
      }}
    >
      <div className="pv__head" style={{ color: light ? "#fff" : b.headingColor }}>
        {b.logoUrl ? (
          <img src={b.logoUrl} alt="" style={{ width: Math.min(b.logoWidth, 220) }} />
        ) : (
          <div className="pv__store">{storeName}</div>
        )}
        <div
          className="pv__headline"
          style={{ fontFamily: fontStack(b.headingFont) }}
        >
          {b.headline}
        </div>
        <div
          className="pv__sub"
          style={{
            fontFamily: fontStack(b.bodyFont),
            color: light ? "rgba(255,255,255,.85)" : b.bodyColor,
          }}
        >
          {b.subheadline}
        </div>
      </div>

      <div
        className="pv__card"
        style={{ borderRadius: radius, fontFamily: fontStack(b.bodyFont) }}
      >
        {b.lightLogoUrl && (
          <img className="pv__card-logo" src={b.lightLogoUrl} alt="" />
        )}
        <div
          className="pv__card-title"
          style={{ fontFamily: fontStack(b.headingFont), color: b.headingColor }}
        >
          {t("lookup.title")}
        </div>
        <div className="pv__label" style={{ color: b.bodyColor }}>
          {b.orderNumberLabel}
        </div>
        <div className="pv__input" />
        <div className="pv__label" style={{ color: b.bodyColor }}>
          {lookupFieldLabel(b, b.locale)}
        </div>
        <div className="pv__input" />
        {b.lookupHelpText && (
          <div className="pv__help" style={{ color: b.bodyColor }}>
            {b.lookupHelpText}
          </div>
        )}
        <div
          className="pv__btn"
          style={{
            background: b.buttonColor ?? b.accentColor,
            color: b.buttonTextColor,
            borderRadius: b.cornerRadius === "SHARP" ? 0 : 8,
          }}
        >
          {b.startButtonLabel}
        </div>
      </div>

      {/* The suggestion tint, which has nowhere else to be seen. */}
      <div
        className="pv__hint"
        style={{
          borderRadius: b.cornerRadius === "SHARP" ? 0 : 8,
          color: b.suggestionColor,
          background: `color-mix(in srgb, ${b.suggestionColor} 12%, #fff)`,
          fontFamily: fontStack(b.bodyFont),
        }}
      >
        ✦ Based on your reason, we suggest sizing up.
      </div>

      <div
        className="pv__foot"
        style={{
          color: light ? "rgba(255,255,255,.8)" : b.bodyColor,
          fontFamily: fontStack(b.bodyFont),
        }}
      >
        {b.footerHeading && <strong>{b.footerHeading}</strong>}
        <div>
          {b.footerText
            ? b.footerText.replace(/\{\{\s*link\s*\}\}/g, b.supportEmail ?? "")
            : (b.supportEmail ?? storeName)}
        </div>
      </div>
    </div>
  );
}

export default function PortalPage() {
  const { session } = useAuth();
  const [saved, setSaved] = useState<PortalBranding | null>(null);
  const [edits, setEdits] = useState<Partial<PortalBranding>>({});
  const [store, setStore] = useState<StoreSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<PortalBranding>("/admin/settings/branding", { auth: "admin" })
      .then((b) => active && setSaved(b))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    api
      .get<StoreSettings>("/admin/settings/store", { auth: "admin" })
      .then((s) => active && setStore(s))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  /** What the screen shows: what was saved, with anything unsaved on top. */
  const b = saved ? { ...saved, ...edits } : null;
  const dirty = Object.keys(edits).length > 0;
  const blocker = useBlocker(dirty);

  // Preview a Google face as soon as it's chosen, not once it's saved.
  useEffect(() => {
    if (b) ensureFontsLoaded([b.headingFont, b.bodyFont]);
  }, [b?.headingFont, b?.bodyFont]);

  const set = <K extends keyof PortalBranding>(
    key: K,
    value: PortalBranding[K],
  ) => {
    setStatus(null);
    setEdits((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (!saved || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      /**
       * The whole object, not just the edits: this endpoint is a PUT, and the
       * fields validate against each other's presence — sending a partial
       * would have the server fill the gaps with defaults the merchant never
       * chose.
       */
      const next = await api.put<PortalBranding>(
        "/admin/settings/branding",
        { ...saved, ...edits },
        { auth: "admin" },
      );
      setSaved(next);
      setEdits({});
      setStatus("Saved. Your portal is updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;
  if (!b) {
    return (
      <>
        <h1>Portal</h1>
        <ErrorAlert message={error ?? "Couldn't load your portal settings."} />
      </>
    );
  }

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>Portal</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            How your returns page looks and reads to a customer.
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      <div className="portal-settings">
        <div className="settings-form">
          <div className="panel">
            <h2>Where it lives</h2>
            <CopyLink
              url={store?.portalUrl ?? session?.merchant.portalUrl ?? ""}
              label="Returns page"
            />
            {store?.storefrontUrl && (
              <div style={{ marginTop: 18 }}>
                <CopyLink url={store.storefrontUrl} label="On your storefront" />
                <p className="settings-row__hint" style={{ marginTop: 8 }}>
                  Add this to your store's navigation and the returns page opens
                  inside your own theme, on your own domain.
                </p>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Language</h2>
            <Row
              label="Portal language"
              hint="Every word the app supplies — buttons, prompts, status messages, and how dates and money are formatted. The heading, field labels and footer below stay exactly as you write them, in whatever language you write them."
            >
              <select
                value={b.locale}
                onChange={(e) => set("locale", e.target.value)}
              >
                {LOCALES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                    {l.label === l.english ? "" : ` — ${l.english}`}
                  </option>
                ))}
              </select>
            </Row>
          </div>

          <div className="panel">
            <h2>Theme</h2>
            <Row
              label="Text"
              hint="Dark for a pale background, light for a dark one. This is the header and footer — cards stay white, so their text stays dark."
            >
              <select
                value={b.textTone}
                onChange={(e) =>
                  set("textTone", e.target.value as PortalBranding["textTone"])
                }
              >
                <option value="DARK">Dark</option>
                <option value="LIGHT">Light</option>
              </select>
            </Row>
            <Row label="Corner radius" hint="How rounded the cards are.">
              <select
                value={b.cornerRadius}
                onChange={(e) =>
                  set(
                    "cornerRadius",
                    e.target.value as PortalBranding["cornerRadius"],
                  )
                }
              >
                <option value="SHARP">Sharp</option>
                <option value="CURVED">Curved</option>
                <option value="ROUNDED">Rounded</option>
              </select>
            </Row>
            <Row label="Accent colour" hint="Links, selected options and the default button.">
              <ColorField
                value={b.accentColor}
                onChange={(v) => set("accentColor", v)}
              />
            </Row>
            <Row label="Background colour">
              <ColorField
                value={b.backgroundColor}
                onChange={(v) => set("backgroundColor", v)}
              />
            </Row>
            <Row
              label="Background image"
              hint="Overrides the background colour. Leave it empty and we'll borrow a photo from your catalogue."
            >
              <input
                type="text"
                className="settings-input"
                value={b.heroImageUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => set("heroImageUrl", e.target.value || null)}
              />
            </Row>
          </div>

          <div className="panel">
            <h2>Branding</h2>
            <Row
              label="Logo"
              hint="Sits above the heading, over your background. Make sure it reads against it."
            >
              <input
                type="text"
                className="settings-input"
                value={b.logoUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => set("logoUrl", e.target.value || null)}
              />
            </Row>
            <Row label="Logo width" hint="In pixels. The height follows.">
              <input
                type="number"
                min={60}
                max={480}
                value={b.logoWidth}
                onChange={(e) => set("logoWidth", Number(e.target.value))}
              />
            </Row>
            <Row
              label="Logo for white cards"
              hint="Used on the lookup card, where a pale wordmark would disappear. Leave empty to show none."
            >
              <input
                type="text"
                className="settings-input"
                value={b.lightLogoUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => set("lightLogoUrl", e.target.value || null)}
              />
            </Row>
            <Row label="Favicon" hint="The icon in the browser tab. 64×64 works well.">
              <input
                type="text"
                className="settings-input"
                value={b.faviconUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => set("faviconUrl", e.target.value || null)}
              />
            </Row>
            <Row label="Heading font">
              <select
                value={b.headingFont}
                onChange={(e) => set("headingFont", e.target.value)}
              >
                {FONTS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="Heading colour"
              hint="Headings inside the white cards. The heading over your background follows the Text setting above, so this one wants to be dark."
            >
              <ColorField
                value={b.headingColor}
                onChange={(v) => set("headingColor", v)}
              />
            </Row>
            <Row label="Body font">
              <select
                value={b.bodyFont}
                onChange={(e) => set("bodyFont", e.target.value)}
              >
                {FONTS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="Body colour"
              hint="Labels and secondary text inside the cards."
            >
              <ColorField
                value={b.bodyColor}
                onChange={(v) => set("bodyColor", v)}
              />
            </Row>
            <Row
              label="Button colour"
              hint="Leave empty to use your accent colour."
            >
              <ColorField
                value={b.buttonColor}
                fallback={b.accentColor}
                onChange={(v) => set("buttonColor", v || null)}
              />
            </Row>
            <Row label="Button text colour">
              <ColorField
                value={b.buttonTextColor}
                onChange={(v) => set("buttonTextColor", v)}
              />
            </Row>
            <Row
              label="Suggestion colour"
              hint="The tint on the “we suggest sizing up” note when a shopper picks a fit reason."
            >
              <ColorField
                value={b.suggestionColor}
                onChange={(v) => set("suggestionColor", v)}
              />
            </Row>
          </div>

          <div className="panel">
            <h2>Order lookup</h2>
            <Row
              label="Verify customers with"
              hint="What a shopper enters beside their order number to prove it's theirs. Most stores pick one. Tick several and the portal shows one field that accepts any of them."
              stacked
            >
              <div className="criteria">
                {CRITERIA.map(({ key, label, hint }) => {
                  const on = b.lookupCriteria.includes(key);
                  // The last one ticked stays: without any, nobody gets in.
                  const last = on && b.lookupCriteria.length === 1;
                  return (
                    <label
                      key={key}
                      className="criteria__item"
                      title={
                        last
                          ? "Customers need at least one way to verify their order"
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={last}
                        onChange={(e) =>
                          set(
                            "lookupCriteria",
                            e.target.checked
                              ? [...b.lookupCriteria, key]
                              : b.lookupCriteria.filter((c) => c !== key),
                          )
                        }
                      />
                      <span>
                        <span className="criteria__label">{label}</span>
                        <span className="criteria__hint">{hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </Row>
            <Row label="Order number field">
              <input
                type="text"
                className="settings-input"
                value={b.orderNumberLabel}
                onChange={(e) => set("orderNumberLabel", e.target.value)}
              />
            </Row>
            {b.lookupCriteria.includes("EMAIL") && (
              <Row label="Email field">
                <input
                  type="text"
                  className="settings-input"
                  value={b.emailLabel}
                  onChange={(e) => set("emailLabel", e.target.value)}
                />
              </Row>
            )}
            {b.lookupCriteria.includes("ZIP") && (
              <Row label="Postal code field">
                <input
                  type="text"
                  className="settings-input"
                  value={b.zipLabel}
                  onChange={(e) => set("zipLabel", e.target.value)}
                />
              </Row>
            )}
            {b.lookupCriteria.includes("PHONE") && (
              <Row label="Phone field">
                <input
                  type="text"
                  className="settings-input"
                  value={b.phoneLabel}
                  onChange={(e) => set("phoneLabel", e.target.value)}
                />
              </Row>
            )}
            <Row
              label="Help text"
              hint="Shown under the fields, for a shopper who can't find their order number."
            >
              <input
                type="text"
                className="settings-input"
                value={b.lookupHelpText ?? ""}
                placeholder="Your order number is in your confirmation email."
                onChange={(e) => set("lookupHelpText", e.target.value || null)}
              />
            </Row>
          </div>

          <div className="panel">
            <h2>Content</h2>
            <Row label="Heading">
              <input
                type="text"
                className="settings-input"
                value={b.headline}
                onChange={(e) => set("headline", e.target.value)}
              />
            </Row>
            <Row label="Subheading">
              <input
                type="text"
                className="settings-input"
                value={b.subheadline}
                onChange={(e) => set("subheadline", e.target.value)}
              />
            </Row>
            <Row label="Start button">
              <input
                type="text"
                className="settings-input"
                value={b.startButtonLabel}
                onChange={(e) => set("startButtonLabel", e.target.value)}
              />
            </Row>
            <Row label="Footer heading">
              <input
                type="text"
                className="settings-input"
                value={b.footerHeading ?? ""}
                placeholder="Questions?"
                onChange={(e) => set("footerHeading", e.target.value || null)}
              />
            </Row>
            <Row
              label="Footer text"
              hint={
                <>
                  Write <code>{"{{ link }}"}</code> where your support address
                  should appear, and it becomes a mailto link.
                </>
              }
            >
              <input
                type="text"
                className="settings-input"
                value={b.footerText ?? ""}
                placeholder="Get in touch at {{ link }}"
                onChange={(e) => set("footerText", e.target.value || null)}
              />
            </Row>
            <Row label="Support email" hint="Where “{{ link }}” points, and shown on the status page.">
              <input
                type="email"
                className="settings-input"
                value={b.supportEmail ?? ""}
                placeholder="help@yourstore.com"
                onChange={(e) => set("supportEmail", e.target.value || null)}
              />
            </Row>
            <Row label="Return policy link" hint="Linked from the portal, if you have one.">
              <input
                type="text"
                className="settings-input"
                value={b.policyUrl ?? ""}
                placeholder="https://…"
                onChange={(e) => set("policyUrl", e.target.value || null)}
              />
            </Row>
          </div>

          <div className="panel">
            <h2>Search engines</h2>
            <Row
              label="Visible to search engines"
              hint="Off asks Google and the rest not to index your returns page. It stops future crawls rather than removing what's already listed, which can take them days to drop."
            >
              <button
                type="button"
                role="switch"
                aria-checked={b.searchEngineVisible}
                aria-label="Visible to search engines"
                className={`switch${b.searchEngineVisible ? " is-on" : ""}`}
                onClick={() =>
                  set("searchEngineVisible", !b.searchEngineVisible)
                }
              >
                <span className="switch__knob" />
              </button>
            </Row>
          </div>
        </div>

        {/*
          Sticky, because the whole point is watching a colour land while you
          are still looking at the control that changed it.
        */}
        <aside className="portal-settings__preview">
          <div className="preview-frame">
            <div className="preview-frame__bar">Preview</div>
            <Preview b={b} storeName={session?.merchant.name ?? "Your store"} />
          </div>
        </aside>
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
                setEdits({});
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
              onClick={() => {
                setEdits({});
                setStatus(null);
              }}
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
