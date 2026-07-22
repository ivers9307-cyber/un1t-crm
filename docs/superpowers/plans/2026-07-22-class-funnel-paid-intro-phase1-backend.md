# Paid Intro Offer — Phase 1 (Payment Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side payment lifecycle for a paid class-funnel intro — when a `class_funnel` block carries a price, the public booking route creates a provider payment and holds the booking `awaiting_payment`; a signed webhook flips it to `queued` on payment, so the existing processor grants the block's Glofox product + books. No funnel UI yet (Phase 2).

**Architecture:** Reuse the payments dispatcher (`paymentsFor`) and mirror the proven `race-payments.js` lifecycle in a new `class-booking-payments.js`, keyed off the `class_booking_requests` row (new payment columns + an `awaiting_payment` status). Per-location rail resolves from a new `locations.settings.payments` config. Amount is derived server-side from the block (`price_cents`), never the client.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role + MCP migration), Revolut/Stripe-Connect adapters, Zod, Vitest.

**Worktree:** `~/code/un1t-crm-pay` (branch `class-funnel-payments`, off `origin/main` — has #1050/#1051/#1052).

**Spec:** `docs/superpowers/specs/2026-07-22-class-funnel-paid-intro-design.md`

**⚠️ Deploy order:** the migration (Task 1) is applied to un1t-crm BEFORE the code deploys. Additive + nullable → safe to apply early.

**Scope of THIS phase:** backend only. Out: funnel UI payment step, editor price field, the operator payments-settings UI, paid-fulfillment "grant for existing member" change (Phase 3). Phase 1 is testable via the API + a provider sandbox; a price is set on a block directly (DB) to exercise the paid branch.

---

## File Structure

**Migration (MCP + mirror file):** `class_booking_requests` gains `payment_status`, `payment_provider`, `payment_provider_ref`, `payment_checkout_token`, `payment_checkout_url`, `amount_cents`, `currency` (all nullable); `status` gains the value `awaiting_payment`.

**Create:**
- `src/lib/location-payments.js` (+ `.test.js`) — per-location rail resolution.
- `src/lib/class-booking-payments.js` (+ `.test.js`) — payment lifecycle (mirror of race-payments).
- `src/app/api/webhooks/revolut/class-bookings/route.js` — signed Revolut webhook → mark paid → release booking.
- `src/app/api/public/class-booking-payments/[id]/route.js` — public status poll.

**Modify:**
- `src/lib/public-landing.js` (+ `.test.js`) — `classFunnelConfigFromBlocks` also returns `priceCents`/`currency`.
- `src/lib/landing-page-blocks.js` (+ `.test.js`) — `CLASS_FUNNEL_DEFAULT` gains `price_cents: 0`, `currency: 'EUR'`.
- `src/app/api/public/class-booking/route.js` — paid branch.
- `src/lib/webhook-events.js` — add `REVOLUT_CLASS_BOOKING` provider constant.

**Reused as-is:** `src/lib/payments/index.js` (`paymentsFor`), `src/lib/revolut.js` (`verifyWebhookSignature`, `getOrder`), `src/lib/app-url.js` (`getAppUrl`), the class-booking queue/processor.

---

## Task 1: Migration — payment columns + `awaiting_payment` status

Applied via Supabase MCP against the **un1t-crm** project (ref `iyvtbjjxdggiadzwwvdj`; confirm via `list_projects`, NOT the sentinel project).

**Files:** MCP migration + `supabase/migrations/<N>_*.sql` mirror.

- [ ] **Step 1: Confirm project** — MCP `list_projects`; confirm `iyvtbjjxdggiadzwwvdj` is un1t-crm.

- [ ] **Step 2: Apply migration** — MCP `apply_migration`, name `add_payment_to_class_booking_requests`, SQL:
```sql
alter table public.class_booking_requests
  add column if not exists payment_status text,
  add column if not exists payment_provider text,
  add column if not exists payment_provider_ref text,
  add column if not exists payment_checkout_token text,
  add column if not exists payment_checkout_url text,
  add column if not exists amount_cents integer,
  add column if not exists currency text;

comment on column public.class_booking_requests.payment_status is
  'NULL = free booking (no payment). Else pending|paid|failed|expired. Set only via the signed provider webhook / provider re-check.';
comment on column public.class_booking_requests.payment_provider_ref is
  'Provider order/session id used for webhook lookup and status re-check.';

create index if not exists class_booking_requests_payment_provider_ref_idx
  on public.class_booking_requests (payment_provider_ref)
  where payment_provider_ref is not null;
```
Note: `status` is a free `text` column (no enum/check constraint to alter) — `awaiting_payment` is a new value the code writes; verify in Step 4 that no check constraint rejects it.

- [ ] **Step 3: Advisors** — MCP `get_advisors` (type=security). Expected: no NEW finding attributable to these nullable columns / partial index.

- [ ] **Step 4: Verify** — MCP `execute_sql`:
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='class_booking_requests'
   and column_name in ('payment_status','payment_provider','payment_provider_ref',
                       'payment_checkout_token','payment_checkout_url','amount_cents','currency');
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.class_booking_requests'::regclass and contype='c';
```
Expected: 7 columns present; the second query shows NO check constraint that restricts `status` values (if one exists that would reject `awaiting_payment`, STOP and report — the plan needs a constraint update).

- [ ] **Step 5: Mirror file + commit** — highest existing migration number is 437 (from #1052; do not renumber intentional duplicates). Use `438`. Create `supabase/migrations/438_add_payment_to_class_booking_requests.sql` with the exact Step 2 SQL, then:
```bash
cd ~/code/un1t-crm-pay
git add supabase/migrations/438_add_payment_to_class_booking_requests.sql
git commit -m "PAID-INTRO.1 — mig: payment columns + awaiting_payment on class_booking_requests"
```

---

## Task 2: `location-payments.js` — per-location rail (TDD)

**Files:** Create `src/lib/location-payments.js`, `src/lib/location-payments.test.js`.

- [ ] **Step 1: Write failing tests** — `src/lib/location-payments.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { resolveLocationPaymentProvider, locationCanTakePayments } from './location-payments'

const loc = (payments) => ({ settings: { payments } })

describe('resolveLocationPaymentProvider', () => {
  it('defaults to revolut when unset', () => {
    expect(resolveLocationPaymentProvider(loc(undefined))).toEqual({ provider: 'revolut', connectedAccountId: null })
    expect(resolveLocationPaymentProvider({})).toEqual({ provider: 'revolut', connectedAccountId: null })
  })
  it('returns stripe_connect with the connected account when configured', () => {
    expect(resolveLocationPaymentProvider(loc({ provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' })))
      .toEqual({ provider: 'stripe_connect', connectedAccountId: 'acct_1' })
  })
  it('falls back to revolut for an unknown provider value', () => {
    expect(resolveLocationPaymentProvider(loc({ provider: 'paypal' })).provider).toBe('revolut')
  })
})

describe('locationCanTakePayments', () => {
  it('revolut is always able', () => {
    expect(locationCanTakePayments(loc({ provider: 'revolut' }))).toBe(true)
    expect(locationCanTakePayments(loc(undefined))).toBe(true)
  })
  it('stripe_connect needs a connected account', () => {
    expect(locationCanTakePayments(loc({ provider: 'stripe_connect' }))).toBe(false)
    expect(locationCanTakePayments(loc({ provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run — verify fail**
`cd ~/code/un1t-crm-pay && npx vitest run src/lib/location-payments.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/location-payments.js`:
```js
// Per-location payment rail for the class funnel (paid intro offer).
// Mirrors getLocationTrialConfig (glofox-push.js) — config lives on the
// location, at settings.payments. Revolut = UN1T is the merchant of record
// (shared merchant account, no per-location account needed). Stripe Connect =
// the location's own connected account (must be onboarded via the events-host
// flow before it can charge).
const PROVIDER_REVOLUT = 'revolut'
const PROVIDER_STRIPE_CONNECT = 'stripe_connect'

export function resolveLocationPaymentProvider(location) {
  const p = location?.settings?.payments || {}
  if (p.provider === PROVIDER_STRIPE_CONNECT) {
    return { provider: PROVIDER_STRIPE_CONNECT, connectedAccountId: p.stripe_connected_account_id || null }
  }
  return { provider: PROVIDER_REVOLUT, connectedAccountId: null }
}

export function locationCanTakePayments(location) {
  const { provider, connectedAccountId } = resolveLocationPaymentProvider(location)
  if (provider === PROVIDER_STRIPE_CONNECT) return !!connectedAccountId
  return true // Revolut: shared UN1T merchant, always able
}
```

- [ ] **Step 4: Run — verify pass** → all pass.

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-pay
git add src/lib/location-payments.js src/lib/location-payments.test.js
git commit -m "PAID-INTRO.2 — per-location payment rail resolver (settings.payments)"
```

---

## Task 3: Block price plumbing — factory default + helper (TDD)

The amount is derived server-side from the block. Extend the block factory and `classFunnelConfigFromBlocks`.

**Files:** Modify `src/lib/landing-page-blocks.js` (+ test), `src/lib/public-landing.js` (+ test).

- [ ] **Step 1: Factory default** — in `CLASS_FUNNEL_DEFAULT` (`src/lib/landing-page-blocks.js`), after the `trial_plan_code: '',` line add:
```js
  price_cents:         0,     // 0 ⇒ free trial (today's behaviour); >0 ⇒ paid intro
  currency:            'EUR',
```

- [ ] **Step 2: Factory test** — append to `src/lib/landing-page-blocks.test.js`:
```js
describe('class_funnel paid-intro defaults', () => {
  it('newBlockOfType seeds a free (0) price and EUR', () => {
    const b = newBlockOfType('class_funnel')
    expect(b.price_cents).toBe(0)
    expect(b.currency).toBe('EUR')
  })
})
```

- [ ] **Step 3: Helper tests** — append to `src/lib/public-landing.test.js`:
```js
describe('classFunnelConfigFromBlocks — price', () => {
  const withBlock = (extra) => [{ id: 'b1', type: 'class_funnel', ...extra }]
  it('returns priceCents + currency from the block', () => {
    const r = classFunnelConfigFromBlocks(withBlock({ price_cents: 2900, currency: 'EUR' }), 'stillorgan')
    expect(r.priceCents).toBe(2900)
    expect(r.currency).toBe('EUR')
  })
  it('defaults to 0 / EUR when unset or non-numeric', () => {
    expect(classFunnelConfigFromBlocks(withBlock({}), 'stillorgan').priceCents).toBe(0)
    expect(classFunnelConfigFromBlocks(withBlock({ price_cents: 'x' }), 'stillorgan').priceCents).toBe(0)
    expect(classFunnelConfigFromBlocks(withBlock({}), 'stillorgan').currency).toBe('EUR')
  })
  it('clamps a negative price to 0', () => {
    expect(classFunnelConfigFromBlocks(withBlock({ price_cents: -5 }), 'stillorgan').priceCents).toBe(0)
  })
})
```

- [ ] **Step 4: Run — verify fail** (both files) — `priceCents` undefined.

- [ ] **Step 5: Implement helper** — in `src/lib/public-landing.js`, in `classFunnelConfigFromBlocks`, before the `return {`, add:
```js
  const rawPrice = Number(cf?.price_cents)
  const priceCents = Number.isFinite(rawPrice) && rawPrice > 0 ? Math.floor(rawPrice) : 0
  const currency = (typeof cf?.currency === 'string' && cf.currency.trim()) ? cf.currency.trim().toUpperCase() : 'EUR'
```
and add `priceCents, currency,` to the returned object.

- [ ] **Step 6: Update the existing strict `toEqual` helper tests** — the prior `classFunnelConfigFromBlocks` tests assert the full object shape with `.toEqual`. Add `priceCents: 0, currency: 'EUR'` to each of those expected objects (the no-price cases → 0/EUR). Run the file and fix any that fail purely on the added keys (same as the #1052 pattern).

- [ ] **Step 7: Run — verify pass** (both test files).

- [ ] **Step 8: Commit**
```bash
cd ~/code/un1t-crm-pay
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js src/lib/public-landing.js src/lib/public-landing.test.js
git commit -m "PAID-INTRO.3 — class_funnel block carries price_cents/currency; helper returns them"
```

---

## Task 4: `class-booking-payments.js` — payment lifecycle (TDD)

Mirrors `race-payments.js` but keyed on a `class_booking_requests` row. Three exports.

**Files:** Create `src/lib/class-booking-payments.js`, `src/lib/class-booking-payments.test.js`.

- [ ] **Step 1: Write failing tests** — `src/lib/class-booking-payments.test.js`. Mock the dispatcher so no network; use a chainable db stub. Test the two pure-ish behaviours: `createClassBookingPayment` calls the resolved provider with the server amount and persists refs; `markClassBookingPaymentStatus` maps provider state → row updates (paid → status 'queued' + payment_status 'paid'; failed/expired → payment_status set, no 'queued').
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createPayment = vi.fn(async () => ({ providerRef: 'ord_1', checkoutToken: 'tok', checkoutUrl: 'https://pay/x', state: 'pending', amountCents: 2900 }))
vi.mock('./payments', () => ({ paymentsFor: () => ({ createPayment }) }))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))

import { createClassBookingPayment, markClassBookingPaymentStatus } from './class-booking-payments'

function makeDb(updates) {
  return {
    from() { return this },
    update(u) { updates.push(u); return this },
    eq() { return this },
    select() { return this },
    maybeSingle: async () => ({ data: { id: 'req1' } }),
  }
}

const location = { id: 'loc1', settings: { payments: { provider: 'revolut' } } }
const request = { id: 'req1', location_id: 'loc1', customer_email: 'a@b.com', customer_name: 'A B', class_name: 'HIIT' }

beforeEach(() => { createPayment.mockClear() })

describe('createClassBookingPayment', () => {
  it('charges the server amount and persists provider refs on the row', async () => {
    const updates = []
    const res = await createClassBookingPayment({ db: makeDb(updates), request, location, amountCents: 2900, currency: 'EUR' })
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2900, currency: 'EUR', connectedAccountId: null }))
    expect(res.checkout).toEqual(expect.objectContaining({ token: 'tok', provider: 'revolut' }))
    // the row was updated with provider_ref + awaiting-payment payment fields
    expect(updates.some((u) => u.payment_provider_ref === 'ord_1' && u.payment_status === 'pending')).toBe(true)
  })
})

describe('markClassBookingPaymentStatus', () => {
  const row = { id: 'req1', status: 'awaiting_payment', payment_status: 'pending' }
  it('paid → releases the booking to queued', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'completed', providerAmount: 2900 })
    expect(r.released).toBe(true)
    expect(updates.some((u) => u.status === 'queued' && u.payment_status === 'paid')).toBe(true)
  })
  it('failed → marks payment_status failed, does NOT queue', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'failed' })
    expect(r.released).toBe(false)
    expect(updates.some((u) => u.payment_status === 'failed')).toBe(true)
    expect(updates.some((u) => u.status === 'queued')).toBe(false)
  })
  it('transient state → no change', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: row, providerState: 'processing' })
    expect(r.released).toBe(false)
    expect(updates).toHaveLength(0)
  })
  it('already paid → idempotent no-op', async () => {
    const updates = []
    const r = await markClassBookingPaymentStatus({ db: makeDb(updates), request: { ...row, payment_status: 'paid', status: 'queued' }, providerState: 'completed' })
    expect(r.released).toBe(false)
    expect(updates).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — verify fail** (module missing).

- [ ] **Step 3: Implement** — `src/lib/class-booking-payments.js`:
```js
// class-booking-payments — payment lifecycle for a PAID class-funnel intro.
//
// Mirrors race-payments.js (same dispatcher, same webhook-driven state machine)
// but keyed on a class_booking_requests row. DELIBERATELY separate from
// race-payments: different domain, different confirmation side-effects. The only
// shared code is the payments dispatcher (processor-agnostic transport).
//
// Lifecycle: the public booking route inserts the row `awaiting_payment`, then
// createClassBookingPayment() opens a provider order and stamps the refs.
// The signed webhook (or the poll route's re-check) calls
// markClassBookingPaymentStatus(): 'paid' RELEASES the booking (status→'queued')
// so the existing processor grants the block's product + books; 'failed'/
// 'expired' are terminal (no booking, money not taken).
import { paymentsFor } from './payments'
import { resolveLocationPaymentProvider } from './location-payments'
import { getAppUrl } from './app-url'
import { logWarn } from './log'

/**
 * Open a provider payment for an already-inserted `awaiting_payment` row and
 * persist the provider refs on it. amountCents is the SERVER-derived block
 * price — never a client value. Returns the checkout handle for the caller.
 */
export async function createClassBookingPayment({ db, request, location, amountCents, currency }) {
  const { provider, connectedAccountId } = resolveLocationPaymentProvider(location)
  const created = await paymentsFor(provider).createPayment({
    amountCents,
    currency: currency || 'EUR',
    description: `UN1T intro — ${request.class_name || 'class'}`,
    returnUrl: `${getAppUrl()}/class-pay/${request.id}`, // Phase-2 page; provider redirect target only (unused in Phase 1's headless test path — webhook/poll drive state)
    metadata: { class_booking_request_id: request.id, domain: 'un1t_class_booking' },
    idempotencyKey: request.id, // re-issuing for the same booking is safe
    connectedAccountId,
    applicationFeeCents: 0,
  })
  await db.from('class_booking_requests')
    .update({
      payment_status: 'pending',
      payment_provider: provider,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      amount_cents: amountCents,
      currency: currency || 'EUR',
    })
    .eq('id', request.id)
  return {
    paymentId: request.id,
    checkout: {
      provider,
      token: created.checkoutToken || null,
      url: created.checkoutUrl || null,
      connectedAccountId,
    },
  }
}

/** Webhook lookup: the row that owns this provider order. */
export async function resolveClassBookingPaymentByRef(db, providerRef) {
  if (!providerRef) return null
  const { data } = await db.from('class_booking_requests')
    .select('*').eq('payment_provider_ref', providerRef).maybeSingle()
  return data || null
}

/**
 * Apply a provider state change. `providerState` is the adapter's lowercased
 * state ('completed'|'failed'|'cancelled'|'expired'|transient…).
 * Returns { released } — true when this call moved the booking to 'queued'.
 */
export async function markClassBookingPaymentStatus({ db, request, providerState, providerAmount }) {
  // Terminal / already-released → idempotent no-op.
  if (request?.payment_status === 'paid') return { released: false }
  if (request?.payment_status === 'failed' || request?.payment_status === 'expired') return { released: false }

  const state = String(providerState || '').toLowerCase()
  if (state === 'completed') {
    const updates = { payment_status: 'paid' }
    if (Number.isFinite(providerAmount) && providerAmount !== request.amount_cents) updates.amount_cents = providerAmount
    // Release only if still holding — never resurrect a non-awaiting row.
    if (request.status === 'awaiting_payment') updates.status = 'queued'
    await db.from('class_booking_requests').update(updates).eq('id', request.id)
    return { released: updates.status === 'queued' }
  }
  if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    const payment_status = state === 'cancelled' ? 'expired' : state
    await db.from('class_booking_requests')
      .update({ payment_status, status: 'payment_failed' })
      .eq('id', request.id)
    return { released: false }
  }
  // Transient (pending/processing/authorised) — leave the row alone.
  return { released: false }
}
```
Note: `logWarn` is imported for parity with sibling modules and future use; if the linter flags it as unused, remove the import.

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-pay
git add src/lib/class-booking-payments.js src/lib/class-booking-payments.test.js
git commit -m "PAID-INTRO.4 — class-booking payment lifecycle (create / mark / resolve)"
```

---

## Task 5: Route paid branch

When the block has a price and the location can charge, hold the booking `awaiting_payment` and open a payment instead of queuing immediately.

**Files:** Modify `src/app/api/public/class-booking/route.js`.

- [ ] **Step 1: Imports** — add near the other imports:
```js
import { createClassBookingPayment } from '@/lib/class-booking-payments'
import { locationCanTakePayments } from '@/lib/location-payments'
```

- [ ] **Step 2: Destructure price from the helper** — the route already does
`const { tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode } = classFunnelConfigFromBlocks(page.blocks, landingPath)`.
Add `priceCents, currency`:
```js
  const { tag, leadSource, eventSourceUrl, trialMembershipId, trialPlanCode, priceCents, currency } = classFunnelConfigFromBlocks(page.blocks, landingPath)
```

- [ ] **Step 3: Load the location settings for the rail** — right after `const locationId = page.location_id`, add a lightweight fetch used only on the paid branch:
```js
  // Paid intro? Resolve the location's payment rail. `paid` gates the branch below.
  let locationForPay = null
  const wantsPayment = Number.isFinite(priceCents) && priceCents > 0
  if (wantsPayment) {
    const { data: loc } = await db.from('locations').select('id, settings').eq('id', locationId).maybeSingle()
    locationForPay = loc || null
  }
```

- [ ] **Step 4: Branch at the insert** — replace the existing insert block (the one that inserts `status: 'queued'` and the QStash nudge that follows) so that a paid booking inserts `awaiting_payment` and opens a payment, while the free path is unchanged. Find:
```js
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    trial_membership_id: trialMembershipId, trial_plan_code: trialPlanCode,
    status: 'queued',
  }).select('id').maybeSingle()
```
Replace the `status: 'queued',` line and capture more columns from the inserted row. Change the insert to compute the initial status, and select the full row the payment step needs:
```js
  const paid = wantsPayment && locationCanTakePayments(locationForPay)
  const { data: queuedRow, error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    trial_membership_id: trialMembershipId, trial_plan_code: trialPlanCode,
    status: paid ? 'awaiting_payment' : 'queued',
  }).select('id, class_name').maybeSingle()
```
(The `23505` dedupe handling immediately below stays unchanged.)

- [ ] **Step 5: Open the payment (paid) OR nudge the queue (free)** — replace the existing QStash-nudge block (`if (queuedRow?.id) { try { await publishQueuePush(... ) } ... }`) with:
```js
  // Paid intro: open a provider payment and return checkout details instead of
  // queuing. The booking stays `awaiting_payment` until the signed webhook (or
  // the poll route's re-check) releases it to `queued`.
  if (paid && queuedRow?.id) {
    try {
      const pay = await createClassBookingPayment({
        db, request: { id: queuedRow.id, location_id: locationId, class_name: queuedRow.class_name },
        location: locationForPay, amountCents: priceCents, currency,
      })
      // CAPI Lead still fires below (a captured lead is a lead regardless of payment).
      return NextResponse.json({ success: true, data: { requiresPayment: true, paymentId: pay.paymentId, checkout: pay.checkout } })
    } catch (e) {
      logWarn('classbook', 'payment open failed', { err: e })
      return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 502 })
    }
  }

  // Free booking: nudge the queue for fast delivery (unchanged behaviour).
  if (queuedRow?.id) {
    try {
      await publishQueuePush({
        path: CLASS_BOOKINGS_WORKER_PATH,
        body: { id: queuedRow.id },
        deduplicationId: `class-booking-${queuedRow.id}`,
      })
    } catch {
      // publishQueuePush swallows its own errors; belt-and-braces only.
    }
  }
```
Leave the CAPI block and the final success response after it unchanged (they run for the free path; the paid path returned early above, before the CAPI block — MOVE the early return to AFTER the CAPI block if the Lead event should fire for paid too). **Decision:** the CAPI Lead SHOULD fire for a paid lead. So do NOT early-return before CAPI — instead set a flag and return after CAPI. Implement it as: on the paid branch, stash `paymentResponse = { requiresPayment: true, ... }`, skip the QStash nudge, let the CAPI block run, then `return NextResponse.json({ success: true, data: paymentResponse })` in place of the route's existing final free response (guard the existing final response with `if (!paymentResponse)`).

- [ ] **Step 6: Lint + targeted manual reasoning** — `cd ~/code/un1t-crm-pay && npm run lint 2>&1 | tail -3`. Re-read the branch to confirm: free path byte-identical to before; paid path returns `requiresPayment` after CAPI; no QStash nudge on the paid path.

- [ ] **Step 7: Commit**
```bash
cd ~/code/un1t-crm-pay
git add src/app/api/public/class-booking/route.js
git commit -m "PAID-INTRO.5 — class-booking route: paid branch holds awaiting_payment + opens checkout"
```

---

## Task 6: Signed Revolut webhook → release the booking

**Files:** Modify `src/lib/webhook-events.js`; Create `src/app/api/webhooks/revolut/class-bookings/route.js`.

- [ ] **Step 1: Add the webhook-provider constant** — in `src/lib/webhook-events.js`, inside `WEBHOOK_PROVIDERS`, add:
```js
  REVOLUT_CLASS_BOOKING: 'revolut_class_booking',
```

- [ ] **Step 2: Create the webhook route** — `src/app/api/webhooks/revolut/class-bookings/route.js` (mirrors the race webhook; verify sig → dedupe → look up row by order id → re-fetch order state → mark → release). This route is exempt from session auth (webhook) — the `check:route-guards` script recognises `verify*()` calls; keep the `verifyWebhookSignature` call so it passes.
```js
// POST /api/webhooks/revolut/class-bookings
// Signed Revolut receiver for PAID class-funnel bookings. Configure as its own
// webhook endpoint (or filter the shared one by metadata.domain). On a paid
// order it releases the held booking to the queue; the processor then grants
// the block's Glofox product + books. Idempotent; 200 on anything unrecognised.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const rawBody = await request.text()
  const sig = request.headers.get('revolut-signature')
  const ts = request.headers.get('revolut-request-timestamp')
  const secrets = [
    process.env.REVOLUT_CLASS_BOOKING_WEBHOOK_SECRET,
    process.env.REVOLUT_WEBHOOK_SECRET,
  ].filter(Boolean)
  if (!verifyWebhookSignature(rawBody, sig, ts, { secrets })) {
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  let payload = null
  try { payload = JSON.parse(rawBody) } catch { return NextResponse.json({ success: true }) }
  const orderId = payload?.order_id
  const event = payload?.event
  if (!orderId || !event) return NextResponse.json({ success: true })

  const db = createServerClient()
  const dedup = await recordWebhookEvent({ db, provider: WEBHOOK_PROVIDERS.REVOLUT_CLASS_BOOKING, eventId: `${event}:${orderId}` })
  if (dedup?.duplicate) return NextResponse.json({ success: true, deduped: true })

  const request_ = await resolveClassBookingPaymentByRef(db, orderId)
  if (!request_) return NextResponse.json({ success: true, skipped: 'no_row' }) // misroute / other domain

  // Trust the provider, not the payload state: re-fetch the order.
  let state = null
  try { const order = await getOrder(orderId); state = String(order?.state || '').toLowerCase() }
  catch (e) { logWarn('classbook-webhook', 'getOrder failed', { err: e }); return NextResponse.json({ success: true, deferred: true }) }

  const { released } = await markClassBookingPaymentStatus({ db, request: request_, providerState: state, providerAmount: undefined })
  if (released) {
    try {
      await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: request_.id }, deduplicationId: `class-booking-${request_.id}` })
    } catch { /* queue table is the delivery guarantee */ }
  }
  return NextResponse.json({ success: true })
}
```
Note: `getOrder` returns Revolut's order object; if its state field differs from `state`, adjust the read to match `src/lib/revolut.js`'s `getOrder` shape (verify before implementing). Stripe-Connect bookings are handled in a later phase (the shared Stripe webhook would branch on `metadata.domain==='un1t_class_booking'`); this phase ships Revolut only.

- [ ] **Step 3: Route-guards + lint** — `cd ~/code/un1t-crm-pay && npm run check:route-guards 2>&1 | tail -3 && npm run lint 2>&1 | tail -3`. Expected: route-guards passes (webhook recognised via `verifyWebhookSignature`); 0 lint errors. If route-guards flags the new route, add it to the webhook allowlist the script uses (check `scripts/check-route-guards.mjs` for how sibling webhooks are recognised).

- [ ] **Step 4: Commit**
```bash
cd ~/code/un1t-crm-pay
git add src/lib/webhook-events.js src/app/api/webhooks/revolut/class-bookings/route.js
git commit -m "PAID-INTRO.6 — signed Revolut webhook releases paid class bookings to the queue"
```

---

## Task 7: Public status-poll route

**Files:** Create `src/app/api/public/class-booking-payments/[id]/route.js`.

- [ ] **Step 1: Create the route** (mirrors `event-payments/[id]`; display-safe fields only; live re-check via the provider when still pending):
```js
// GET /api/public/class-booking-payments/[id]
// Public, read-only status of one paid class booking, for the funnel's payment
// step to poll. Returns only display-safe fields (no contact PII). If still
// pending, re-checks the provider so the UI can advance before the webhook lands.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getOrder } from '@/lib/revolut'
import { markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const { id } = await props.params
  const db = createServerClient()
  const { data, error } = await db.from('class_booking_requests')
    .select('id, status, payment_status, payment_provider, payment_provider_ref, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name')
    .eq('id', id).maybeSingle()
  if (error || !data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let row = data
  if (row.payment_status === 'pending' && row.payment_provider === 'revolut' && row.payment_provider_ref) {
    try {
      const order = await getOrder(row.payment_provider_ref)
      const state = String(order?.state || '').toLowerCase()
      const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: state })
      if (released) {
        try { await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: row.id }, deduplicationId: `class-booking-${row.id}` }) } catch { /* queue is the guarantee */ }
      }
      const { data: fresh } = await db.from('class_booking_requests')
        .select('id, status, payment_status, payment_provider, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name')
        .eq('id', id).maybeSingle()
      if (fresh) row = fresh
    } catch (e) { logWarn('classbook-poll', 're-check failed', { err: e }) }
  }

  // paid_and_booked once the payment cleared AND the booking left awaiting/failed.
  const paid = row.payment_status === 'paid'
  return NextResponse.json({ success: true, data: {
    id: row.id,
    paid,
    booking_status: row.status,
    payment_status: row.payment_status,
    checkout: { provider: row.payment_provider, token: row.payment_checkout_token, url: row.payment_checkout_url },
    amount_cents: row.amount_cents, currency: row.currency, class_name: row.class_name,
  } })
}
```

- [ ] **Step 2: Public path — no proxy change needed** — VERIFIED: `src/proxy.js` allowlists the `/api/public/` prefix (`publicPaths` includes `'/api/public/'`, matched via `startsWith`), so this route is already public. Do NOT edit `proxy.js`.

- [ ] **Step 3: Route-guards + lint** — `npm run check:route-guards 2>&1 | tail -3 && npm run lint 2>&1 | tail -3`. If route-guards flags it as an unguarded route, add it to the script's public `EXEMPT` map (it's an intentionally-public, read-only status route, like `event-payments/[id]`).

- [ ] **Step 4: Commit**
```bash
cd ~/code/un1t-crm-pay
git add "src/app/api/public/class-booking-payments/[id]/route.js"
git commit -m "PAID-INTRO.7 — public poll route for paid class bookings (status + provider re-check)"
```

---

## Task 8: Full verification

**Files:** none.

- [ ] **Step 1: Full test suite** — `cd ~/code/un1t-crm-pay && npm test 2>&1 | tail -12`. Expected: all pass incl. new location-payments, class-booking-payments, price-helper, factory tests.

- [ ] **Step 2: CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`. Expected: all exit 0.

- [ ] **Step 3: Build** — `npm run build 2>&1 | tail -15`. Expected: success; the two new routes appear in the route list.

- [ ] **Step 4: Sandbox smoke (as far as possible without funnel UI)** — with the migration applied: set `price_cents` on the Stillorgan `class_funnel` block (DB/editor), POST `/api/public/class-booking` with a valid class → expect `{ requiresPayment: true, paymentId, checkout }` and a `class_booking_requests` row `status='awaiting_payment'`, `payment_status='pending'`. If Revolut sandbox creds are configured, complete/kill the order and confirm the webhook (or the poll route) flips the row to `queued`/`payment_failed`. A block with `price_cents=0` still books free (unchanged). Document what was and wasn't verifiable without live creds.

- [ ] **Step 5: Push + PR**
```bash
cd ~/code/un1t-crm-pay
git push -u origin class-funnel-payments
gh pr create --base main --fill
```
Report the PR URL. Note in the body: migration `438` applied ahead of merge; this is Phase 1 (backend) of a phased feature — no customer-facing funnel change ships yet (the paid branch only triggers on a block with `price_cents>0`, which no live block has until Phase 2/3). Vercel preview check is the real build gate.

---

## Self-review notes (spec coverage — Phase 1 slice)

- Per-location rail config → Task 2. ✅
- Payment columns + `awaiting_payment` → Task 1. ✅
- `class-booking-payments.js` (create/mark/resolve) → Task 4. ✅
- Route paid branch (server-derived amount; free path unchanged; CAPI still fires) → Tasks 3, 5. ✅
- Signed webhook releases to queue → Task 6. ✅
- Public status poll + provider re-check → Task 7. ✅
- Money confirmed only by provider (webhook/re-fetch), never client → Tasks 4, 6, 7 (re-fetch `getOrder`, server amount). ✅
- Deferred to later phases (NOT in this plan): funnel UI payment step, editor price field, operator payments-settings UI, paid-fulfillment "grant for existing member" + review `paid` flag. Called out in the header. ✅

**Naming/type consistency:** row payment columns `payment_status`/`payment_provider`/`payment_provider_ref`/`payment_checkout_token`/`payment_checkout_url`/`amount_cents`/`currency` identical across migration (T1), module (T4), route (T5), webhook (T6), poll (T7). Row status literals `awaiting_payment` (held) / `queued` (released) / `payment_failed` (terminal) consistent across T4/T5. Module fn names `createClassBookingPayment` / `markClassBookingPaymentStatus` / `resolveClassBookingPaymentByRef` used identically in T4/T6/T7. Provider resolver returns `{ provider, connectedAccountId }` consumed the same way in T4. ✅

**Known follow-ups for Phase 2/3 (do not do here):** the processor's paid path must grant the product + book for existing members too (today existing-no-credit → review); add the `paid` marker to the staff review row; the funnel `payment` step + checkout island + editor price field; the operator `settings.payments` UI + Stripe-Connect webhook branch.
