import { Form, redirect, useNavigation, useParams } from "react-router";
import { api, ApiError, setToken } from "../lib/api";
import { ErrorAlert } from "../components/Feedback";
import type { Route } from "./+types/LookupPage";

/**
 * Route action: verifies the order, stores the scoped portal token, and moves
 * on to item selection. Returning an object (rather than throwing) surfaces
 * the failure inline instead of hitting the error boundary.
 */
export async function clientAction({ request, params }: Route.ClientActionArgs) {
  const formData = await request.formData();
  const orderNumber = String(formData.get("orderNumber") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (!orderNumber || !email) {
    return { error: "Enter both your order number and email address." };
  }

  try {
    const { token } = await api.post<{ token: string; orderId: string }>(
      "/portal/lookup",
      { merchantSlug: params.slug, orderNumber, email },
    );
    setToken("portal", token);
    return redirect(`/r/${params.slug}/items`);
  } catch (e) {
    return {
      error:
        e instanceof ApiError
          ? e.message
          : "We couldn't look up your order. Please try again.",
    };
  }
}

export default function LookupPage({ actionData }: Route.ComponentProps) {
  const { slug } = useParams();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <div className="card portal__card">
        <h2>Find your order</h2>
        <p className="muted" style={{ margin: "6px 0 20px" }}>
          Enter your order number and the email you used at checkout.
        </p>

        <ErrorAlert message={actionData?.error ?? null} />

        <Form method="post" key={slug}>
          <div className="field">
            <label htmlFor="orderNumber">Order number</label>
            <input
              id="orderNumber"
              name="orderNumber"
              placeholder="e.g. 1001"
              autoComplete="off"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required
            />
          </div>
          <button className="btn btn--block" type="submit" disabled={busy}>
            {busy ? "Finding your order…" : "Start a return"}
          </button>
        </Form>
      </div>
    </>
  );
}
