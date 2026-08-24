# Returns Manager

A returns and exchanges platform in the mould of Loop Returns: a branded
self-serve portal for shoppers, and an admin for the merchant to review and
resolve what comes in.

This is the framework layer — the domain model, the money math, the state
machine, and both UIs are real and working end to end. The commerce-platform
integration and notification/label providers are the deliberate next steps.

## Stack

| Layer    | Choice                                                       |
| -------- | ------------------------------------------------------------ |
| Frontend | React 19 + React Router 8 in framework mode (TypeScript)     |
| Backend  | Node.js + Express (TypeScript, ESM)                          |
| Database | PostgreSQL via Prisma                                        |
| Commerce | Shopify OAuth + webhooks + Admin GraphQL (API 2026-04)        |
| Auth     | JWT — separate scopes for merchant staff and shoppers        |

```
returns-manager/
├── client/                    React Router app: portal + admin
│   ├── react-router.config.ts appDirectory + ssr flag
│   └── src/
│       ├── root.tsx     document shell (Layout), fallback, error boundary
│       ├── routes.ts    the route tree
│       ├── portal/      /r/:slug — lookup, item selection, status
│       ├── admin/       /admin  — dashboard, returns, detail, settings
│       ├── lib/         API client, shared types, formatters
│       └── styles/      design tokens + page styles
├── server/
│   ├── prisma/       schema, migrations, seed, dev utilities
│   └── src/
│       ├── config/   validated environment
│       ├── lib/      prisma, logger, errors, money, tokens, crypto
│       ├── middleware/  auth, validation, rate limit, error handling
│       └── modules/
│           ├── auth/     merchant sign-in
│           ├── portal/   shopper-facing flow
│           ├── policy/   eligibility + quote engines
│           ├── returns/  admin review, state machine
│           ├── settings/ policy and branding config
│           └── shopify/  OAuth, webhooks, order sync
└── docker-compose.yml
```

## Getting started

```bash
cp .env.example .env && npm install
```

Start Postgres — either Docker:

```bash
npm run db:up
```

or a local install listening on port 5433 (matching `DATABASE_URL`).

Then create the schema, load demo data, and run both apps:

```bash
npm run db:migrate && npm run db:seed && npm run dev
```

- Portal — http://localhost:5173/r/demo-store (order `1002`, `shopper@example.com`)
- Admin — http://localhost:5173/admin (`owner@demo-store.test` / `password123`)
- API — http://localhost:4000/api/health

`npx tsx prisma/add-demo-order.ts 1003` (from `server/`) adds another
returnable order once you've used up the seeded ones.

## Connecting your Shopify store

Orders reach Postgres two ways: a **backfill** over the Admin GraphQL API when
you first connect, and **webhooks** from then on.

**1. Create an app** in the [Shopify Partner Dashboard](https://partners.shopify.com)
(Apps → Create app → Create manually). Copy the client ID and secret.

**2. Expose your server over HTTPS.** Shopify cannot reach `localhost`, so
local development needs a tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
```

**3. Fill in `.env`** with the tunnel URL as `APP_URL`:

```
APP_URL=https://your-tunnel.trycloudflare.com
SHOPIFY_API_KEY=<client id>
SHOPIFY_API_SECRET=<client secret>
ENCRYPTION_KEY=<openssl rand -hex 32>
```

**4. Set the redirect URL** in the Partner Dashboard to
`{APP_URL}/api/shopify/callback`, then restart the server.

**5. Connect** from Settings → Shopify in the admin, or hit
`/api/shopify/install?shop=your-store.myshopify.com` directly. Approving the
scopes registers the webhooks and kicks off a 90-day backfill.

Access tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY` before they touch
the database, and every webhook is HMAC-verified against the raw request body.

### Testing without a store

```bash
cd server
npx tsx prisma/connect-test-shop.ts          # mark the demo store connected
npx tsx prisma/add-demo-order.ts 1003        # add a returnable order
```

This exercises the inbound webhook path with a dummy token. Anything that calls
*out* to Shopify (backfill, re-sync) will fail by design.

## How it works

**Eligibility** (`modules/policy/eligibility.service.ts`) is a pure function
over an order and a policy. It decides per line item whether it can come back,
based on the return window (counted from order date, shipment, or delivery),
final-sale flags, and how much of the line has already been returned. Pure
means it's trivially testable and shared by the portal and any future
"create a return on the customer's behalf" admin flow.

**Quoting** (`modules/policy/quote.service.ts`) turns a selection into money:
item subtotal, bonus credit, restocking fee, return shipping. The same
function powers the shopper's live estimate and the figures written on submit,
so the number they agreed to is the number stored. The Loop-style incentive
falls out of the policy — on the seeded store, $64 of items returns $58.01 as
cash but $70.40 as store credit, because credit earns a 10% bonus and waives
the shipping fee.

**Status** (`modules/returns/status.ts`) is an explicit transition table.
Every status change goes through `changeStatus`, which validates the move,
writes the new status, and appends a timeline event in one transaction — so an
illegal jump fails loudly rather than corrupting history.

**Money** is `Decimal(12,2)` in Postgres and `Prisma.Decimal` in code, never a
float. `lib/money.ts` holds the rounding and serialization helpers; responses
convert to numbers at the edge.

### Security posture

- Shoppers never get an account. Proving order number + email mints a short-lived
  JWT scoped to that one order; every portal write re-derives prices and
  quantities from the database rather than trusting the request body.
- Order lookup is rate limited and deliberately vague on failure, so it can't be
  used to enumerate orders.
- Every merchant query is scoped by `merchantId` from the token, never a
  client-supplied id.
- Login compares against a dummy hash when the user doesn't exist, so a wrong
  email and a wrong password take the same time.

## What's next

1. **Commerce integration** — the `Integration` model and `Order`/`OrderLineItem`
   mirrors are in place; sync orders from Shopify and push refunds back.
2. **Return labels** — `ReturnShipment` is modelled but no carrier is wired up.
3. **Notifications** — transactional email on submit, approve, decline, resolve.
4. **Exchanges** — `ExchangeItem` is stored, but the portal needs a product
   browser for choosing the replacement.
5. **Tests** — the eligibility and quote engines are pure functions and the
   obvious first target.

## Scripts

| Command              | Does                                     |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Runs API and client together             |
| `npm run build`      | Builds both workspaces                   |
| `npm run typecheck`  | Type-checks both workspaces              |
| `npm run db:migrate` | Creates/applies a migration              |
| `npm run db:seed`    | Loads the demo store                     |
| `npm run db:studio`  | Opens Prisma Studio                      |
# returnapp
