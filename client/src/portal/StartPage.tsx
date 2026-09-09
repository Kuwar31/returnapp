import { redirect } from "react-router";
import { api, clearToken, setToken } from "../lib/api";
import type { OrderSession } from "../lib/types";
import { clearCart, clearDraft, forgetSubmitted } from "./draft";
import type { Route } from "./+types/StartPage";

/**
 * The portal, opened straight onto one order.
 *
 * The link a merchant makes from "Find an order" carries a session for that
 * order in its query string. Storing it here does what the lookup screen
 * does after a shopper proves the order, and then the item picker takes
 * over — so a return raised on a customer's behalf goes through exactly the
 * same steps, and the same rules, as one they'd raise themselves.
 *
 * Anything this browser remembered about the order is cleared first: a
 * half-made draft or a pointer to a previous return would otherwise steer
 * the merchant somewhere other than a fresh start.
 */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw redirect(`/r/${params.slug}`);

  setToken("portal", token);
  try {
    const session = await api.get<OrderSession>("/portal/session/order", {
      auth: "portal",
    });
    clearDraft(session.order.id);
    clearCart(session.order.id);
    forgetSubmitted(session.order.id);
  } catch {
    // Expired or not ours: back to the front door rather than a dead session.
    clearToken("portal");
    throw redirect(`/r/${params.slug}`);
  }
  throw redirect(`/r/${params.slug}/items`);
}

export default function StartPage() {
  return null;
}
