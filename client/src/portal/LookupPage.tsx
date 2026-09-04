import { Form, redirect, useNavigation, useParams } from "react-router";
import { api, ApiError, setToken } from "../lib/api";
import { ErrorAlert } from "../components/Feedback";
import { at } from "../lib/i18n";
import {
  lookupFieldLabel,
  lookupInputProps,
  lookupIntro,
  lookupMissingMessage,
} from "../lib/lookup";
import { usePortal, useT } from "./PortalLayout";
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
 * Route action: verifies the order, stores the scoped portal token, and moves
 * on to item selection. Returning an object (rather than throwing) surfaces
 * the failure inline instead of hitting the error boundary.
 */
export async function clientAction({
  request,
  params,
}: Route.ClientActionArgs): Promise<LookupFailure | Response> {
  const formData = await request.formData();
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

export default function LookupPage({ actionData }: Route.ComponentProps) {
  const { slug } = useParams();
  const { branding, merchant } = usePortal();
  const t = useT();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const input = lookupInputProps(branding, t);
  const error = !actionData
    ? null
    : "error" in actionData
      ? actionData.error
      : actionData.reason === "missing"
        ? lookupMissingMessage(branding, branding.locale, t)
        : t("lookup.error.notFound");

  return (
    <>
      <div className="card portal__card">
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
        <h2>{t("lookup.title")}</h2>
        <p className="muted" style={{ margin: "6px 0 20px" }}>
          {lookupIntro(branding, branding.locale, t)}
        </p>

        <ErrorAlert message={error} />

        <Form method="post" key={slug}>
          <div className="field">
            <label htmlFor="orderNumber">{branding.orderNumberLabel}</label>
            <input
              id="orderNumber"
              name="orderNumber"
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
      </div>
    </>
  );
}
