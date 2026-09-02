import { useEffect, useState } from "react";
import { redirect, useNavigate, useParams } from "react-router";
import { api, ApiError, getToken } from "../lib/api";
import { money } from "../lib/format";
import type {
  ExchangeCollection,
  ExchangeProduct,
  ExchangeVariant,
  OrderSession,
} from "../lib/types";
import { ErrorAlert } from "../components/Feedback";
import {
  cartTotal,
  describeVariant,
  loadCart,
  loadDraft,
  saveCart,
  toShopSelections,
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
 * Laid out as a shop, because that is what it is: collections down the side,
 * products in the middle, and the one number that governs every decision —
 * what's left of the credit — floating over the whole thing where it can't be
 * scrolled away from.
 */
export default function ShopPage({ loaderData }: Route.ComponentProps) {
  const { order, shopNow } = loaderData;
  const { slug } = useParams();
  const navigate = useNavigate();

  const [products, setProducts] = useState<ExchangeProduct[]>([]);
  const [collections, setCollections] = useState<ExchangeCollection[]>([]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>(() => loadCart(order.id));
  const [credit, setCredit] = useState<number | null>(null);
  const [openProduct, setOpenProduct] = useState<ExchangeProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

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
    /**
     * The shared builder, not a copy of it made here.
     *
     * This used to rewrite every line to an exchange and drop the swaps along
     * with them, so a shopper who had already picked a replacement for one
     * item was shown its value as credit to spend again.
     */
    const items = toShopSelections(draft);
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
      .get<{ products: ExchangeProduct[]; collections: ExchangeCollection[] }>(
        "/portal/session/exchange/products",
        {
          auth: "portal",
          query: {
            search: search || undefined,
            collectionId: collectionId ?? undefined,
          },
        },
      )
      .then((r) => {
        if (!active) return;
        setProducts(r.products);
        // The rail comes back with every page; keeping the last non-empty list
        // stops it flickering away while a filtered page loads.
        if (r.collections?.length) setCollections(r.collections);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : null))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [search, collectionId]);

  const write = (next: CartLine[]) => {
    setCart(next);
    saveCart(order.id, next);
  };

  const add = (
    product: ExchangeProduct,
    variant: ExchangeVariant,
    quantity = 1,
  ) => {
    const existing = cart.find((l) => l.variantId === variant.id);
    write(
      existing
        ? cart.map((l) =>
            l.variantId === variant.id
              ? { ...l, quantity: l.quantity + quantity }
              : l,
          )
        : [
            ...cart,
            {
              variantId: variant.id,
              quantity,
              title: product.title,
              variantTitle: describeVariant(variant.options, variant.title),
              imageUrl: variant.imageUrl ?? product.imageUrl,
              price: variant.price,
              currency: product.currency,
            },
          ],
    );
    setOpenProduct(null);
    /**
     * Slide the cart open on every add, like a storefront does. It confirms
     * the thing actually landed, shows what the credit now stands at, and puts
     * the way forward in front of the shopper — who may well be done after one
     * item. Closing it is one tap, and browsing carries on underneath.
     */
    setCartOpen(true);
  };

  const setQuantity = (variantId: string, quantity: number) =>
    write(
      quantity <= 0
        ? cart.filter((l) => l.variantId !== variantId)
        : cart.map((l) => (l.variantId === variantId ? { ...l, quantity } : l)),
    );

  const basket = cartTotal(cart);
  const remaining =
    credit === null ? null : Math.round((credit - basket) * 100) / 100;
  const owed = remaining !== null && remaining < 0 ? Math.abs(remaining) : 0;
  const count = cart.reduce((n, l) => n + l.quantity, 0);

  return (
    <div className="shop">
      <header className="shop__bar">
        <input
          className="shop__search"
          value={search}
          placeholder="Search for product…"
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="shop__bar-actions">
          <button
            type="button"
            className="shop__icon"
            onClick={() => setCartOpen(true)}
            aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}
          >
            <span aria-hidden="true">🛍</span>
            {count > 0 && <span className="shop__badge">{count}</span>}
          </button>
          <button
            type="button"
            className="shop__icon"
            onClick={() => navigate(`/r/${slug}/review`)}
            aria-label="Close and go back to your return"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>

      <div className="shop__layout">
        {/* Collections, so a big catalogue is navigable without searching. */}
        <nav className="shop__rail" aria-label="Collections">
          <button
            type="button"
            className={`shop__rail-item${collectionId === null ? " is-active" : ""}`}
            onClick={() => setCollectionId(null)}
          >
            All products
          </button>
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`shop__rail-item${collectionId === c.id ? " is-active" : ""}`}
              onClick={() => setCollectionId(c.id)}
            >
              {c.title}
            </button>
          ))}
        </nav>

        <div className="shop__body">
          <ErrorAlert message={error} />
          <h2 className="shop__heading">
            {collections.find((c) => c.id === collectionId)?.title ??
              "All products"}
          </h2>

          {loading ? (
            <p className="muted">Loading products…</p>
          ) : products.length === 0 ? (
            <p className="muted">
              {search ? `Nothing matched "${search}".` : "Nothing here yet."}
            </p>
          ) : (
            <div className="shop__grid">
              {products.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  className="shop-card"
                  onClick={() => setOpenProduct(product)}
                >
                  {product.imageUrl ? (
                    <img src={product.imageUrl} alt="" className="shop-card__img" />
                  ) : (
                    <div className="shop-card__img shop-card__img--empty" />
                  )}
                  {/*
                    Says up front that a choice is coming, the way a storefront
                    grid does, rather than springing it in the dialog. The line
                    is always rendered, even when empty: letting it collapse
                    left every title in the row at a different height.
                  */}
                  <div className="shop-card__variants">
                    {product.variants.length > 1
                      ? `${product.variants.length} variants`
                      : ""}
                  </div>
                  <div className="shop-card__title">{product.title}</div>
                  <div className="shop-card__price">
                    {money(product.minPrice, product.currency)}
                    {product.maxPrice > product.minPrice &&
                      ` – ${money(product.maxPrice, product.currency)}`}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {openProduct && (
        <ProductDialog
          product={openProduct}
          cart={cart}
          onAdd={add}
          onClose={() => setOpenProduct(null)}
        />
      )}

      {cartOpen && (
        <div className="drawer" role="dialog" aria-modal="true">
          <div className="drawer__backdrop" onClick={() => setCartOpen(false)} />
          <aside className="card shop-cart">
            <div className="shop-cart__head">
              <h2>Cart ({count})</h2>
              <button
                type="button"
                className="shop__icon"
                onClick={() => setCartOpen(false)}
                aria-label="Close cart"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>

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
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setQuantity(line.variantId, 0)}
                      >
                        Remove
                      </button>
                    </div>
                    <Stepper
                      value={line.quantity}
                      onChange={(q) => setQuantity(line.variantId, q)}
                    />
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

            {/*
              The drawer is where a shopper lands after adding something, so
              the way forward has to be here too — not only on the pill behind
              it, which the drawer is covering.
            */}
            <div className="shop-cart__actions">
              <button
                className="btn btn--block"
                disabled={cart.length === 0}
                onClick={() => navigate(`/r/${slug}/review`)}
              >
                Continue ({count})
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={() => setCartOpen(false)}
              >
                Keep shopping
              </button>
            </div>
          </aside>
        </div>
      )}

      {/*
        The running balance, floated over the grid rather than parked in a
        column beside it. It is the number every tap on this screen is measured
        against, so it follows the shopper down the page.
      */}
      <div className="shop__pill">
        <span className="shop__pill-amount">
          {credit === null
            ? "…"
            : money(owed > 0 ? owed : (remaining ?? 0), currency)}
        </span>
        <span className="shop__pill-label">
          {owed > 0 ? "more to pay" : "to spend from your return"}
        </span>
        <button
          className="btn shop__pill-btn"
          disabled={cart.length === 0}
          onClick={() => navigate(`/r/${slug}/review`)}
        >
          Continue ({count})
        </button>
      </div>
    </div>
  );
}

/** A quantity control, shared by the cart and the product dialog. */
function Stepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        aria-label="One fewer"
      >
        −
      </button>
      <span>{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        aria-label="One more"
      >
        +
      </button>
    </div>
  );
}

/**
 * The product, opened.
 *
 * Picture on the left, decision on the right — quantity, and the option to
 * choose when there is one. A product with a single variant shows no chooser,
 * because there is nothing to choose.
 */
function ProductDialog({
  product,
  cart,
  onAdd,
  onClose,
}: {
  product: ExchangeProduct;
  cart: CartLine[];
  onAdd: (
    product: ExchangeProduct,
    variant: ExchangeVariant,
    quantity: number,
  ) => void;
  onClose: () => void;
}) {
  const [variantId, setVariantId] = useState(
    () => product.variants.find((v) => v.available)?.id ?? product.variants[0]?.id,
  );
  const [quantity, setQuantity] = useState(1);

  const variant = product.variants.find((v) => v.id === variantId);
  const inCart = cart.find((l) => l.variantId === variantId)?.quantity ?? 0;
  const image = variant?.imageUrl ?? product.imageUrl;

  return (
    <div className="drawer" role="dialog" aria-modal="true">
      <div className="drawer__backdrop" onClick={onClose} />
      <div className="card shop-pdp">
        <button
          type="button"
          className="shop-pdp__close shop__icon"
          onClick={onClose}
          aria-label="Close"
        >
          <span aria-hidden="true">✕</span>
        </button>

        <div className="shop-pdp__media">
          {image ? (
            <img src={image} alt="" />
          ) : (
            <div className="shop-pdp__media-empty" />
          )}
        </div>

        <div className="shop-pdp__detail">
          <h2>{product.title}</h2>
          <div className="shop-pdp__price">
            {variant
              ? money(variant.price, product.currency)
              : money(product.minPrice, product.currency)}
          </div>
          <p className="muted shop-pdp__stock">
            {variant?.available ? "In stock" : "Sold out"}
            {inCart > 0 && ` · ${inCart} already in your cart`}
          </p>

          {product.variants.length > 1 && (
            <>
              <h3 className="shop-pdp__label">Options</h3>
              <div className="shop-pdp__options">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={`size${v.id === variantId ? " is-selected" : ""}${
                      v.available ? "" : " is-out"
                    }`}
                    disabled={!v.available}
                    onClick={() => setVariantId(v.id)}
                  >
                    {describeVariant(v.options, v.title) ?? v.title}
                  </button>
                ))}
              </div>
            </>
          )}

          <h3 className="shop-pdp__label">Quantity</h3>
          <Stepper
            value={quantity}
            onChange={(q) => setQuantity(Math.max(1, q))}
          />

          <button
            className="btn btn--block shop-pdp__add"
            disabled={!variant?.available}
            onClick={() => variant && onAdd(product, variant, quantity)}
          >
            {variant?.available ? "Add to cart" : "Sold out"}
          </button>
        </div>
      </div>
    </div>
  );
}
