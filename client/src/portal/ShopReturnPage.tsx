import { useEffect, useRef, useState } from "react";
import { redirect, useNavigate, useParams, useSearchParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import type { OrderSession } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import { describeVariant, saveCart, type CartLine } from "./draft";
import type { Route } from "./+types/ShopReturnPage";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getToken("portal")) throw redirect(`/r/${params.slug}`);
  try {
    return await api.get<OrderSession>("/portal/session/order", {
      auth: "portal",
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      throw redirect(`/r/${params.slug}`);
    }
    throw e;
  }
}

/** "12345:2,678:1" — variant ids and quantities, nothing else. */
const parseCart = (raw: string | null) =>
  (raw ?? "")
    .split(",")
    .map((pair) => pair.split(":"))
    .filter(([id, qty]) => id && Number(qty) > 0)
    .map(([id, qty]) => ({
      // Shopify's storefront reports numeric ids; the Admin API speaks GIDs.
      variantId: `gid://shopify/ProductVariant/${id.trim()}`,
      quantity: Math.min(99, Number(qty)),
    }));

/**
 * Where a shopper lands coming back from the merchant's own storefront.
 *
 * The storefront hands over variant ids and quantities and nothing more — no
 * titles, no prices. Those are read back from Shopify here, both so the review
 * screen has something to show and because a price that arrived over a URL is
 * not a price anyone should be quoted.
 *
 * The items being *returned* were never sent anywhere: they sat in this
 * origin's sessionStorage throughout, which is why the trip needs nothing
 * persisted server-side to survive it.
 */
export default function ShopReturnPage({ loaderData }: Route.ComponentProps) {
  const { order } = loaderData;
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Ingesting twice would double every quantity.
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const lines = parseCart(params.get("cart"));
    if (lines.length === 0) {
      navigate(`/r/${slug}/review`, { replace: true });
      return;
    }

    api
      .get<{
        currency: string;
        variants: Array<{
          id: string;
          title: string;
          variantTitle: string;
          imageUrl: string | null;
          price: number;
        }>;
      }>("/portal/session/exchange/variant-info", {
        auth: "portal",
        query: { ids: lines.map((l) => l.variantId).join(",") },
      })
      .then((info) => {
        const byId = new Map(info.variants.map((v) => [v.id, v]));
        const cart: CartLine[] = lines.flatMap((line) => {
          const variant = byId.get(line.variantId);
          if (!variant) return [];
          return [
            {
              variantId: line.variantId,
              quantity: line.quantity,
              title: variant.title,
              variantTitle: describeVariant(null, variant.variantTitle),
              imageUrl: variant.imageUrl,
              price: variant.price,
              currency: info.currency,
            },
          ];
        });

        if (cart.length === 0) {
          setError(
            "We couldn't find those items any more. Try picking them again.",
          );
          return;
        }
        saveCart(order.id, cart);
        navigate(`/r/${slug}/review`, { replace: true });
      })
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "We couldn't read your basket.",
        ),
      );
  }, [order.id, params, slug, navigate]);

  return (
    <div className="card portal__card">
      {error ? (
        <>
          <ErrorAlert message={error} />
          <button
            className="btn btn--block"
            onClick={() => navigate(`/r/${slug}/review`)}
          >
            Back to your return
          </button>
        </>
      ) : (
        <p className="muted" style={{ textAlign: "center" }}>
          Bringing your basket back…
        </p>
      )}
    </div>
  );
}
