import { useEffect, useState } from "react";
import { redirect, useNavigate, useParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import { money } from "../lib/format";
import type { ExchangeProduct, OrderSession } from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import {
  cartTotal,
  describeVariant,
  loadCart,
  loadDraft,
  saveCart,
  type CartLine,
} from "./draft";
import type { Route } from "./+types/ShopPage";

/** Same guard as the item picker: no session, no catalogue. */
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

/**
 * Spending a return's value across the catalogue, rather than swapping one item
 * for another.
 *
 * The credit is pooled — every item being sent back pays into one balance — so
 * this screen deliberately shows a single running figure rather than a per-item
 * one. What the shopper needs to know at every moment is how much of their
 * credit is left and whether they have gone past it.
 */
export default function ShopPage({ loaderData }: Route.ComponentProps) {
  const { order, shopNow } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();

  const [products, setProducts] = useState<ExchangeProduct[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>(() => loadCart(order.id));
  const [credit, setCredit] = useState<number | null>(null);
  const [openProduct, setOpenProduct] = useState<ExchangeProduct | null>(null);

  const offer = shopNow?.enabled ? shopNow : null;
  const currency = offer?.currency ?? order.currency;

  /**
   * The pool, from the server's own quote rather than added up here — the
   * bonus percentage, the restocking fee and the policy all live there, and
   * recomputing any of it in the browser is how two screens end up promising
   * different numbers.
   *
   * Quoted with an empty basket on purpose: that asks "what would my credit be
   * if I spent it here", which is a different question from "what would you
   * refund me" — the flat bonus only exists for money kept in the store. The
   * review step re-quotes with the real basket and is what the shopper signs.
   */
  useEffect(() => {
    const draft = loadDraft(order.id);
    const items = Object.entries(draft).map(([key, d]) => ({
      orderLineItemId: key.split("#")[0],
      reasonId: d.reasonId,
      reasonNote: d.reasonNote || undefined,
      photoUrls: [] as string[],
      // Spending it is an exchange as far as the money is concerned.
      resolution: "EXCHANGE" as const,
    }));
    if (items.length === 0) {
      navigate(`/r/${slug}/items`, { replace: true });
      return;
    }
    let active = true;
    api
      .post<{ estimatedTotal: number }>(
        "/portal/session/quote",
        { items, shopItems: [] },
        { auth: "portal" },
      )
      .then((q) => active && setCredit(q.estimatedTotal))
      .catch(
        (e) =>
          active &&
          setError(e instanceof Error ? e.message : "Couldn't load your credit."),
      );
    return () => {
      active = false;
    };
  }, [order.id, slug, navigate]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get<{ products: ExchangeProduct[] }>("/portal/session/exchange/products", {
        auth: "portal",
        query: { search: search || undefined },
      })
      .then((r) => active && setProducts(r.products))
      .catch((e) => active && setError(e instanceof Error ? e.message : null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [search]);

  const write = (next: CartLine[]) => {
    setCart(next);
    saveCart(order.id, next);
  };

  const add = (product: ExchangeProduct, variantId: string) => {
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) return;
    const existing = cart.find((l) => l.variantId === variantId);
    write(
      existing
        ? cart.map((l) =>
            l.variantId === variantId ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [
            ...cart,
            {
              variantId,
              quantity: 1,
              title: product.title,
              variantTitle: describeVariant(variant.options, variant.title),
              imageUrl: variant.imageUrl ?? product.imageUrl,
              price: variant.price,
              currency: product.currency,
            },
          ],
    );
    setOpenProduct(null);
  };

  /**
   * Opening a product. A single-variant product has no decision in it, so it
   * goes straight into the basket — putting "Choose an option" in front of one
   * unnamed button is a step that asks nothing and costs a tap.
   */
  const choose = (product: ExchangeProduct) => {
    const only = product.variants.length === 1 ? product.variants[0] : null;
    if (only && only.available) {
      add(product, only.id);
      return;
    }
    setOpenProduct(product);
  };

  const setQuantity = (variantId: string, quantity: number) =>
    write(
      quantity <= 0
        ? cart.filter((l) => l.variantId !== variantId)
        : cart.map((l) => (l.variantId === variantId ? { ...l, quantity } : l)),
    );

  const basket = cartTotal(cart);
  const remaining = credit === null ? null : Math.round((credit - basket) * 100) / 100;
  const owed = remaining !== null && remaining < 0 ? Math.abs(remaining) : 0;

  return (
    <div className="shop">
      <header className="shop__bar">
        <button
          type="button"
          className="shop__back"
          onClick={() => navigate(`/r/${slug}/review`)}
          aria-label="Back to your return"
        >
          ←
        </button>
        <p className="shop__credit">
          {credit === null ? (
            "Loading your credit…"
          ) : (
            <>
              Use your <strong>{money(credit, currency)}</strong> credit to find
              something new.
              {offer && offer.bonus > 0 && (
                <> (Extra {money(offer.bonus, currency)} included)</>
              )}
            </>
          )}
        </p>
        <input
          className="shop__search"
          value={search}
          placeholder="Search by product name"
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      <div className="shop__body">
        <ErrorAlert message={error} />

        {loading ? (
          <p className="muted">Loading products…</p>
        ) : products.length === 0 ? (
          <p className="muted">Nothing matched "{search}".</p>
        ) : (
          <div className="shop__grid">
            {products.map((product) => (
              <button
                key={product.id}
                type="button"
                className="shop-card"
                onClick={() => choose(product)}
              >
                {product.imageUrl ? (
                  <img src={product.imageUrl} alt="" className="shop-card__img" />
                ) : (
                  <div className="shop-card__img shop-card__img--empty" />
                )}
                <div className="shop-card__title">{product.title}</div>
                <div className="shop-card__price">
                  {money(product.minPrice, product.currency)}
                  {product.maxPrice > product.minPrice && "+"}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        Only ever opened for a product that genuinely has options — see
        `choose`. A modal headed "Choose an option" above a single nameless
        button asks the shopper to make a decision that doesn't exist.
      */}
      {openProduct && (
        <div className="drawer" role="dialog" aria-modal="true">
          <div className="drawer__backdrop" onClick={() => setOpenProduct(null)} />
          <div className="card shop-picker">
            <div className="shop-picker__head">
              {openProduct.imageUrl && (
                <img src={openProduct.imageUrl} alt="" />
              )}
              <div>
                <h2>{openProduct.title}</h2>
                <p className="muted">Choose an option</p>
              </div>
            </div>

            <div className="shop-picker__options">
              {openProduct.variants.map((variant) => {
                const inCart =
                  cart.find((l) => l.variantId === variant.id)?.quantity ?? 0;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    className="shop-option"
                    disabled={!variant.available}
                    onClick={() => add(openProduct, variant.id)}
                  >
                    <span className="shop-option__name">
                      {describeVariant(variant.options, variant.title) ??
                        openProduct.title}
                      {inCart > 0 && (
                        <span className="shop-option__in-cart">
                          {inCart} in cart
                        </span>
                      )}
                    </span>
                    <span className="shop-option__price">
                      {money(variant.price, openProduct.currency)}
                    </span>
                    <span className="shop-option__add" aria-hidden="true">
                      {variant.available ? "Add" : "Sold out"}
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="linkish shop-picker__cancel"
              onClick={() => setOpenProduct(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <aside className="shop__cart">
        <h2>Cart ({cart.reduce((n, l) => n + l.quantity, 0)})</h2>
        {cart.length === 0 ? (
          <p className="muted">Nothing added yet.</p>
        ) : (
          <ul className="shop-cart__lines">
            {cart.map((line) => (
              <li key={line.variantId} className="shop-cart__line">
                {line.imageUrl && <img src={line.imageUrl} alt="" />}
                <div className="shop-cart__body">
                  <div className="shop-cart__title">{line.title}</div>
                  {line.variantTitle && (
                    <div className="muted">{line.variantTitle}</div>
                  )}
                  <div className="shop-cart__price">
                    {money(line.price, line.currency)}
                  </div>
                </div>
                <div className="shop-cart__qty">
                  <button
                    type="button"
                    onClick={() => setQuantity(line.variantId, line.quantity - 1)}
                    aria-label="One fewer"
                  >
                    −
                  </button>
                  <span>{line.quantity}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity(line.variantId, line.quantity + 1)}
                    aria-label="One more"
                  >
                    +
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="shop-cart__summary">
          <div className="summary__line">
            <span>New items</span>
            <span>{money(basket, currency)}</span>
          </div>
          <div className="summary__line">
            <span>Your return credit</span>
            <span>−{money(credit ?? 0, currency)}</span>
          </div>
          <div
            className={`summary__total ${
              owed > 0 ? "summary__total--due" : "summary__total--paid"
            }`}
          >
            <span>{owed > 0 ? "Left to pay" : "Credit remaining"}</span>
            <strong>
              {money(owed > 0 ? owed : (remaining ?? 0), currency)}
            </strong>
          </div>
        </div>

        <button
          className="btn btn--block"
          disabled={cart.length === 0}
          onClick={() => navigate(`/r/${slug}/review`)}
        >
          Next
        </button>
      </aside>
    </div>
  );
}
