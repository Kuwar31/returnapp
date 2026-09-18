# Returns Manager — working guide

A Loop / AfterShip-style returns app for Shopify: a shopper portal at `/r/:slug`
and a merchant admin at `/admin/:slug`. `README.md` covers the stack and layout,
`DEPLOYMENT.md` the hosting setup. This file is what those don't say: the rules
that aren't visible in the code, how changes are verified, and lessons already
paid for. Two people work on this repo, each with their own Claude session, so
**this file is the shared memory. When you learn something the next person
would trip over, add it here in the same commit.**

## Hard rules

- **Pushing to `main` deploys to production.** Render (API + `prisma migrate
  deploy`) and Vercel (SPA) both build on every push. Work on a branch and open
  a PR; merge only what is finished and typechecks.
- **Never commit secrets.** The repo is public. `.gitignore` keeps `.env*` with
  `!.env.example`; leave it that way. Secrets go in the Render/Vercel dashboards.
- **Never change `ENCRYPTION_KEY`** once any store is connected. Shopify tokens
  and every carrier credential are encrypted with it; a new key makes them all
  unreadable.
- **Never send real email from a test.** The live test store's orders belong to
  a real customer inbox. Run scripts with `SMTP_HOST=` unset (mail is then
  written to `server/.mail/`) and guard probes with
  `if (env.smtpConfigured) process.exit(1)`.
- **Never name `phone` in the Shopify order-sync query**
  (`SYNC_ORDERS_QUERY`, `server/src/modules/shopify/order.sync.ts`). Phone is
  protected customer data: without approval Shopify rejects the *whole query*,
  which once silently broke every order sync. Phone comes from the separate
  best-effort `fetchOrderPhone`. The same care applies to any new query that
  touches customer name, address or phone.
- **One person touches `schema.prisma` at a time.** Say so before you start,
  pull first, and never edit a migration that has been pushed. Migrations are
  hand-written SQL in `server/prisma/migrations/<timestamp>_<name>/`, applied
  locally with `npx prisma migrate deploy` then `npx prisma generate`.
- **Credentials are the merchant's to enter.** Carrier keys, Shopify secrets and
  passwords go in through the app's own forms or the hosting dashboards, never
  through a script or a chat.

## Running it

```bash
npm run db:up        # Postgres in Docker on localhost:5433
npm run dev          # API on :4000 (tsx watch), SPA on :5173 (Vite)
npm run typecheck    # both workspaces; run before every commit
```

- Local store: slug `demo-store`, with an OWNER membership and a mirror of the
  live store's order `#1072`. Its Shopify connection is off, so anything that
  needs the catalogue (variant swaps, shop-now products, store credit, the
  actual Shopify refund) can't be exercised locally.
- The API only allows CORS from `http://localhost:5173`.
- Admin routes are under `/api/admin/...` and need `Authorization: Bearer <jwt>`
  plus `x-store-slug`. Portal routes are under `/api/portal/...`.

## Production

- API: `https://returnapp-yxkl.onrender.com` (Render free tier, sleeps; ~25 s to
  wake). `/api/health` wakes it.
- SPA: `https://returnapp-client.vercel.app`. (`returnapp.vercel.app` is a
  different, unrelated app.)
- Live test store: slug `cant-9412` (Shopify dev store, EUR, INR presentment).
- To confirm a deploy is live, hit a route that only the new code has, e.g.
  `GET /api/shipping/packing-slip/x?sig=y` answers `No such packing slip.` from
  new code and `No route …` from old.

## How changes are verified

Typecheck is necessary and not sufficient. The pattern that has worked:

1. **Probe scripts** — `.mts` files (a `.ts` outside the repo is treated as
   CommonJS and top-level `await` fails) that import server sources by absolute
   path, start the app with `createApp().listen(0)`, mint a token with
   `signAdminToken({ sub: membership.userId })`, and drive the HTTP API against
   the local `demo-store`. `@prisma/client` can't be imported from outside the
   repo; go through `server/src/lib/prisma.ts`. Run from `server/` with
   `SMTP_HOST= LOG_LEVEL=silent npx tsx <file>`. Create and clean up your own
   fixtures; never leave carrier accounts or `ShippingSettings` rows behind,
   because other probes assume a store with no carrier.
2. **Carrier stand-ins** — every carrier's base URL is an env var, so a probe can
   point it at a small HTTP server on `127.0.0.1` that emulates the API. Nothing
   real is called and nothing is charged.
3. **The browser** — the admin token lives in
   `localStorage["returns.admin.token"]`, the shopper's in
   `localStorage["returns.portal.token"]`. Check phone width (about 400 px) as
   well as desktop; the portal is used mostly on phones.
4. **Route listing** — after adding routes, confirm they register at boot:
   `settingsRouter.stack.filter(l => l.route)`. See the first lesson below.

## Architecture notes the code doesn't spell out

### Money

- Totals are **stored, not derived on read**. `recalculateTotals` rewrites them
  whenever an inspection changes; `payoutSplit` recomputes where money lands.
  Both count a line at `acceptedQuantity ?? quantity`, so an uninspected line is
  worth what the shopper was quoted.
- Cash refunds go through Shopify's `suggestedFinancialOutcome` then
  `returnProcess`, with the accepted units only (`settledReturnLineItems`).
  `externalRefundId` is the guard against refunding twice; Shopify will happily
  refund the same return again.
- Store credit and gift cards are issued by the app in separate calls and must
  never also be refunded as cash.
- `server/src/modules/policy/quote.service.ts` is the single quoting engine for
  the portal, the admin and the emails. Change money behaviour there, not at the
  call sites.

### Policies and routing

- The store policy (`ReturnPolicy`) holds every mechanic. A `RegionalPolicy`
  claims countries and overrides only outcomes, windows, fees, destination,
  review, exchange behaviour, **label settings and packing slips**.
- `ReturnRoutingRule` (AfterShip's shape) decides which return methods are
  offered; first match wins, the default rule catches the rest. Its
  "Ship with a return label" method carries the return shipping information:
  carrier, shipping service by name, warehouse, package size.

### Shipping

- `server/src/modules/shipping/shipping.service.ts` is the facade every caller
  uses. Carrier precedence is **routing rule > regional policy > store default**.
  Destination precedence is rule > policy > Shipping page > default destination.
- Carriers: Shiprocket, Delhivery, EasyPost, Shippo, ShipStation, Sendcloud,
  DHL Express, FedEx, Australia Post, DHL Paket, and `EXTERNAL` (the merchant's
  own label system, posted to with an HMAC signature; it answers now or later
  through `/api/shipping/external/events`).
- Test modes: Shiprocket books pretend pickups (it has no sandbox), Delhivery
  uses its staging host, EasyPost and Shippo follow their test keys, ShipStation
  makes test labels, Sendcloud announces without a label, the direct carriers use
  their sandboxes. **None of the direct carriers (DHL Express, FedEx, Australia
  Post, DHL Paket), nor ShipStation and Sendcloud, has been run against real
  credentials yet.** They follow public docs and mocks; expect small field-name
  fixes on first real use.
- Adding a carrier touches: a `*.service.ts` (and client), the `ShipmentProvider`
  enum + account model + migration, an env URL, branches in the facade
  (`carrierFor`, quote, book, refresh, cancel), routes in `settings.routes.ts`,
  `shippingView`, `client/src/lib/shipping.ts`, the connect form and Manage
  block in `ShippingPage.tsx`, and a probe section with a stand-in.
- Parcels are booked at a `PackageSize` (the store default, or the routing
  rule's). The old `lengthCm/breadthCm/heightCm/weightKg` columns on
  `ShippingSettings` are only a fallback for a store with no package size.
- Label PDFs a carrier hands over are stored base64 on
  `ReturnShipment.labelData` and served under an HMAC-signed link, as are test
  labels and packing slips. Signed links exist because a new browser tab can't
  carry an auth header.
- Webhooks keep the raw body (`req.rawBody`, set in `app.ts`) for signature
  checks. Shiprocket's webhook path deliberately doesn't mention Shiprocket:
  their form rejects URLs that do.

### Tags and notes on Shopify orders

- `server/src/modules/shopify/order-notes.service.ts` writes tags (`tagsAdd`)
  and appends notes (`orderUpdate`) to the original order, and to the exchange
  order on the draft-order path, at each moment in `OrderNoteEvent`. Rules
  live in `OrderNoteRule` with code defaults; placeholders like `{RMA no.}`
  are filled by `renderOrderNote`. Every write is best effort and lands on the
  return's timeline; nothing is attempted for a store without Shopify.
- Needs the `write_orders` scope. It is in the default scope list now, but a
  store installed before it was asked for has to reconnect under Settings →
  General; the settings page says so (`canWrite`). The Render `SHOPIFY_SCOPES`
  env must include it too.

### Client

- React Router 8 in framework mode; routes in `client/src/routes.ts`.
- The portal is translated into 13 locales in `client/src/lib/locales/`. A new
  shopper-facing string needs a key in **every** locale file.
- Admin pages reload from the server after each change rather than patching
  local state; the payloads are small and the server is authoritative.

## Conventions

- Comments explain **why**, in full sentences, and are kept up to date. Match
  the surrounding style.
- Errors shown to merchants are written in their words (`unprocessable("…")`),
  and a carrier's own message is passed through rather than replaced.
- Commit messages explain the reason and the behaviour change, not the diff.
  They are the change log the other person's Claude reads.
- Design references: Loop Returns and AfterShip Returns. When the owner says
  "make it like Loop's", match layout, spacing and copy closely, and check the
  result at phone width.

## Lessons already paid for

- **Routes registered inside another handler.** New routes were once inserted by
  anchoring on `);\n`, which landed them *inside* the previous route's handler.
  TypeScript accepted it, and the probe passed because it happened to call that
  handler first. On the live server every carrier route after Delhivery's test
  route returned 404 until someone pressed Test on Delhivery. Always confirm new
  routes exist at boot; the shipping probe asserts this now.
- **A figure shown is as important as a figure paid.** The refund itself followed
  inspections, but the "Process return · €…" button kept the pre-inspection
  amount because its preview was only refetched on a status change. Anything
  that displays money must refresh when an inspection changes.
- **First-read upserts race.** `getSettings` upserts a row on first sight; two
  concurrent first readers collided on the unique key. It now falls back to a
  read on `P2002`. Do the same for any other create-on-read.
- **A stale admin token looks like a missing route.** Tokens last 12 hours. A
  401 "session has expired" during testing means mint a new one, not that the
  server is broken.
- **Shopify dispositions are permanent.** A unit can be disposed exactly once
  and it can't be revised, which is why rejected units are left undisposed and
  restocking is only editable between approval and receipt.
- **Shopify refunds in the transaction's currency**, which on a multi-currency
  store is the presentment currency, not the shop's.
