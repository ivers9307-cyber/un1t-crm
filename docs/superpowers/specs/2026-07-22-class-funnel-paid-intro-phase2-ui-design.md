# Paid Intro Offer — Phase 2 (Funnel Payment UI)

**Date:** 2026-07-22
**Status:** Design — approved in brainstorming, pending spec review
**Branch / worktree:** `class-funnel-pay-ui` @ `~/code/un1t-crm-payui` (off `origin/main`, has Phase 1 #1056)

## Problem / goal

Phase 1 shipped the payment backend: a `class_funnel` block with `price_cents > 0`
makes the booking route return `{ requiresPayment, paymentId, checkout }` and holds
the booking `awaiting_payment`. But nothing consumes that yet — there's no way for a
customer to pay and no way for an operator to set a price. Phase 2 makes the paid
funnel usable end-to-end:

1. The funnel shows an **inline embedded Revolut checkout** step and advances to
   the "booked" screen once paid.
2. The editor gets a **price field**.
3. The Revolut **`returnUrl` page** (`/class-pay/[id]`) exists (Phase 1 already
   points at it) so a 3DS/redirect payment method lands somewhere real.

After this phase, an operator can set a price on the Stillorgan funnel block and a
customer can pay → be granted the Glofox product + booked, end to end (on Revolut).

## Product decisions (confirmed)

- **Inline embedded checkout** inside the funnel card (not a redirect) — one
  seamless flow, matching the funnel's single-frosted-card feel.
- Revolut only (Phase 1 charges Revolut only; Stripe rail is Phase 3).
- Reuse the existing checkout styling / funnel visual language — no net-new bespoke
  design surface (the visible additions are a small heading + price line around the
  third-party widget, styled like the rest of the card).

## Non-goals (Phase 3)

- Paid fulfillment change (grant for existing members too) + staff review `paid` flag.
- Operator `settings.payments` UI + the Stripe-Connect rail/release path.
- Refund UI.

## What exists (reuse — verified on `main`)

- `src/components/RaceCheckoutPage.jsx` — mounts the Revolut Embedded SDK inline
  against a checkout token and polls a public status route. Its SDK loader
  (`loadRevolutSdk`, `SDK_URLS`, `REVOLUT_MODE`, `REVOLUT_PUBLIC_KEY`) is the piece
  to share. The Revolut mount API:
  `RC.embeddedCheckout({ publicToken, mode, locale, target, createOrder: async () => ({ publicId: token }), onSuccess, onError, onCancel })`.
- `GET /api/public/class-booking-payments/[id]` (Phase 1) — status poll (`paid`,
  `booking_status`, `payment_status`, `checkout`, `class_name`), with a provider
  re-check when pending.
- `src/components/ClassFunnel.jsx` — `bookClass()` posts to `/api/public/class-booking`
  and currently jumps to the `classdone` step. Its step machine
  (`details|calendar|classpick|done|classdone`) is where a `payment` step slots in.
- `src/components/LandingPageSettingsForm.jsx` `ClassFunnelEdit` — where the price
  field goes (`Field`/`Input` helpers already used).

## Architecture

### 1. Shared Revolut embed loader — `src/lib/revolut-embed.js` (new, client)
Extract from `RaceCheckoutPage`: `loadRevolutSdk(mode)`, `REVOLUT_SDK_URLS`,
`revolutMode()` (reads `NEXT_PUBLIC_REVOLUT_MODE`), `revolutPublicKey()` (reads
`NEXT_PUBLIC_REVOLUT_PUBLIC_KEY`). Pure browser helpers, unit-light (guarded against
SSR). Refactor `RaceCheckoutPage` to import from here (behaviour-preserving) so the
loader has ONE home.

### 2. Funnel payment step — `src/components/ClassFunnel.jsx`
- `bookClass()`: when the response is `j.data.requiresPayment`, stash
  `setPayment({ paymentId: j.data.paymentId, checkout: j.data.checkout })` and
  `setStep('payment')` INSTEAD of `setStep('classdone')`. Free path unchanged (still
  `classdone`). Fire a `fireStep('payment_view')` telemetry step.
- New `payment` step render: a heading ("Secure checkout" + the price), a
  `<div ref={payTargetRef}>` mount target, and error/loading states — styled with the
  existing funnel card classes. An effect mounts `RC.embeddedCheckout(...)` against
  `payment.checkout.token` once the step + target exist (mirrors RaceCheckoutPage;
  only Revolut — `payment.checkout.provider === 'revolut'`).
  - `onSuccess`: `fireStep('paid')`, then advance to `classdone` (the webhook/poll
    releases the booking server-side; the "you're being booked in" copy already
    covers the async grant+book).
  - `onError`: show the error in-card, let them retry.
  - `onCancel`: return to the `classpick` step (or stay with a "resume" affordance).
  - Cleanup destroys the instance on unmount/step change.
- A lightweight poll of `GET /api/public/class-booking-payments/[id]` as a fallback
  (in case `onSuccess` doesn't fire on some payment methods): while on the `payment`
  step, poll every ~3s; when `paid`, advance to `classdone`. Stop on leave.

### 3. Editor price field — `ClassFunnelEdit`
Add a "Price (€)" `<Input>` bound to `price_cents` via euros↔cents conversion
(display `price_cents/100`; write `Math.round(euros*100)`; empty/0 ⇒ free). Hint:
"Leave blank/0 for a free trial. If set, the funnel charges this for the chosen trial
product — the location's payment rail must be configured." Also surface it in
`summaryFor` (e.g. `· €29`).

### 4. Return page — `src/app/class-pay/[id]/page.js` (new, public)
The Revolut `returnUrl` target (Phase 1 set `${getAppUrl()}/class-pay/${id}`). A
minimal public page (client island) that polls `GET /api/public/class-booking-payments/[id]`
and renders one of: paid → "You're booked 🎉 …", pending → "Confirming your
payment…" (keep polling), `payment_failed` → "Payment didn't go through" + a link
back. No PII. Add `/class-pay/` to the `proxy.js` public allowlist AND the
`AppShell` publicPaths (a top-level public path needs both — per the legal-pages
lesson) so a logged-out payer isn't bounced to login.

## Data flow
```
classpick → bookClass() → POST /api/public/class-booking
   free:  { queued:true }               → step 'classdone' (unchanged)
   paid:  { requiresPayment, checkout }  → step 'payment'
payment step: mount RC.embeddedCheckout(checkout.token)
   onSuccess / poll sees paid → step 'classdone'
   (server: webhook released awaiting_payment→queued → processor grants + books)
3DS/redirect method → returnUrl /class-pay/[id] → polls status → same messaging
```

## Security / invariants
- No new server surface for money — the amount was fixed server-side in Phase 1;
  the client only mounts a checkout against an existing order token.
- `/class-pay/[id]` + the poll route return only display-safe fields (no PII);
  the id is the unguessable capability token.
- New top-level public path `/class-pay/` → add to BOTH `proxy.js` allowlist and
  `AppShell` publicPaths (the three-gate rule; `[id]` is dynamic so it lives outside
  auth-gated segments already).
- Customer-facing copy (payment heading, return-page messages) operator-editable
  where it reasonably can be, else sensible defaults (the funnel already threads
  editable copy; the payment step's few strings default in the component).

## Testing
- Unit: euros↔cents conversion in the editor helper (0/empty→free; 29→2900;
  rounding). `revolut-embed` loader guards (SSR reject; caches the promise).
- Component/manual (Revolut sandbox): set a price on the Stillorgan block; run the
  funnel → pick class → the embedded checkout mounts → sandbox-pay → advances to
  "booked" and the booking row goes `awaiting_payment`→`queued`→booked. Cancel/error
  paths behave. Free funnel (price 0) still books with no payment step.
- `/class-pay/[id]` renders paid/pending/failed correctly.
- CI mirror + `check:location-scoping` (Phase-1 lesson: not in the six-check mirror)
  + `npm run build`.

## Rollout
- Env: `NEXT_PUBLIC_REVOLUT_MODE`, `NEXT_PUBLIC_REVOLUT_PUBLIC_KEY` must be set for
  the embed to render (already used by RaceCheckoutPage in prod).
- No migration. Additive UI. A block's `price_cents` stays 0 until an operator sets
  it, so nothing changes for existing funnels on deploy.

## Open questions
None blocking. (Inline checkout confirmed; Revolut-only confirmed; copy defaults in
the component.)
