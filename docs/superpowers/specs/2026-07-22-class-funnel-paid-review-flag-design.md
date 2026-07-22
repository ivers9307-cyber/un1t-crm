# Paid Intro Offer — Phase 3a: staff-review "paid" flag

**Date:** 2026-07-22
**Status:** Design — approved in brainstorming, pending spec review
**Branch / worktree:** `class-funnel-pay-p3` @ `~/code/un1t-crm-payp3` (off `origin/main`, has Phases 1+2)

## Problem / goal

The paid class funnel (Phases 1+2, live on Revolut) grants a **discounted
new-customer** intro product only to genuinely new members. A paying customer who
lands in **staff review** — an existing member with no credit (correctly NOT
auto-granted the new-customer discount), or any fulfillment failure after payment
("keep the money, route to staff", the Phase-1 decision) — must be visibly flagged
as **paid**, with the amount, so staff can act knowing money was collected (grant
manually / refund / follow up).

Today the review item (`agent_membership_requests`, kind `class_booking`) shows the
class + time but nothing about payment.

## Product decisions (confirmed)

- Visible **"Paid €X" flag** on the review item — enough for 3a.
- **No refund action button** in 3a (staff refund via the provider dashboard for
  now; a refund surface is a separate, riskier feature).
- **No change to which bookings route to review** — the "discounted product for new
  customers only" rule is unchanged; existing members still route to review, now
  just flagged paid.

## Non-goals

- Refund UI/action.
- The Stripe rail / payment-settings UI (Phase 3b/3c).
- Any change to fulfillment/grant logic.

## Architecture — three small changes

### 1. Processor (`src/lib/class-booking-processor.js`, `routeToReview`)
The review row is inserted with
`details: { event_id, class_name, class_time, mode, source, reason }`. When the
booking row is paid, add payment fields:
```js
...(request.payment_status === 'paid'
  ? { paid: true, amount_cents: request.amount_cents, currency: request.currency }
  : {}),
```
`request` is the `class_booking_requests` row (already carries
`payment_status`/`amount_cents`/`currency` from Phase 1). Free bookings add nothing
— unchanged. (Note: the row status was `queued` when the processor ran, so
`payment_status==='paid'` is the discriminator, not `status`.)

### 2. Approvals provider (`src/lib/approvals/providers/agent-requests.js`)
- `agentRequestSubtitle(row)` — for `class_booking`, append a paid marker when
  `d.paid`: e.g. `class_name · class_time · 💳 Paid €29`. Use a small shared money
  formatter (see below).
- The provider's item mapping currently hardcodes `amount: null, currency: null`.
  Populate them from the details for a paid class booking so the `/approvals` card
  shows the amount natively:
  `amount: r.details?.paid ? r.details.amount_cents : null`,
  `currency: r.details?.paid ? (r.details.currency || 'EUR') : null`.

### 3. Requests page (`src/app/settings/customer-agent/requests/page.js`)
In the request detail render (`const d = r.details`), show a "Paid €29" badge/line
when `d.paid` (styled with the existing chip/badge classes; light-theme contrast
per the invariant — `bg-*-500/10 text-*-700`).

### Money formatter
Add a tiny pure helper `formatMoneyMinor(amountCents, currency = 'EUR')` in a shared
lib (e.g. `src/lib/money-format.js`) → `'€29'` / `'€29.50'` / `'£10'` (symbol for
EUR/GBP, else `<code> 29.00`). Used by the subtitle and the requests page. Unit-tested.
(Distinct from `price-format.js`, which is the euros↔cents editor helper; keep them
separate — one is display, one is input parsing.)

## Testing
- Unit: `formatMoneyMinor` (EUR/GBP symbols, decimals, zero, non-EUR code fallback).
- Unit: `agentRequestSubtitle` — paid class booking appends the marker; free one
  doesn't; other kinds unchanged.
- Unit: the provider item mapping sets `amount`/`currency` for a paid class booking
  and leaves them null otherwise (if the map is testable in isolation; else assert
  via `agentRequestSubtitle` + a light integration check).
- CI mirror + `check:location-scoping` + build. No migration.

## Security / invariants
- No new surface; the review item already respects location scoping (the provider
  filters by `activeId`/location).
- Amounts come from the server-written booking row, never a client.
- Chip contrast per the light-theme invariant.

## Rollout
Additive, no migration. On deploy, new paid bookings that route to review show the
flag; pre-existing review rows simply lack the field (render as before).

## Open questions
None. (Flag only, no refund button — confirmed.)
