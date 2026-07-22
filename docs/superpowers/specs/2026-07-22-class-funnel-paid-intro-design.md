# Paid intro offer in the Glofox Class Booking Funnel

**Date:** 2026-07-22
**Status:** Design (scoping) — approved in brainstorming, pending spec review
**Branch / worktree:** `class-funnel-payments` @ `~/code/un1t-crm-pay` (off `origin/main`, has #1050/#1051/#1052)

## Problem / goal

Let a `class_funnel` landing-page block **charge** for its intro offer instead of
giving it away free. The customer pays (e.g. €29 for a 3-class intro), and on
successful payment the funnel grants the chosen Glofox membership product and
books the first class — reusing the trial-product machinery shipped in #1052.

This turns a *free-trial capture* funnel into a *paid-purchase* funnel, per-block
and opt-in. It is a real payment lifecycle and is **deliberately larger** than the
prior funnel changes; it should ship in phases (see Phasing).

## Product decisions (all user-confirmed)

1. **What's paid for:** a paid **intro offer / class pack** — the same Glofox
   `num_classes` membership product the trial picker already grants, now charged
   for. Non-refundable purchase.
2. **Merchant / rail:** operator picks **per location** (Revolut or Stripe
   Connect) via the existing provider dispatcher. Revolut = UN1T is merchant
   (works out of the box); Stripe Connect = per-location connected account.
3. **Price:** the **operator sets it on the block** (`price_cents`). May differ
   from the Glofox list price. `price_cents` unset/0 ⇒ today's free trial.
4. **Payment succeeds but fulfillment fails:** **keep the money, route to staff**
   (record payment, flag the review item `paid` so staff complete the Glofox
   grant + booking manually). No auto-refund.
5. **Provider config location:** a **new per-location payment setting** at
   `locations.settings.payments` (mirrors `locations.settings.glofox`).

## Non-goals

- No recurring/membership billing (this is a one-off charge).
- No refund UI in v1 (payments are non-refundable; staff can refund in the
  provider dashboard if needed — the adapter already exposes `refundPayment`).
- No change to free funnels: `price_cents` unset/0 behaves exactly as today.
- No new Stripe-Connect onboarding flow — a location using Stripe must already
  have a connected account (reuse the events-hosting onboarding); Revolut is the
  default and the first rail shipped.

## What already exists (reuse — verified on `main`)

- **Provider dispatcher** `src/lib/payments/index.js` — `paymentsFor(name)` over
  `revolut` / `stripe_connect` adapters, each exposing
  `createPayment/getPayment/refundPayment`. Processor-agnostic. Reuse as-is.
- **Orchestration pattern** `src/lib/race-payments.js` — `createRacePayment`
  (insert row + provider order), `markRacePaymentStatus` (webhook state change),
  `resolveRacePaymentByProviderRef`. **Deliberately race-specific** ("does NOT
  touch other tables"), so we MIRROR it in a new module, not reuse it.
- **Public checkout + poll** — `src/app/event-pay/[paymentId]/page.js` (embedded
  provider checkout) and `GET /api/public/event-payments/[id]/route.js` (status
  poll with live provider re-check). Patterns to adapt.
- **Signed webhooks** — `src/app/api/webhooks/revolut/race-payments/route.js` and
  `src/app/api/webhooks/stripe/route.js`. New booking-payment webhook mirrors the
  verify → mark-status → confirm shape.
- **The queue** `class_booking_requests` + `class-booking-queue.js` +
  `class-booking-processor.js` — the fulfillment engine. Reuse; add a payment
  gate in front.
- **The paid product itself** — the block's `trial_membership_id`/
  `trial_plan_code` (#1052) IS the intro product; `findOrCreateGlofoxMember`'s
  `trialOverride` already grants it. Reuse.

## Architecture

### Provider resolution (new, per-location)
Add `src/lib/location-payments.js`:
- `resolveLocationPaymentProvider(location)` → reads
  `location.settings.payments.provider` (`'revolut'` default) and, for
  `stripe_connect`, the `stripe_connected_account_id`.
- `locationCanTakePayments(location)` → guard (Revolut always ok; Stripe needs a
  charges-enabled connected account).
Mirrors `getLocationTrialConfig` (glofox-push.js) and `event-hosts.js`, but keyed
on the location, not an event host.

### Payment lifecycle (on `class_booking_requests`, no new table)
A booking has at most one payment → columns on the row are simpler than a sibling
table. **Migration** (forward-only, MCP, applied before code): add to
`class_booking_requests`:
- `payment_status text` (`null` for free; else `pending|paid|failed|expired`)
- `payment_provider text`, `payment_provider_ref text`, `payment_checkout_token text`
- `amount_cents int`, `currency text`
- new value for the existing `status` column: **`awaiting_payment`**.

New module `src/lib/class-booking-payments.js` (mirrors race-payments):
- `createClassBookingPayment({ db, request, location, amountCents, currency })` →
  resolve provider → `paymentsFor(provider).createPayment(...)` → store
  `payment_provider_ref` + `payment_checkout_token` on the row (already inserted
  `awaiting_payment`). Returns the checkout handle for the funnel.
- `markClassBookingPaymentStatus(db, ref, status)` → on `paid`, flip the row
  `status` `awaiting_payment → queued` and stamp `payment_status='paid'`, then
  nudge the queue (QStash push / cron picks it up). On `failed`/`expired`, set
  `payment_status` + a terminal row status; no booking.
- `resolveClassBookingPaymentByRef(db, ref)` → webhook lookup.

### Flow
```
Funnel details → pick class → (block.price_cents > 0 ?)
  paid:  POST /api/public/class-booking { …, path }         [route: paid branch]
           → INSERT class_booking_requests status='awaiting_payment' (+ trial product from block)
           → createClassBookingPayment(...) → provider order
           → 200 { requiresPayment:true, paymentId, checkout:{ token, provider, connectedAccountId? } }
         Funnel mounts embedded checkout (reuse event-pay component) → polls
           GET /api/public/class-booking-payments/[id]  (status; live provider re-check if pending)
  free:  unchanged — INSERT status='queued' → processor (as today)

Webhook (signed): payment paid
  → markClassBookingPaymentStatus(ref,'paid') → row → 'queued'
  → class-booking-processor grants block product + books (paid path: grant for new AND existing)
  → on fulfillment failure → routeToReview(..., paid:true)   [money kept]
```

### Fulfillment change (processor)
- New helper input: the row is paid when `payment_status='paid'`. On the paid
  path, grant the block's product + book for **both new and existing** members
  (they purchased it) — unlike the free path where existing-no-credit →
  `needs_credit_grant`. On any failure after payment, `routeToReview` with a
  `paid` marker on the `agent_membership_requests` review row so staff know money
  was collected.

### Funnel UI (`ClassFunnel.jsx`)
- New step `payment` between `classpick` and `classdone`, shown only when the
  booking response is `requiresPayment:true`. Renders the embedded checkout
  (reuse the `event-pay` checkout island) + polls the status route; on `paid`,
  advance to the existing `classdone` screen. Free funnels never see it.
- Operator-editable copy for the payment step (price shown, "secure checkout"
  line) per the operator-editable-copy invariant.

### Block config + editor
- Factory: `price_cents: 0`, `currency: 'EUR'`.
- `ClassFunnelEdit`: a price field (euros → cents) with a hint that the charged
  product is the chosen trial product, and a note that payment needs
  `locations.settings.payments` configured (link/guidance). Payment is implicitly
  ON when `price_cents > 0`.
- Settings → Locations: a small payments section to set provider (+ Stripe
  connected account). (Could be its own small slice.)

## Security / invariants
- Public routes stay service-role + rate-limited; the **amount is derived
  server-side from the block config**, never from the client (client can't set
  its own price).
- Webhooks: signature-verified, idempotent, 200 on unknown events (provider
  auto-disable rule).
- Money movement is provider-driven and confirmed only by the signed webhook
  (never trust the client's "paid"); the poll route's live re-check is a UX
  latency optimisation, not the source of truth.
- Migration additive + forward-only; `get_advisors` after; applied before code.
- No card/PII data touches our DB — only provider refs/tokens (embedded checkout
  is hosted by the provider).

## Phasing (each its own spec→plan→PR)
1. **Payment lifecycle backend** — migration, `location-payments.js`,
   `class-booking-payments.js`, webhook handler, public status-poll route,
   route paid-branch. Testable via provider sandbox; no funnel UI yet.
2. **Funnel UI payment step** — `ClassFunnel` `payment` step + checkout island +
   editor price field + block config. Makes it usable end-to-end.
3. **Paid fulfillment wiring + staff review `paid` flag** — processor paid path
   (grant for new+existing) + review-row marker + operator payments settings UI.

(Some of 3 can fold into 1; sequence is the guide, not a contract.)

## Testing
- Unit: `resolveLocationPaymentProvider` (revolut default / stripe with account /
  guard), `class-booking-payments` state transitions (pending→paid→queued;
  failed/expired terminal), amount-from-block derivation.
- Integration: webhook verify + idempotent mark; poll route status shapes.
- Manual (sandbox): full paid funnel on a test provider account — pay → grant +
  book; simulate fulfillment failure → row paid + routed to staff with `paid`.
- CI mirror + build each phase; migration via MCP.

## Open questions
None blocking. Deferred by design: refund UI, Stripe-Connect per-location
onboarding, recurring membership sales.
