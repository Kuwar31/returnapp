import { useEffect, useState } from "react";
import { useBlocker, useLocation } from "react-router";
import type {
  DisplayCurrency,
  ExchangeMethod,
  StoreSettings,
} from "../lib/types";
import { api } from "../lib/api";
import { CopyLink } from "../components/CopyLink";
import { ErrorAlert, Loading } from "../components/Feedback";
import { ShopifyPanel } from "./ShopifyPanel";
import { useAuth } from "./AuthContext";

interface Policy {
  id: string;
  name: string;
  isDefault: boolean;
  returnWindowDays: number;
  windowStartsFrom: "ORDER_DATE" | "FULFILLMENT" | "DELIVERY";
  allowFinalSale: boolean;
  tagRulesEnabled: boolean;
  finalSaleTags: string[];
  exchangeOnlyTags: string[];
  allowRefund: boolean;
  allowStoreCredit: boolean;
  allowGiftCard: boolean;
  allowExchange: boolean;
  allowInstantExchange: boolean;
  bonusCreditPercent: number;
  restockingFeePercent: number;
  autoApprove: boolean;
  autoApproveUnder: number | null;
}

/**
 * Settings, one screen at a time.
 *
 * The same component serves all four, so the save bar, the dirty tracking and
 * the two endpoints behind them stay in one place — only the panels change.
 * Which one is showing comes from the URL rather than a piece of state, so the
 * sidebar can link straight into a section and a merchant can bookmark it.
 */
const SECTIONS = {
  general: {
    title: "General",
    blurb: "Where your customers start a return, and how amounts are shown.",
  },
  policy: {
    title: "Return policy",
    blurb: "How long customers have, what you offer them, and what it costs.",
  },
  exchanges: {
    title: "Exchanges",
    blurb: "How swaps are fulfilled, priced, and rewarded.",
  },
  "shop-now": {
    title: "Shop now",
    blurb: "Let a return become credit to spend across your catalogue.",
  },
} as const;

type Section = keyof typeof SECTIONS;

/**
 * A comma-separated tag list, as typed.
 *
 * Kept as text while the merchant is typing for the same reason the bonus is:
 * bound to an array, a trailing comma on the way to a second tag would vanish
 * under them mid-keystroke. Blanks are dropped and duplicates collapse, and
 * case is preserved — the merchant sees back exactly what they wrote, and the
 * matching lowercases both sides when it compares.
 */
const parseTags = (raw: string): string[] => [
  ...new Set(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

const sameTags = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/** Blank clears the flat bonus; anything unparseable is left as-is. */
const parseBonus = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export default function SettingsPage() {
  const { session } = useAuth();
  const { pathname } = useLocation();
  const tail = pathname.split("/settings")[1]?.replace("/", "") ?? "";
  const section: Section = tail in SECTIONS ? (tail as Section) : "general";
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /**
   * What the server last confirmed, kept apart from what the merchant has
   * typed since.
   *
   * These settings used to write themselves the moment a dropdown moved, which
   * made changing the exchange mechanism or switching shop now on indistinguish-
   * able from browsing the page. Holding the edits separately is what lets the
   * page offer a save — and a way back out of a change not yet committed.
   */
  const [savedPolicy, setSavedPolicy] = useState<Policy | null>(null);
  const [savedStore, setSavedStore] = useState<StoreSettings | null>(null);
  const [policyEdits, setPolicyEdits] = useState<Partial<Policy>>({});
  const [storeEdits, setStoreEdits] = useState<Partial<StoreSettings>>({});
  /**
   * The bonus field is text while it's being typed. Bound to a number, "1."
   * on the way to "1.5" would render back as "1" and eat the keystroke.
   */
  const [bonusText, setBonusText] = useState("");
  /** The exchange sweetener, likewise text while it's being typed. */
  const [exchangeBonusText, setExchangeBonusText] = useState("");
  /** The two tag lists, likewise. */
  const [finalSaleText, setFinalSaleText] = useState("");
  const [exchangeOnlyText, setExchangeOnlyText] = useState("");

  useEffect(() => {
    let active = true;
    api
      .get<Policy[]>("/admin/settings/policies", { auth: "admin" })
      .then((policies) => {
        if (!active) return;
        const chosen = policies.find((p) => p.isDefault) ?? policies[0] ?? null;
        setSavedPolicy(chosen);
        setFinalSaleText((chosen?.finalSaleTags ?? []).join(", "));
        setExchangeOnlyText((chosen?.exchangeOnlyTags ?? []).join(", "));
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));

    api
      .get<StoreSettings>("/admin/settings/store", { auth: "admin" })
      .then((s) => {
        if (!active) return;
        setSavedStore(s);
        setBonusText(s.shopNowBonusAmount === null ? "" : String(s.shopNowBonusAmount));
        setExchangeBonusText(
          s.exchangeBonusValue === null ? "" : String(s.exchangeBonusValue),
        );
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  /** What the screen shows: what was saved, with anything unsaved layered on. */
  const policy = savedPolicy ? { ...savedPolicy, ...policyEdits } : null;
  const store = savedStore ? { ...savedStore, ...storeEdits } : null;

  const editStore = <K extends keyof StoreSettings>(
    key: K,
    value: StoreSettings[K],
  ) => {
    setStatus(null);
    setStoreEdits((prev) => ({ ...prev, [key]: value }));
  };

  const bonusEdited =
    savedStore !== null &&
    parseBonus(bonusText) !== (savedStore.shopNowBonusAmount ?? null);
  const exchangeBonusEdited =
    savedStore !== null &&
    parseBonus(exchangeBonusText) !== (savedStore.exchangeBonusValue ?? null);

  const tagsEdited =
    savedPolicy !== null &&
    (!sameTags(parseTags(finalSaleText), savedPolicy.finalSaleTags) ||
      !sameTags(parseTags(exchangeOnlyText), savedPolicy.exchangeOnlyTags));

  const dirty =
    Object.keys(policyEdits).length > 0 ||
    Object.keys(storeEdits).length > 0 ||
    bonusEdited ||
    exchangeBonusEdited ||
    tagsEdited;

  const discard = () => {
    setPolicyEdits({});
    setStoreEdits({});
    setBonusText(
      savedStore?.shopNowBonusAmount === null || savedStore === null
        ? ""
        : String(savedStore.shopNowBonusAmount),
    );
    setExchangeBonusText(
      savedStore?.exchangeBonusValue === null || savedStore === null
        ? ""
        : String(savedStore.exchangeBonusValue),
    );
    setFinalSaleText((savedPolicy?.finalSaleTags ?? []).join(", "));
    setExchangeOnlyText((savedPolicy?.exchangeOnlyTags ?? []).join(", "));
    setError(null);
    setStatus(null);
  };

  const update = <K extends keyof Policy>(key: K, value: Policy[K]) => {
    setStatus(null);
    setPolicyEdits((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Commits everything the merchant has changed, in one go.
   *
   * Only what actually differs is sent: the two halves live behind different
   * endpoints, and a page that PATCHed both on every save would rewrite a
   * policy because someone flipped a display currency.
   */
  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!savedPolicy || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const storeBody: Record<string, unknown> = { ...storeEdits };
      if (bonusEdited) storeBody.shopNowBonusAmount = parseBonus(bonusText);
      if (exchangeBonusEdited) {
        storeBody.exchangeBonusValue = parseBonus(exchangeBonusText);
      }

      if (Object.keys(storeBody).length > 0) {
        await api.patch("/admin/settings/store", storeBody, { auth: "admin" });
        setSavedStore((prev) =>
          prev ? ({ ...prev, ...storeBody } as StoreSettings) : prev,
        );
        setStoreEdits({});
      }

      if (Object.keys(policyEdits).length > 0 || tagsEdited) {
        const { id, isDefault, ...body } = {
          ...savedPolicy,
          ...policyEdits,
          // Parsed here rather than on every keystroke, so the text the
          // merchant is mid-way through typing is never what gets stored.
          finalSaleTags: parseTags(finalSaleText),
          exchangeOnlyTags: parseTags(exchangeOnlyText),
        };
        void isDefault;
        const updated = await api.patch<Policy>(
          `/admin/settings/policies/${id}`,
          body,
          { auth: "admin" },
        );
        setSavedPolicy(updated);
        setPolicyEdits({});
        setFinalSaleText(updated.finalSaleTags.join(", "));
        setExchangeOnlyText(updated.exchangeOnlyTags.join(", "));
      }

      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Stops a half-made change from vanishing when the sidebar moves to another
   * section. Splitting settings across four screens made that easy to do by
   * accident — the save bar is visible, but so is the nav.
   */
  const blocker = useBlocker(dirty);

  if (loading) return <Loading />;
  if (!policy) {
    return (
      <>
        <h1>Settings</h1>
        <ErrorAlert message={error ?? "No return policy is configured yet."} />
      </>
    );
  }

  return (
    <>
      <div className="admin__header">
        <div>
          <div className="admin__eyebrow">Settings</div>
          <h1>{SECTIONS[section].title}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {SECTIONS[section].blurb}
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      {section === "general" && (
      <div className="settings-form">
        {/*
          The portal address comes from the server rather than being built from
          this page's own origin: the admin and the portal are separate
          deployments, so what the merchant is looking at isn't necessarily
          where their customers should be sent.
        */}
        <div className="panel">
          <h2>Portal link</h2>
          <p className="settings-row__hint" style={{ marginBottom: 14 }}>
            Where your customers start a return. Add it to your site footer,
            your returns policy, or your order confirmation emails.
          </p>
          <CopyLink
            url={store?.portalUrl ?? session?.merchant.portalUrl ?? ""}
            label="Returns page"
          />

          {/*
            The same portal through Shopify's app proxy. Offered second because
            it only works once a store is connected, but it's the one most
            merchants want: it opens on their own domain, inside their own
            theme, so the shopper never appears to leave the shop.
          */}
          {store?.storefrontUrl && (
            <div style={{ marginTop: 18 }}>
              <CopyLink url={store.storefrontUrl} label="On your storefront" />
              <p className="settings-row__hint" style={{ marginTop: 8 }}>
                Add this one to your store's navigation or footer and the
                returns page opens inside your theme, on your own domain.
              </p>
            </div>
          )}
        </div>

        <ShopifyPanel />
      </div>
      )}

      {store && section === "general" && (
        <div className="settings-form">
          <div className="panel">
            <h2>Display currency</h2>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Show amounts in</div>
                <div className="settings-row__hint">
                  Changes what's displayed, not what's stored — every figure is
                  kept and calculated in {store.currency}. Converting uses each
                  order's own rate, so amounts match what that customer was
                  actually charged.
                </div>
              </div>
              <select
                value={store.displayCurrency}
                onChange={(e) =>
                  editStore("displayCurrency", e.target.value as DisplayCurrency)
                }
              >
                <option value="SHOP">{store.currency} — shop currency</option>
                <option value="PRESENTMENT">
                  {store.presentmentCurrency
                    ? `${store.presentmentCurrency} — as charged`
                    : "As charged to the customer"}
                </option>
              </select>
            </div>
            {!store.presentmentCurrency && (
              <p className="muted" style={{ fontSize: 13 }}>
                No order has a second currency yet, so both options will look
                the same until one does.
              </p>
            )}
          </div>
        </div>
      )}

      {store && section === "exchanges" && (
        <div className="settings-form">
          <div className="panel">
            <h2>Exchanges</h2>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Fulfil exchanges by</div>
                <div className="settings-row__hint">
                  Neither option is strictly better. A draft order reserves the
                  replacement the moment you approve, so a popular size can't
                  sell out while the parcel is coming back — but it's a second
                  order, so it won't net against the original in Shopify's
                  reporting. Adding to the original order reports correctly and
                  lets Shopify hold fulfilment until any balance is paid, but
                  nothing is reserved until you process the return.
                </div>
              </div>
              <select
                value={store.exchangeMethod}
                onChange={(e) =>
                  editStore("exchangeMethod", e.target.value as ExchangeMethod)
                }
              >
                <option value="DRAFT_ORDER">
                  A draft order — reserves stock
                </option>
                <option value="SHOPIFY_NATIVE">
                  The original order — reports cleanly
                </option>
              </select>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              Applies to exchanges approved from now on. Returns already
              approved keep the method they were created with.
            </p>
          </div>

          <div className="panel">
            <h2>Variant exchange price differences</h2>
            <p className="settings-row__hint" style={{ marginBottom: 14 }}>
              What to do when a size swap isn't worth exactly what came back.
              Often the gap isn't a real price difference: the original was
              charged at that order's exchange rate while your catalogue is
              priced at today's, so the same item in another size can look worth
              a little more or less than itself. This doesn't affect Shop now.
            </p>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Price differences</div>
                <div className="settings-row__hint">
                  {store.variantExchangeDifference === "SAME_PRICE_ONLY" &&
                    "Only options of equal value are offered, so no gap can arise."}
                  {store.variantExchangeDifference === "CHARGE" &&
                    "The customer pays what's owed, or is credited what's left over."}
                  {store.variantExchangeDifference === "ABSORB" &&
                    "You cover the gap either way — the customer pays nothing and is owed nothing."}
                </div>
              </div>
              <select
                value={store.variantExchangeDifference}
                onChange={(e) =>
                  editStore(
                    "variantExchangeDifference",
                    e.target.value as StoreSettings["variantExchangeDifference"],
                  )
                }
              >
                <option value="SAME_PRICE_ONLY">Same price only</option>
                <option value="CHARGE">Charge the difference</option>
                <option value="ABSORB">Absorb the difference</option>
              </select>
            </div>
          </div>

          <div className="panel">
            <h2>Exchange bonus</h2>
            <p className="settings-row__hint" style={{ marginBottom: 14 }}>
              A sweetener for exchanging rather than taking the money — size
              swaps and your advanced exchange lists alike. A flat amount is
              added once per return, not once per item.
            </p>
            <div className="settings-row">
              <div>
                <div className="settings-row__label">Bonus</div>
                <div className="settings-row__hint">
                  Leave empty to use the {policy.bonusCreditPercent}% credit
                  bonus from your return policy.
                </div>
              </div>
              <div className="bonus-field">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={exchangeBonusText}
                  placeholder="Policy default"
                  onChange={(e) => {
                    setStatus(null);
                    setExchangeBonusText(e.target.value);
                  }}
                />
                <select
                  value={store.exchangeBonusType}
                  onChange={(e) =>
                    editStore(
                      "exchangeBonusType",
                      e.target.value as StoreSettings["exchangeBonusType"],
                    )
                  }
                >
                  <option value="PERCENT">%</option>
                  <option value="FIXED">{store.currency}</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {store && section === "shop-now" && (
        <div className="settings-form">
          <div className="panel">
            <h2>Shop now</h2>
            <p className="settings-row__hint" style={{ marginBottom: 14 }}>
              Instead of swapping one item for another, the customer's whole
              return value becomes credit to spend across your catalogue. A
              refund pays money out; this keeps it in the store.
            </p>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">Offer shop now</div>
                <div className="settings-row__hint">
                  Adds a "spend it with us" option wherever a refund is offered.
                </div>
              </div>
              <select
                value={store.shopNowEnabled ? "on" : "off"}
                onChange={(e) =>
                  editStore("shopNowEnabled", e.target.value === "on")
                }
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </div>

            {store.shopNowEnabled && (
              <>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Where they shop</div>
                    <div className="settings-row__hint">
                      On the returns page they browse a simple catalogue and
                      never leave. On your storefront they get your real product
                      pages, with a bar along the bottom showing their credit —
                      that one needs the <strong>Shop with return credit</strong>{" "}
                      app embed switched on in your theme.
                    </div>
                  </div>
                  <select
                    value={store.shopNowMode}
                    onChange={(e) =>
                      editStore(
                        "shopNowMode",
                        e.target.value as StoreSettings["shopNowMode"],
                      )
                    }
                  >
                    <option value="RETURNS_PAGE">On the returns page</option>
                    <option value="STOREFRONT">On my storefront</option>
                  </select>
                </div>

                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">Extra credit</div>
                    <div className="settings-row__hint">
                      A bonus for spending it with you rather than taking the
                      money, added once per return. Leave empty for none.
                    </div>
                  </div>
                  <div className="bonus-field">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={bonusText}
                      placeholder="0.00"
                      onChange={(e) => {
                        setStatus(null);
                        setBonusText(e.target.value);
                      }}
                    />
                    <select
                      value={store.shopNowBonusType}
                      onChange={(e) =>
                        editStore(
                          "shopNowBonusType",
                          e.target.value as StoreSettings["shopNowBonusType"],
                        )
                      }
                    >
                      <option value="FIXED">{store.currency}</option>
                      <option value="PERCENT">%</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {section === "policy" && (
      <form className="settings-form" onSubmit={save}>
        <div className="panel">
          <h2>Return window</h2>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Window length</div>
              <div className="settings-row__hint">
                How many days customers have to start a return.
              </div>
            </div>
            <input
              type="number"
              min={1}
              max={365}
              value={policy.returnWindowDays}
              onChange={(e) =>
                update("returnWindowDays", Number(e.target.value))
              }
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Counted from</div>
              <div className="settings-row__hint">
                When the clock starts on each order.
              </div>
            </div>
            <select
              value={policy.windowStartsFrom}
              onChange={(e) =>
                update(
                  "windowStartsFrom",
                  e.target.value as Policy["windowStartsFrom"],
                )
              }
            >
              <option value="ORDER_DATE">Order date</option>
              <option value="FULFILLMENT">Shipment</option>
              <option value="DELIVERY">Delivery</option>
            </select>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Allow final sale items</div>
              <div className="settings-row__hint">
                Off by default — final sale items can't be returned.
              </div>
            </div>
            <input
              type="checkbox"
              checked={policy.allowFinalSale}
              onChange={(e) => update("allowFinalSale", e.target.checked)}
            />
          </div>
        </div>

        <div className="panel">
          <h2>Resolutions offered</h2>
          {(
            [
              ["allowRefund", "Refund to original payment"],
              ["allowStoreCredit", "Store credit"],
              ["allowGiftCard", "Gift card"],
              ["allowExchange", "Exchange"],
              ["allowInstantExchange", "Instant exchange"],
            ] as const
          ).map(([key, label]) => (
            <div className="settings-row" key={key}>
              <div className="settings-row__label">{label}</div>
              <input
                type="checkbox"
                checked={policy[key]}
                onChange={(e) => update(key, e.target.checked)}
              />
            </div>
          ))}

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Bonus credit</div>
              <div className="settings-row__hint">
                Extra percentage added when a customer picks credit or an
                exchange instead of cash.
              </div>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={policy.bonusCreditPercent}
              onChange={(e) =>
                update("bonusCreditPercent", Number(e.target.value))
              }
            />
          </div>
        </div>

        <div className="panel">
          <h2>Product tag rules</h2>
          <p className="settings-row__hint" style={{ marginBottom: 14 }}>
            Narrow what a specific product can become, using the tags you
            already keep in Shopify. Matched against the tags a product carried
            when the order was placed, so retagging something later can't close
            a return a customer has already started. Tag names aren't
            case-sensitive.
          </p>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Use product tags</div>
              <div className="settings-row__hint">
                Off means every item follows the resolutions above, whatever
                tags it carries.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={policy.tagRulesEnabled}
              aria-label="Use product tags"
              className={`switch${policy.tagRulesEnabled ? " is-on" : ""}`}
              onClick={() => update("tagRulesEnabled", !policy.tagRulesEnabled)}
            >
              <span className="switch__knob" />
            </button>
          </div>

          {policy.tagRulesEnabled && (
            <>
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Final sale tags</div>
                  <div className="settings-row__hint">
                    An item with any of these can't be returned or exchanged at
                    all. Separate several with commas.
                  </div>
                </div>
                <input
                  type="text"
                  className="settings-input"
                  value={finalSaleText}
                  placeholder="final-sale"
                  onChange={(e) => {
                    setStatus(null);
                    setFinalSaleText(e.target.value);
                  }}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-row__label">Exchange only tags</div>
                  <div className="settings-row__hint">
                    An item with any of these can be exchanged, or taken as
                    store credit or a gift card — but not refunded to the
                    original payment method. Whichever of those you offer above
                    still applies; this only removes the cash refund.
                  </div>
                </div>
                <input
                  type="text"
                  className="settings-input"
                  value={exchangeOnlyText}
                  placeholder="exchange-only"
                  onChange={(e) => {
                    setStatus(null);
                    setExchangeOnlyText(e.target.value);
                  }}
                />
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <h2>Fees &amp; automation</h2>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Restocking fee (%)</div>
              <div className="settings-row__hint">
                Deducted from the refund total.
              </div>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={policy.restockingFeePercent}
              onChange={(e) =>
                update("restockingFeePercent", Number(e.target.value))
              }
            />
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Auto-approve returns</div>
              <div className="settings-row__hint">
                Skip manual review for straightforward requests.
              </div>
            </div>
            <input
              type="checkbox"
              checked={policy.autoApprove}
              onChange={(e) => update("autoApprove", e.target.checked)}
            />
          </div>

          {policy.autoApprove && (
            <div className="settings-row">
              <div>
                <div className="settings-row__label">
                  Auto-approve under
                </div>
                <div className="settings-row__hint">
                  Leave blank to auto-approve every request.
                </div>
              </div>
              <input
                type="number"
                min={0}
                step="0.01"
                value={policy.autoApproveUnder ?? ""}
                onChange={(e) =>
                  update(
                    "autoApproveUnder",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </div>
          )}
        </div>

      </form>
      )}

      {/*
        Appears only once something has actually changed, and stays put while
        the merchant scrolls — these panels are long, and a save button at the
        bottom of one of them is invisible from the setting it commits.

        The spacer keeps the bar from covering the last row it would otherwise
        sit on top of.
      */}
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
