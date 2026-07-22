# Paid Intro Offer — Phase 3b (Stripe rail) + 3c (payments settings)

**Date:** 2026-07-23
**Status:** Design — approved in brainstorming, pending spec review
**Branch / worktree:** `class-funnel-pay-p3bc` @ `~/code/un1t-crm-p3bc` (off `origin/main`, has Phases 1/2/3a)

## Problem / goal

The paid class funnel charges via **Revolut only** today (Phase 1 guards against any
other rail). Operators should be able to choose **Stripe Connect per location** so a
location settles the intro payment to **its own** Stripe account (a direct charge),
not UN1T's Revolut merchant. This needs the Stripe code path (3b) and the operator
config + onboarding to set it up (3c).

Reuses the proven Stripe Connect infra already built for events hosting
(`payments/stripe-connect.js`: `createPayment` w/ `stripeAccount`, `getPayment`,
`createConnectedAccount`, `createOnboardingLink`, `retrieveAccountStatus`).

## Product decisions (confirmed)

- **Per-location rail** via `locations.settings.payments` (Revolut default; Stripe
  when configured + charges-enabled). Already the Phase-1 resolver shape.
- **Full in-app Stripe onboarding** — the settings UI creates a connected account,
  hands the operator a Stripe-hosted onboarding link, and shows charges-enabled
  status (reusing the events-host onboarding functions).
- Stripe path is a **direct charge on the location's connected account**, no UN1T
  application fee for the intro (it's the location's own sale). `applicationFeeCents: 0`.

## Non-goals
- No refund UI (staff refund via the provider dashboard — unchanged from 3a).
- No change to fulfillment/grant logic or the review flow (3a stands).
- No multi-account-per-location; one connected account per location.

## What exists (reuse — verified on `main`)
- `paymentsFor(provider)` dispatcher; `stripe-connect.js`:
  - `createPayment({ amountCents, currency, description, returnUrl, metadata, connectedAccountId, applicationFeeCents })` → attaches `metadata` to the Checkout Session (so the webhook can domain-branch), returns `{ providerRef, checkoutToken(=client_secret), state, amountCents }`.
  - `getPayment(providerRef, { connectedAccountId })` → `{ state, amountCents }` (provider-agnostic).
  - `createConnectedAccount({ name, email, hostId, country })`, `createOnboardingLink({ accountId, refreshUrl, returnUrl })`, `retrieveAccountStatus(accountId)`.
- The Stripe webhook `/api/webhooks/stripe` handles `checkout.session.completed`/`expired`/`charge.refunded` for `race_payments` (resolve by `session.id`). `session.metadata` is available on the event object.
- `RaceCheckoutPage.jsx` Stripe branch: `loadStripe(pubKey, { stripeAccount })` → `stripe.createEmbeddedCheckoutPage({ clientSecret, onComplete })`.
- Phase-1 class-booking payment lifecycle: `createClassBookingPayment`, `markClassBookingPaymentStatus`, `resolveClassBookingPaymentByRef`; the class-booking poll route + a Revolut-signed webhook.
- `locations.settings` JSONB persisted by the existing location-settings save path (as `settings.glofox` is by `GlofoxIntegrationTab`).

---

## 3b — Stripe rail (code path)

### Migration (forward-only, MCP)
Add `connected_account_id text` to `class_booking_requests` (Stripe direct charges
need the account for `getPayment` re-check + refunds). Nullable; NULL for Revolut.

### 1. `createClassBookingPayment` (`src/lib/class-booking-payments.js`)
- Remove the `provider !== 'revolut'` guard (Phase-1 landmine guard — 3b provides the
  release path it was waiting for).
- Persist `connected_account_id: connectedAccountId` on the row alongside the other
  payment fields (the resolver already returns it; Stripe needs it, Revolut → null).
- Keep the ref-persist error check (3a/P2 hardening).

### 2. Generalize the poll re-check (`/api/public/class-booking-payments/[id]`)
Replace the Revolut-only `getOrder(...)` block with provider-agnostic:
```js
const norm = await paymentsFor(row.payment_provider).getPayment(row.payment_provider_ref, { connectedAccountId: row.connected_account_id || null })
if (norm) { const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: norm.state, providerAmount: norm.amountCents }); ... }
```
Gate the re-check on `payment_status === 'pending' && (provider === 'revolut' || provider === 'stripe_connect') && payment_provider_ref` (mirrors `refreshRacePaymentFromProvider`). Keep the per-booking rate-limit (P2).

### 3. Stripe webhook branch (`src/app/api/webhooks/stripe/route.js`)
In the `checkout.session.completed` and `checkout.session.expired` handlers, branch
FIRST on the class-booking domain:
```js
if (session.metadata?.domain === 'un1t_class_booking') {
  const row = await resolveClassBookingPaymentByRef(db, session.id)
  if (row) {
    const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: <completed|cancelled>, providerAmount: session.amount_total })
    if (released) publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, ... })
  }
  return 200
}
// else existing race path (unchanged)
```
Idempotent (state-machine guards) + 200 always. `charge.refunded` stays race-only for
now (no class-booking refund path this phase).

### 4. `ClassFunnelCheckout` Stripe mount (`src/components/landing-page/ClassFunnelCheckout.jsx`)
Add a Stripe branch alongside the Revolut one (mirror `RaceCheckoutPage`):
- `checkout.provider === 'stripe_connect'` → `loadStripe(NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, { stripeAccount: checkout.connectedAccountId })` → `stripe.createEmbeddedCheckoutPage({ clientSecret: checkout.token, onComplete: markPaid })` → mount.
- Extract the Stripe loader (`loadStripe` cache) into a shared client helper (or inline mirroring RaceCheckoutPage) — keep it small. The poll fallback already covers redirect methods.
- Error when `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` missing (mirror RaceCheckoutPage).

## 3c — payments settings + Stripe onboarding

### 1. Settings surface
A "Payments" section in the location integration settings (beside the Glofox tab in
`LocationIntegrations.jsx`), reading/writing `locations.settings.payments`:
- **Provider** select: `Revolut (UN1T)` | `Stripe (this location)`.
- When Stripe: show connected-account status + onboarding.
- Saves via the existing location-settings save path (merge into `settings.payments`,
  never clobber other slices — same pattern as `GlofoxIntegrationTab`).

### 2. Stripe onboarding (full, in-app)
New authed API route(s) under `src/app/api/locations/[id]/stripe-connect/`:
- `POST .../account` → `createConnectedAccount({ name: location.name, email, hostId: locationId, country })` (generalize the `hostId` param to accept a location ref, or add an optional `locationRef`); store the returned `acct_` id on `settings.payments.stripe_connected_account_id`.
- `POST .../onboarding-link` → `createOnboardingLink({ accountId, refreshUrl, returnUrl })`; return the URL for the operator to complete Stripe's hosted onboarding.
- `GET .../status` → `retrieveAccountStatus(accountId)` → `{ charges_enabled }`; the UI shows "Ready" / "Finish setup".
- Auth: master/owner/manager at the location (mirror the glofox-memberships route's `ALLOWED_ROLES` + location check).
- The settings UI drives these: Connect → create account → open onboarding link (new tab) → Refresh status.

### 3. `locationCanTakePayments` (`src/lib/location-payments.js`)
Already returns `false` for Stripe without a connected account. Extend the settings
UI to only let an operator *select* Stripe once `charges_enabled` (or warn clearly).
The route's `paid` gate (`locationCanTakePayments`) already prevents charging on an
un-onboarded Stripe location (falls back to free booking) — keep that as the belt.

## Data flow (Stripe)
```
Editor: settings.payments = { provider:'stripe_connect', stripe_connected_account_id:'acct_x' }
Booking (paid): route → createClassBookingPayment → resolver picks stripe_connect + acct
   → stripe createPayment (direct charge on acct, metadata.domain='un1t_class_booking')
   → row: payment_provider='stripe_connect', payment_provider_ref=session.id, connected_account_id=acct, checkout token=client_secret
Funnel: ClassFunnelCheckout mounts Stripe embedded checkout (stripeAccount=acct)
Stripe webhook checkout.session.completed (metadata.domain match) → mark paid → release → processor grants+books
Poll re-check: getPayment(session.id, {connectedAccountId}) as the fallback
```

## Security / invariants
- Amount still server-derived (Phase 1); client only mounts against the session.
- Stripe webhook already signature-verified; add the class-booking branch inside the
  verified handler; idempotent + 200.
- Onboarding routes are authed (master/owner/manager + location scope); the
  connected-account id is operator config, never client-supplied on the public path.
- Migration additive + forward-only; `get_advisors` after; applied before code.
- No PII on public surfaces; poll route unchanged shape.

## Testing
- Unit: poll re-check provider-dispatch (revolut vs stripe → getPayment called with the
  connected account); `createClassBookingPayment` persists connected_account_id for
  stripe and null for revolut and no longer throws for stripe.
- Unit: the Stripe webhook domain-branch (metadata match → class path; no match → race
  path) — extract the branch into a testable helper if the route is awkward to unit-test.
- Manual (Stripe test mode): onboard a test connected account via the settings UI; set a
  location to Stripe; run the paid funnel → embedded Stripe checkout mounts → test-pay →
  webhook releases → booking grants+books; poll fallback works; a Revolut location still
  works unchanged.
- CI mirror + `check:location-scoping` (new authed routes) + build.

## Phasing / PRs
Build **3b first** (rail code path — dormant until a location is set to Stripe, so
mergeable safely like Phase 1), then **3c** (settings + onboarding) makes it operable.
Two PRs with a checkpoint, or one — the plan will sequence 3b tasks then 3c tasks.

## Open questions
None blocking. (Full onboarding confirmed; per-location single account; no app fee; no
refund UI.)
