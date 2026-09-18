import { useEffect, useRef } from "react";
import { Form, redirect, useNavigation, useParams, useSearchParams, useSubmit } from "react-router";
import { api, ApiError, clearToken, setToken } from "../lib/api";
import { ErrorAlert } from "../components/Feedback";
import { money, shortDate } from "../lib/format";
import { at } from "../lib/i18n";
import {
  lookupFieldLabel,
  lookupInputProps,
  lookupMissingMessage,
} from "../lib/lookup";
import type { CustomerOrder } from "../lib/types";
import { usePortal, useT } from "./PortalLayout";
import { ReturnRows } from "./ReturnRows";
import type { Route } from "./+types/LookupPage";

/**
 * Why a lookup didn't go through.
 *
 * The two the portal words itself are returned as reasons rather than text:
 * their sentences depend on what the store verifies with, which only the
 * component — with the branding in hand — can say. Anything else arrives as
 * the message the server gave.
 */
type LookupFailure =
  | { reason: "missing" | "notFound" }
  | { error: string };


/**
 * Who is here, when the store already knows.
 *
 * Inside a storefront, the app proxy names the shopper signed in to the store
 * with a token on the frame's address; the portal keeps it for the visit and
 * shows their orders instead of asking for one. A fresh load from the proxy
 * with no token means nobody is signed in, so a token kept from an earlier
 * visit is dropped and a shared device doesn't greet the next person with the
 * last one's orders. Only that load drops it: coming back to this page from
 * the item picker is a navigation inside the frame, which carries neither
 * parameter, and the shopper is still the same shopper.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<{ orders: CustomerOrder[] | null }> {
  const params = new URL(request.url).searchParams;
  const handed = params.get("customer");
  if (handed) setToken("customer", handed);
  else if (params.get("embedded") === "1") clearToken("customer");

  try {
    const { orders } = await api.get<{ orders: CustomerOrder[] }>("/portal/customer/orders", { auth: "customer" });
    return { orders };
  } catch {
    // Expired, or nobody signed in: the form it is. A 401 has already dropped the token.
    return { orders: null };
  }
}

/**
 * Route action: verifies the order, stores the scoped portal token, and moves
 * on to item selection. Returning an object (rather than throwing) surfaces
 * the failure inline instead of hitting the error boundary.
 *
 * A signed-in shopper's "Create return" comes through here too, naming the
 * order by id; the server checks it is theirs and hands out the same session
 * the form would, so the rest of the return is one flow whichever door it
 * came in by.
 */
export async function clientAction({
  request,
  params,
}: Route.ClientActionArgs): Promise<LookupFailure | Response> {
  const formData = await request.formData();
  const customerOrderId = String(formData.get("customerOrderId") ?? "");
  if (customerOrderId) {
    try {
      const { token } = await api.post<{ token: string; orderId: string }>(
        "/portal/customer/start",
        { orderId: customerOrderId },
        { auth: "customer" },
      );
      setToken("portal", token);
      return redirect(`/r/${params.slug}/items`);
    } catch (e) {
      return { error: e instanceof ApiError ? e.message : at("lookup.error.failed") };
    }
  }

  const orderNumber = String(formData.get("orderNumber") ?? "").trim();
  const identifier = String(formData.get("identifier") ?? "").trim();

  if (!orderNumber || !identifier) {
    return { reason: "missing" };
  }

  try {
    const { token } = await api.post<{ token: string; orderId: string }>(
      "/portal/lookup",
      { merchantSlug: params.slug, orderNumber, identifier },
    );
    setToken("portal", token);
    return redirect(`/r/${params.slug}/items`);
  } catch (e) {
    if (e instanceof ApiError && e.code === "NOT_FOUND") {
      return { reason: "notFound" };
    }
    return {
      error:
        e instanceof ApiError
          ? e.message
          : at("lookup.error.failed"),
    };
  }
}

export default function LookupPage({ actionData, loaderData }: Route.ComponentProps) {
  const { slug } = useParams();
  const { branding, merchant, policy } = usePortal();
  const t = useT();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  /**
   * A link that already knows the order — from the "Start a return" button
   * in the shopper's Shopify account, or a link the store sent — fills the
   * form and submits it once, so the shopper lands on their items without
   * typing what the store already knows. A failure leaves the filled form
   * and its message, as if they had pressed the button themselves.
   */
  const [search] = useSearchParams();
  const presetOrder = (search.get("order") ?? "").trim().replace(/^#/, "");
  const presetIdentifier = (search.get("email") ?? search.get("identifier") ?? "").trim();
  const submit = useSubmit();
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (autoSubmitted.current || !presetOrder || !presetIdentifier || actionData) return;
    autoSubmitted.current = true;
    const form = new FormData();
    form.set("orderNumber", presetOrder);
    form.set("identifier", presetIdentifier);
    void submit(form, { method: "post" });
  }, [presetOrder, presetIdentifier, actionData, submit]);

  const input = lookupInputProps(branding, t);
  const error = !actionData
    ? null
    : "error" in actionData
      ? actionData.error
      : actionData.reason === "missing"
        ? lookupMissingMessage(branding, branding.locale, t)
        : t("lookup.error.notFound");

  const form = (
    <Form method="post" key={slug}>
      <div className="field">
        <label htmlFor="orderNumber">{branding.orderNumberLabel}</label>
        <input
          id="orderNumber"
          name="orderNumber"
          defaultValue={presetOrder}
          placeholder={t("lookup.orderPlaceholder")}
          autoComplete="off"
          required
        />
      </div>
      {/*
        One field however many ways the store accepts: the shopper has
        their order number and something from the order, and shouldn't
        need to work out which of the store's choices it is.
      */}
      <div className="field">
        <label htmlFor="identifier">
          {lookupFieldLabel(branding, branding.locale)}
        </label>
        <input
          id="identifier"
          name="identifier"
          type={input.type}
          defaultValue={presetIdentifier}
          autoComplete={input.autoComplete}
          placeholder={input.placeholder}
          required
        />
      </div>
      {/*
        Where a stuck shopper looks: under the fields, before the button,
        rather than in a tooltip they'd have to know to hover.
      */}
      {branding.lookupHelpText && (
        <p className="portal__help">{branding.lookupHelpText}</p>
      )}
      <button className="btn btn--block" type="submit" disabled={busy}>
        {busy ? t("lookup.busy") : branding.startButtonLabel}
      </button>
    </Form>
  );

  /**
   * Signed in to the store: their orders, newest first, each with the one
   * button that applies — the layout of AfterShip's returns centre. The form
   * stays underneath, folded, for an order placed as a guest under another
   * email, which the store can't tie to the account.
   */
  const orders = loaderData?.orders ?? null;
  if (orders) {
    return (
      <div className="card portal__card portal__card--wide orders">
        <h1 className="orders__heading">{t("orders.heading")}</h1>
        {/*
          The store's terms in a sentence, before any order is chosen, as
          AfterShip's returns centre opens. The sentence comes from the
          default policy's window; the link is the merchant's own page.
        */}
        <section className="orders__policy">
          <h2 className="orders__subtitle">{t("orders.policyTitle")}</h2>
          <p>
            {policy ? t(`orders.policy.${policy.windowFrom}`, { days: policy.windowDays }) : t("orders.policyFallback")}
            {branding.policyUrl && (
              <>
                {" "}
                <a href={branding.policyUrl} target="_blank" rel="noreferrer">
                  {t("orders.policyLink")}
                </a>
              </>
            )}
          </p>
        </section>
        <h2 className="orders__subtitle">{t("orders.title")}</h2>
        <ErrorAlert message={error} />
        {orders.length === 0 && <p className="orders__empty">{t("orders.empty")}</p>}
        {orders.map((order) => (
            <section className="order-card" key={order.id}>
              <header className="order-card__head">
                <div>
                  <div className="order-card__number">{t("orders.number", { number: order.orderNumber })}</div>
                  <div className="order-card__date">{t("orders.placed", { date: shortDate(order.placedAt) })}</div>
                </div>
                <div className="order-card__actions">
                  {order.returnable ? (
                    <Form method="post">
                      <input type="hidden" name="customerOrderId" value={order.id} />
                      <button className="btn btn--secondary" type="submit" disabled={busy}>
                        {t("orders.create")}
                      </button>
                    </Form>
                  ) : (
                    order.returns.length === 0 && <span className="order-card__note">{t("orders.notReturnable")}</span>
                  )}
                </div>
              </header>
              <ReturnRows slug={slug!} returns={order.returns} />
              <ul className="order-card__lines">
                {order.lineItems.map((line) => (
                  <li className="line-item" key={line.id}>
                    {line.imageUrl ? (
                      <img className="line-item__thumb" src={line.imageUrl} alt="" />
                    ) : (
                      <div className="line-item__thumb" aria-hidden="true" />
                    )}
                    <div className="line-item__body">
                      <div className="line-item__title">{line.title}</div>
                      {line.variantLabel && <div className="line-item__meta">{line.variantLabel}</div>}
                      <div className="line-item__meta order-card__price">
                        {money(line.unitPrice, order.currency)} × {line.quantity}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
        ))}
        {orders.length === 0 ? (
          <div className="orders__form">{form}</div>
        ) : (
          <details className="orders__other">
            <summary>{t("orders.other")}</summary>
            <div className="orders__form">{form}</div>
          </details>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="card portal__card lookup">
        {/*
          The lookup card carries the light logo when there is one: this sits
          on white, while the header's logo sits over the background image.
        */}
        {branding.lightLogoUrl && (
          <img
            className="portal__card-logo"
            src={branding.lightLogoUrl}
            alt={merchant.name}
          />
        )}
        <h2 className="lookup__title">{t("lookup.title")}</h2>

        <ErrorAlert message={error} />

        {form}
      </div>
    </>
  );
}
