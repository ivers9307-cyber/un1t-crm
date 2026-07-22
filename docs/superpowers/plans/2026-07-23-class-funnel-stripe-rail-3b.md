# Phase 3b — Stripe Rail (Code Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the paid class funnel able to charge via **Stripe Connect** (per-location direct charge) in addition to Revolut — the code path only. Dormant until a location is configured to Stripe in 3c, so mergeable on its own (like Phase 1 was Revolut-only).

**Architecture:** Reuse the existing Stripe Connect adapter (already used by events). Un-guard `createClassBookingPayment`; generalize the poll re-check to provider-agnostic `getPayment`; add a class-booking domain-branch to the existing Stripe webhook; add a Stripe embedded-checkout mount to `ClassFunnelCheckout`. Store the connected account on the booking row.

**Tech Stack:** Next.js/React, Supabase (MCP migration), Stripe Connect, Vitest.

**Worktree:** `~/code/un1t-crm-p3bc` (branch `class-funnel-pay-p3bc`, off `origin/main` — has Phases 1/2/3a).

**Spec:** `docs/superpowers/specs/2026-07-23-class-funnel-stripe-rail-design.md`

**⚠️ Deploy order:** migration (Task 1) applied to un1t-crm before the code deploys. Additive + nullable.

**Scope of 3b:** rail code path only. Out: the payments settings UI + Stripe onboarding (3c). Until 3c, `locationCanTakePayments` returns false for a Stripe-configured-but-not-onboarded location, and no location has `settings.payments.provider='stripe_connect'` set at all — so this ships dormant.

---

## File Structure
- **Migration:** `class_booking_requests` gains `connected_account_id text` (nullable).
- **Modify:** `src/lib/class-booking-payments.js` (un-guard + persist account), `src/app/api/public/class-booking-payments/[id]/route.js` (generalize re-check), `src/app/api/webhooks/stripe/route.js` (domain-branch), `src/components/landing-page/ClassFunnelCheckout.jsx` (Stripe mount).
- **Tests:** `src/lib/class-booking-payments.test.js` (extend).

---

## Task 1: Migration — `connected_account_id` on `class_booking_requests`

Applied via Supabase MCP against **un1t-crm** (ref `iyvtbjjxdggiadzwwvdj`; confirm via `list_projects`, NOT the sentinel project).

- [ ] **Step 1: Confirm project** — MCP `list_projects`; confirm `iyvtbjjxdggiadzwwvdj` is un1t-crm.
- [ ] **Step 2: Apply** — MCP `apply_migration`, name `add_connected_account_to_class_booking_requests`, SQL:
```sql
alter table public.class_booking_requests
  add column if not exists connected_account_id text;
comment on column public.class_booking_requests.connected_account_id is
  'Stripe connected account (acct_...) for a stripe_connect direct charge; NULL for Revolut. Needed for the poll re-check / refunds.';
```
- [ ] **Step 3: Advisors** — MCP `get_advisors` (type=security). Expected: no NEW finding.
- [ ] **Step 4: Verify** — MCP `execute_sql`:
```sql
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='class_booking_requests' and column_name='connected_account_id';
```
Expected: one row, `text`, `YES`.
- [ ] **Step 5: Mirror file + commit** — highest migration number is 439; use `440`. Create `supabase/migrations/440_add_connected_account_to_class_booking_requests.sql` with the Step-2 SQL, then:
```bash
cd ~/code/un1t-crm-p3bc
git add supabase/migrations/440_add_connected_account_to_class_booking_requests.sql
git commit -m "PAID-INTRO-P3B.1 — mig: connected_account_id on class_booking_requests"
```

---

## Task 2: `createClassBookingPayment` — un-guard + persist the connected account (TDD)

**Files:** Modify `src/lib/class-booking-payments.js`; extend `src/lib/class-booking-payments.test.js`.

- [ ] **Step 1: Update the existing test** — in `src/lib/class-booking-payments.test.js`, the current test `refuses a non-revolut provider (no release path yet)` asserts a throw. REPLACE it with a test that Stripe now WORKS and persists the connected account. Add a stripe location + a stripe-provider mock. Since the test mocks `./payments` with a single `createPayment`, extend it to also cover stripe by asserting the persisted update carries `payment_provider: 'stripe_connect'` and `connected_account_id: 'acct_1'`:
```js
  it('charges stripe with the connected account and persists it on the row', async () => {
    const updates = []
    const stripeLoc = { id: 'loc1', settings: { payments: { provider: 'stripe_connect', stripe_connected_account_id: 'acct_1' } } }
    const res = await createClassBookingPayment({ db: makeDb(updates), request, location: stripeLoc, amountCents: 2900, currency: 'EUR' })
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2900, connectedAccountId: 'acct_1' }))
    expect(res.checkout).toEqual(expect.objectContaining({ provider: 'stripe_connect', connectedAccountId: 'acct_1' }))
    expect(updates.some((u) => u.payment_provider === 'stripe_connect' && u.connected_account_id === 'acct_1')).toBe(true)
  })
```
Keep the existing `throws if persisting the provider ref fails` test. DELETE the `refuses a non-revolut provider` test (it asserts the behaviour we're removing).

- [ ] **Step 2: Run — verify the new test fails / old removed** — `cd ~/code/un1t-crm-p3bc && npx vitest run src/lib/class-booking-payments.test.js` → the stripe test fails (guard still throws).

- [ ] **Step 3: Implement** — in `src/lib/class-booking-payments.js` `createClassBookingPayment`:
  - DELETE the guard block:
```js
  if (provider !== 'revolut') {
    throw new Error(`Payment provider '${provider}' has no class-booking release path yet`)
  }
```
  (and its preceding comment about the Phase-1 landmine).
  - In the persist `.update({...})`, add `connected_account_id: connectedAccountId` alongside the other fields:
```js
      payment_checkout_url: created.checkoutUrl || null,
      amount_cents: amountCents,
      currency: currency || 'EUR',
      connected_account_id: connectedAccountId || null,
```

- [ ] **Step 4: Run — verify pass** (all tests in the file, incl. the existing revolut + persist-fail ones).

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-p3bc
git add src/lib/class-booking-payments.js src/lib/class-booking-payments.test.js
git commit -m "PAID-INTRO-P3B.2 — createClassBookingPayment supports Stripe + persists connected account"
```

---

## Task 3: Generalize the poll re-check to provider-agnostic `getPayment`

**Files:** Modify `src/app/api/public/class-booking-payments/[id]/route.js`.

- [ ] **Step 1: Swap the import** — replace `import { getOrder } from '@/lib/revolut'` with `import { paymentsFor } from '@/lib/payments'`.

- [ ] **Step 2: Add `connected_account_id` + provider to both row selects** — the initial select and the re-fetch select. Add `connected_account_id` to the column list of BOTH (the initial select already has `payment_provider`, `payment_provider_ref`).

- [ ] **Step 3: Generalize the re-check block** — replace:
```js
  const recheckAllowed = (row.payment_status === 'pending' && row.payment_provider === 'revolut' && row.payment_provider_ref)
    ? (await checkRateLimit(db, `cbpoll:${id}`, { max: 20, windowMs: 5 * 60_000 })).allowed
    : false
  if (recheckAllowed) {
    try {
      const order = await getOrder(row.payment_provider_ref)
      const state = String(order?.state || '').toLowerCase()
      const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: state, providerAmount: Number.isFinite(order?.amount) ? order.amount : null })
      if (released) {
        try { await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: row.id }, deduplicationId: `class-booking-${row.id}` }) } catch { /* queue is the guarantee */ }
      }
      const { data: fresh } = await db.from('class_booking_requests')
        .select('id, status, payment_status, payment_provider, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name')
        .eq('id', id).maybeSingle()
      if (fresh) row = fresh
    } catch (e) { logWarn('classbook-poll', 're-check failed', { err: e }) }
  }
```
with:
```js
  const canRecheck = row.payment_status === 'pending'
    && (row.payment_provider === 'revolut' || row.payment_provider === 'stripe_connect')
    && row.payment_provider_ref
  const recheckAllowed = canRecheck
    ? (await checkRateLimit(db, `cbpoll:${id}`, { max: 20, windowMs: 5 * 60_000 })).allowed
    : false
  if (recheckAllowed) {
    try {
      const norm = await paymentsFor(row.payment_provider).getPayment(row.payment_provider_ref, { connectedAccountId: row.connected_account_id || null })
      if (norm) {
        const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: norm.state, providerAmount: Number.isFinite(norm.amountCents) ? norm.amountCents : null })
        if (released) {
          try { await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: row.id }, deduplicationId: `class-booking-${row.id}` }) } catch { /* queue is the guarantee */ }
        }
        const { data: fresh } = await db.from('class_booking_requests')
          .select('id, status, payment_status, payment_provider, payment_checkout_token, payment_checkout_url, amount_cents, currency, class_name, connected_account_id')
          .eq('id', id).maybeSingle()
        if (fresh) row = fresh
      }
    } catch (e) { logWarn('classbook-poll', 're-check failed', { err: e }) }
  }
```

- [ ] **Step 4: Build + lint** — `cd ~/code/un1t-crm-p3bc && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors. (`getOrder` import removed — confirm no other use in the file.)

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-p3bc
git add "src/app/api/public/class-booking-payments/[id]/route.js"
git commit -m "PAID-INTRO-P3B.3 — poll re-check is provider-agnostic (getPayment for revolut + stripe)"
```

---

## Task 4: Stripe webhook — class-booking domain-branch

**Files:** Modify `src/app/api/webhooks/stripe/route.js`.

- [ ] **Step 1: Add imports** — with the existing imports, add:
```js
import { resolveClassBookingPaymentByRef, markClassBookingPaymentStatus } from '@/lib/class-booking-payments'
import { publishQueuePush, CLASS_BOOKINGS_WORKER_PATH } from '@/lib/qstash'
```

- [ ] **Step 2: Branch in `checkout.session.completed`** — the handler starts:
```js
    } else if (event.type === 'checkout.session.completed') {
      // A third-party host's ticket payment succeeded. ...
      const session = event.data.object
      const db = createServerClient()
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
```
Insert the class-booking branch immediately after `const session = event.data.object` / `const db = createServerClient()` and BEFORE the race lookup:
```js
      const session = event.data.object
      const db = createServerClient()
      if (session.metadata?.domain === 'un1t_class_booking') {
        const row = await resolveClassBookingPaymentByRef(db, session.id)
        if (row) {
          const { released } = await markClassBookingPaymentStatus({ db, request: row, providerState: 'completed', providerAmount: Number.isFinite(session.amount_total) ? session.amount_total : null })
          if (released) {
            try { await publishQueuePush({ path: CLASS_BOOKINGS_WORKER_PATH, body: { id: row.id }, deduplicationId: `class-booking-${row.id}` }) } catch { /* queue is the guarantee */ }
          }
        }
        return NextResponse.json({ received: true })
      }
      const payment = await resolveRacePaymentByProviderRef(db, session.id)
```
(Use the SAME success-response shape the route already returns at its end — verify what the handler returns on success and match it; if it falls through to a shared `return NextResponse.json({ received: true })`, replicate exactly.)

- [ ] **Step 3: Branch in `checkout.session.expired`** — similarly, after `const session = event.data.object` / `const db = createServerClient()` and before the race lookup:
```js
      if (session.metadata?.domain === 'un1t_class_booking') {
        const row = await resolveClassBookingPaymentByRef(db, session.id)
        if (row) await markClassBookingPaymentStatus({ db, request: row, providerState: 'cancelled', providerAmount: null })
        return NextResponse.json({ received: true })
      }
```
(Match the route's actual success-response shape.)

- [ ] **Step 4: Verify the success-response shape** — READ the end of each handler / the route's final `return` to confirm the exact JSON shape (`{ received: true }` vs `{ success: true }`); make the two new `return`s match it. The webhook MUST 200 on these.

- [ ] **Step 5: route-guards + build + lint**
```bash
cd ~/code/un1t-crm-p3bc
npm run check:route-guards 2>&1 | tail -3
npm run build 2>&1 | tail -6
npm run lint 2>&1 | tail -3
```
Expected: route-guards passes (webhook already signature-guarded); build succeeds; 0 lint errors.

- [ ] **Step 6: Commit**
```bash
cd ~/code/un1t-crm-p3bc
git add src/app/api/webhooks/stripe/route.js
git commit -m "PAID-INTRO-P3B.4 — Stripe webhook releases paid class bookings (metadata.domain branch)"
```

---

## Task 5: `ClassFunnelCheckout` — Stripe embedded-checkout mount

**Files:** Modify `src/components/landing-page/ClassFunnelCheckout.jsx`.

- [ ] **Step 1: Import Stripe.js loader** — at the top:
```js
import { loadStripe } from '@stripe/stripe-js'
```
And add a module-scoped cache + getter (mirror `RaceCheckoutPage`):
```js
const stripePromises = new Map()
function getStripe(pubKey, connectedAccountId) {
  const key = `${pubKey}::${connectedAccountId || ''}`
  if (!stripePromises.has(key)) {
    stripePromises.set(key, loadStripe(pubKey, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined))
  }
  return stripePromises.get(key)
}
const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''
```

- [ ] **Step 2: Replace the mount effect's provider gate** — the effect currently starts:
```js
  useEffect(() => {
    if (checkout?.provider !== 'revolut') { setError('This payment method is not available yet.'); return }
    if (!revolutPublicKey()) { setError('Payment is not configured.'); return }
    if (!checkout?.token) { setError('Payment session is missing. Please refresh and try again.'); return }
    if (!targetRef.current || instanceRef.current) return
    let destroyed = false
    loadRevolutSdk(revolutMode())
      .then((RC) => { ... })
      ...
```
Restructure so it handles BOTH providers. Replace the opening guards + Revolut mount with:
```js
  useEffect(() => {
    if (!checkout?.token) { setError('Payment session is missing. Please refresh and try again.'); return }
    if (!targetRef.current || instanceRef.current) return
    let destroyed = false

    // ── Stripe Connect: mount Stripe Embedded Checkout inline ──
    if (checkout.provider === 'stripe_connect') {
      if (!STRIPE_PUBLISHABLE_KEY) { setError('Payment is not configured.'); return }
      getStripe(STRIPE_PUBLISHABLE_KEY, checkout.connectedAccountId)
        .then(async (stripe) => {
          if (destroyed) return
          if (!stripe) throw new Error('Could not load the payment widget.')
          const embedded = await stripe.createEmbeddedCheckoutPage({
            clientSecret: checkout.token,
            onComplete: () => { if (!destroyed) markPaid() },
          })
          if (destroyed) { try { embedded.destroy() } catch {} ; return }
          embedded.mount(targetRef.current)
          instanceRef.current = embedded
        })
        .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
      return () => { destroyed = true; try { instanceRef.current?.destroy?.() } catch {} ; instanceRef.current = null }
    }

    // ── Revolut: mount the Revolut embed ──
    if (checkout.provider !== 'revolut') { setError('This payment method is not available yet.'); return }
    if (!revolutPublicKey()) { setError('Payment is not configured.'); return }
    loadRevolutSdk(revolutMode())
      .then((RC) => {
        if (destroyed) return
        instanceRef.current = RC.embeddedCheckout({
          publicToken: revolutPublicKey(),
          mode: revolutMode(),
          locale: 'auto',
          target: targetRef.current,
          createOrder: async () => ({ publicId: checkout.token }),
          onSuccess: () => { if (!destroyed) markPaid() },
          onError: ({ error }) => { if (!destroyed) setError(error?.message || 'Payment failed. Please try again.') },
          onCancel: () => { if (!destroyed) onCancel?.() },
        })
      })
      .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
    return () => {
      destroyed = true
      try { instanceRef.current?.destroy?.() } catch {}
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout])
```
(The status-poll fallback effect below is unchanged and covers both providers.)

- [ ] **Step 3: Build + lint** — `cd ~/code/un1t-crm-p3bc && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors (the single `eslint-disable` on the effect stays).

- [ ] **Step 4: Commit**
```bash
cd ~/code/un1t-crm-p3bc
git add src/components/landing-page/ClassFunnelCheckout.jsx
git commit -m "PAID-INTRO-P3B.5 — ClassFunnelCheckout mounts Stripe Embedded Checkout too"
```

---

## Task 6: Full verification + PR

- [ ] **Step 1: Full suite** — `cd ~/code/un1t-crm-p3bc && npm test 2>&1 | tail -6`. Expected: all pass.
- [ ] **Step 2: CI mirror + scoping** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && node scripts/check-location-scoping.mjs`. Expected: all exit 0.
- [ ] **Step 3: Build** — `npm run build 2>&1 | tail -12`. Expected: success.
- [ ] **Step 4: Push + PR**
```bash
cd ~/code/un1t-crm-p3bc
git push -u origin class-funnel-pay-p3bc
gh pr create --base main --fill
```
Report the PR URL. Body: Phase 3b — Stripe rail code path; migration 440 applied ahead of merge; DORMANT (no location is set to Stripe until 3c's settings UI ships, and `locationCanTakePayments` still gates charging on an onboarded account); race webhook path untouched (additive domain-branch). Vercel preview is the real gate for the Stripe embed.

---

## Self-review notes (spec coverage — 3b)
- Migration `connected_account_id` → Task 1. ✅
- Un-guard + persist account → Task 2. ✅
- Provider-agnostic poll re-check → Task 3. ✅
- Stripe webhook domain-branch (completed + expired) → Task 4. ✅
- Stripe embedded mount in the funnel → Task 5. ✅
- Deferred to 3c: settings UI + onboarding (called out). ✅

**Naming/type consistency:** row column `connected_account_id` written in Task 2, read in Tasks 3 (poll) + surfaced from the Phase-1 `checkout.connectedAccountId` used in Task 5. `paymentsFor(provider).getPayment(ref, { connectedAccountId })` → `{ state, amountCents }` used in Task 3 matches the adapter contract. Stripe session `metadata.domain === 'un1t_class_booking'` (set by Phase-1 `createClassBookingPayment`) matched in Task 4. `checkout.provider`/`checkout.token`/`checkout.connectedAccountId` (Phase-1 payload) consumed in Task 5. ✅

**Money-safety note:** the Stripe webhook branch and the poll re-check both go through the same idempotent `markClassBookingPaymentStatus` state machine (release only from `awaiting_payment`, no-op when already paid/failed), so a Stripe completion can't double-book. The race path is strictly untouched (branch returns before it).
