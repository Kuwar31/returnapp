import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, setToken } from "../lib/api";
import { ErrorAlert } from "../components/Feedback";
import { PortalStepper } from "./PortalLayout";

export function LookupPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.post<{ token: string; orderId: string }>(
        "/portal/lookup",
        { merchantSlug: slug, orderNumber, email },
      );
      setToken("portal", token);
      navigate(`/r/${slug}/items`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PortalStepper current={0} />
      <div className="card portal__card">
        <h2>Find your order</h2>
        <p className="muted" style={{ margin: "6px 0 20px" }}>
          Enter your order number and the email you used at checkout.
        </p>

        <ErrorAlert message={error} />

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="orderNumber">Order number</label>
            <input
              id="orderNumber"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="e.g. 1001"
              autoComplete="off"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <button className="btn btn--block" type="submit" disabled={busy}>
            {busy ? "Finding your order…" : "Start a return"}
          </button>
        </form>
      </div>
    </>
  );
}
