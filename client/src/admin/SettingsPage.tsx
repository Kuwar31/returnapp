import { useEffect, useState } from "react";
import { api } from "../lib/api";
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

export default function SettingsPage() {
  const { session } = useAuth();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<Policy[]>("/admin/settings/policies", { auth: "admin" })
      .then((policies) => {
        if (!active) return;
        setPolicy(policies.find((p) => p.isDefault) ?? policies[0] ?? null);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const update = <K extends keyof Policy>(key: K, value: Policy[K]) =>
    setPolicy((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!policy) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const { id, isDefault, ...body } = policy;
      void isDefault;
      const updated = await api.patch<Policy>(
        `/admin/settings/policies/${id}`,
        body,
        { auth: "admin" },
      );
      setPolicy(updated);
      setStatus("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  };

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
          <h1>Settings</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Portal link: /r/{session?.merchant.slug}
          </p>
        </div>
      </div>

      <ErrorAlert message={error} />
      {status && <div className="alert alert--info">{status}</div>}

      <div className="settings-form">
        <ShopifyPanel />
      </div>

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

        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </form>
    </>
  );
}
