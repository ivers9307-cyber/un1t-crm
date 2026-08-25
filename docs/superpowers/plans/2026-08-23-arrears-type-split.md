# Arrears tabs split by charge type — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the churn radar's Overdue / Unpaid charges tabs by charge type (membership payment vs everything else) instead of the €50 amount line, and stop treating Glofox's "awaiting authorization" charges as failed debts.

**Architecture:** A pure classifier `isMembershipInvoice(row)` in `glofox-arrears.js` reads the webhook's `line_item_subtypes` (or the backfill's `raw_payload.candidate.glofoxEvent`). `fetchPastDue` aggregates `PAST_DUE` rows per contact into two extra maps (`membershipById`, `chargesById`) alongside the unchanged `byId`; `bucketArrears` maps those straight onto the tabs. `isPendingTxn` learns the report's `PENDING_INTENT` / `"pending authorization"` values so the existing reconcile proposes the `PAST_DUE → PENDING` correction, and the master `reconcile-fees` route gains `restatus=true` so the operator can apply it from the browser.

**Tech Stack:** Next.js 16 app routes, Supabase (PostgREST select with a JSON-path alias — syntax verified live 2026-08-23), vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-arrears-type-split-design.md`

**Machine note:** 8 GB dev Mac. Run tasks sequentially, one `vitest` invocation at a time; never run `npm test` while another agent or test run is active.

---

## File map

| File | Change |
|---|---|
| `src/lib/glofox-arrears.js` | + `MEMBERSHIP_LINE_SUBTYPES`, `MEMBERSHIP_REPORT_EVENTS`, `isMembershipInvoice`; `isPendingTxn` recognises `PENDING_INTENT` / `'pending authorization'` |
| `src/lib/glofox-arrears.test.js` | + `isMembershipInvoice` suite; + `computeArrears` PENDING_INTENT case (`mkStripe` gains `transaction_status`) |
| `src/lib/glofox-reconcile.test.js` | + PENDING_INTENT cases for `indexReportByInvoice`, `reconcileOpenPastDue`, `runArrearsReconcile` |
| `src/lib/churn-radar.js` | `bucketArrears({ membershipById, chargesById, pendingById })`; delete `OVERDUE_MIN_CENTS`, `splitArrears` |
| `src/lib/churn-radar.test.js` | rewrite `bucketArrears` suite; delete `splitArrears` suite + imports |
| `src/lib/churn-radar-data.js` | `fetchPastDue` selects the type signals and returns `membershipById`/`chargesById`; both `bucketArrears` call sites; comments |
| `src/lib/churn-radar-data.test.js` | existing Overdue tests get `line_item_subtypes: 'SUBSCRIPTION_RENEWAL'`; + type-split suite |
| `src/app/api/glofox/reconcile-fees/route.js` | `restatus=true` → `allowRestatus` |
| `src/components/ChurnRadar.jsx` | banner + empty-state copy for the three tabs; header comment |
| `src/app/api/churn-radar/unpaid-charges/route.js`, `overdue/route.js` | header comments |
| `docs/CHANGELOG.md` | entry 570 |

---

### Task 1: `isMembershipInvoice` — the type classifier

**Files:**
- Modify: `src/lib/glofox-arrears.js` (after `isCustomChargeFee`, ~line 413)
- Test: `src/lib/glofox-arrears.test.js`

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `src/lib/glofox-arrears.test.js`:

```js
import { computeArrears, isMembershipInvoice, MEMBERSHIP_LINE_SUBTYPES, MEMBERSHIP_REPORT_EVENTS } from './glofox-arrears'
```

Append at the end of the file:

```js
// ── ARREARS-TYPE.1 — membership payment vs every other charge ──────────────
// Richard's rule (2026-08-23): the Overdue tab is for FAILED MEMBERSHIP
// PAYMENTS only; every other failing transaction is an "unpaid charge",
// whatever its amount. Verified live how Glofox labels each kind:
//   MEMBERSHIPS/SUBSCRIPTION_RENEWAL      recurring renewal           → membership
//   MEMBERSHIPS/SUBSCRIPTION_PAYMENT      first payment at signup     → membership
//     (paired with a €0 MEMBERSHIPS/UPFRONT_PAYMENT line on the same invoice)
//   MEMBERSHIPS/UPFRONT_PAYMENT alone     class packs, credits, trial → NOT
//   CUSTOM_CHARGES/CUSTOM_CHARGE          fees, staff custom charges  → NOT
//   CLASSES/BOOK_CLASS, PRODUCTS/BUY_PRODUCT, WALLET_TOP_UP            → NOT
// Backfilled rows (June 2026) have no line items; they carry the report's
// metadata.glofox_event instead (subscription_payment[_failed] = membership).
describe('isMembershipInvoice (ARREARS-TYPE.1)', () => {
  it('a subscription renewal / first payment / prorate / NSF line is a membership payment', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'PRORATE' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'NON_SUFFICIENT_FUNDS' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: 'subscription_renewal' })).toBe(true) // case-insensitive
    expect(MEMBERSHIP_LINE_SUBTYPES).toEqual(['SUBSCRIPTION_RENEWAL', 'SUBSCRIPTION_PAYMENT', 'PRORATE', 'NON_SUFFICIENT_FUNDS'])
  })

  it('a lone UPFRONT_PAYMENT (class pack / credits / trial), a fee, a booking, a product or a top-up is NOT', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'UPFRONT_PAYMENT' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'CUSTOM_CHARGE' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'BOOK_CLASS' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'BUY_PRODUCT' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: 'WALLET_TOP_UP' })).toBe(false)
  })

  it('matches whole tokens only — a sub_type that merely CONTAINS a membership token does not count', () => {
    expect(isMembershipInvoice({ line_item_subtypes: 'NOT_A_SUBSCRIPTION_RENEWAL_X' })).toBe(false)
  })

  it('falls back to the report event for backfilled rows (no line items)', () => {
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'subscription_payment_failed' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'subscription_payment' })).toBe(true)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'custom_charge' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'book_class' })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'buy_product' })).toBe(false)
    // A signup invoice and a free trial both arrive as invoice_payment; the
    // backfill kept nothing that tells them apart, so neither is a membership.
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: 'invoice_payment' })).toBe(false)
    expect(MEMBERSHIP_REPORT_EVENTS).toEqual(['subscription_payment', 'subscription_payment_failed'])
  })

  it('no signal at all → not a membership payment', () => {
    expect(isMembershipInvoice({})).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: null, glofox_event: null })).toBe(false)
    expect(isMembershipInvoice({ line_item_subtypes: '', glofox_event: '' })).toBe(false)
    expect(isMembershipInvoice(null)).toBe(false)
    expect(isMembershipInvoice(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/glofox-arrears.test.js`
Expected: FAIL — `isMembershipInvoice is not a function` (import resolves to undefined).

- [ ] **Step 3: Implement**

In `src/lib/glofox-arrears.js`, directly after the `isCustomChargeFee` function:

```js
// ── ARREARS-TYPE.1 — membership payment vs every other charge ──────────────
// Richard's rule (2026-08-23): the radar's Overdue tab is for FAILED MEMBERSHIP
// PAYMENTS only — a subscription's recurring renewal, its first payment at
// signup, a plan-change prorate or a bounced direct-debit (NSF) charge. Every
// other failing transaction (late-cancel / no-show fees, staff custom charges,
// class bookings, class packs, products) is an "unpaid charge", whatever its
// amount. This replaces the €50 line that used to stand in for that question.
//
// Two signals, either of which qualifies the row:
//   1. line_item_subtypes — the INVOICE_UPDATED webhook's line_items[].sub_type
//      roll-up (glofox-invoices.js). A signup invoice pairs a €0 UPFRONT_PAYMENT
//      line with SUBSCRIPTION_PAYMENT — the latter is what qualifies it. A LONE
//      UPFRONT_PAYMENT is a one-off purchase (class pack, credits, a trial) and
//      is never a membership payment, even though Glofox files it under its
//      MEMBERSHIPS line-item type.
//   2. glofox_event — the TransactionsList report's metadata.glofox_event, which
//      the June backfill kept at raw_payload.candidate.glofoxEvent (those rows
//      have no line items). Only the subscription events count; invoice_payment
//      covers signups AND trials and can't be told apart from what was kept.
// A row with neither signal is not a membership payment — every webhook row
// carries line items, so that is only ever a backfilled row of an unrecognised
// event (none exist as of 2026-08-23).
export const MEMBERSHIP_LINE_SUBTYPES = Object.freeze([
  'SUBSCRIPTION_RENEWAL',
  'SUBSCRIPTION_PAYMENT',
  'PRORATE',
  'NON_SUFFICIENT_FUNDS',
])
export const MEMBERSHIP_REPORT_EVENTS = Object.freeze([
  'subscription_payment',
  'subscription_payment_failed',
])

/**
 * Is this glofox_invoices row a membership payment (vs any other charge)?
 * @param {{ line_item_subtypes?: string|null, glofox_event?: string|null }} row
 */
export function isMembershipInvoice(row) {
  const subtypes = String(row?.line_item_subtypes || '')
    .toUpperCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (subtypes.some((s) => MEMBERSHIP_LINE_SUBTYPES.includes(s))) return true
  const ev = String(row?.glofox_event || '').trim().toLowerCase()
  return MEMBERSHIP_REPORT_EVENTS.includes(ev)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/glofox-arrears.test.js`
Expected: PASS (all suites in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-arrears.js src/lib/glofox-arrears.test.js
git commit -m "ARREARS-TYPE.1 — isMembershipInvoice: membership payment vs every other charge"
```

---

### Task 2: `isPendingTxn` recognises Glofox's awaiting-authorization values

**Files:**
- Modify: `src/lib/glofox-arrears.js:60-72` (`isPendingTxn`)
- Test: `src/lib/glofox-arrears.test.js`, `src/lib/glofox-reconcile.test.js`

- [ ] **Step 1: Write the failing tests**

In `src/lib/glofox-arrears.test.js`, extend the `mkStripe` helper so a test can set the report's `transaction_status` (add the parameter and the one line that applies it):

```js
function mkStripe({
  invoice_id,
  paid,
  status,
  transaction_status,
  amount = 0,
  failed_amount,
  event = 'subscription_payment_failed',
  user_id = 'u',
  user_name = 'Member',
  created = '2026-06-01 00:00:00',
  is_forgiven,
  already_paid,
  payment_method = 'credit_card',
}) {
  const metadata = { glofox_event: event, user_id, user_name, payment_method }
  if (is_forgiven !== undefined) metadata.is_forgiven = is_forgiven
  if (already_paid !== undefined) metadata.already_paid = already_paid
  const inner = { invoice_id, paid, status, amount, currency: 'eur', created, metadata, description: event }
  if (failed_amount !== undefined) inner.failed_amount = failed_amount
  if (transaction_status !== undefined) inner.transaction_status = transaction_status
  return { StripeCharge: inner }
}
```

Then add, inside the existing `describe('computeArrears', …)` block right after the `'AWAITING-AUTH.2 — an in-progress (PENDING) charge …'` test:

```js
  it('ARREARS-TYPE.2 — Glofox "Awaiting authorization" is transaction_status PENDING_INTENT / status "pending authorization" → a PENDING candidate', () => {
    // The €467 "Client confirmation required: Custom Charge" case (verified live
    // 2026-08-23 via the report probe): paid:false, amount carried on `amount`,
    // NOT the spec's PENDING. The June backfill wrote it as PAST_DUE and it sat
    // on the Overdue chase-list for two months.
    const rows = [
      mkStripe({ invoice_id: 'AI', paid: false, status: 'pending authorization', transaction_status: 'PENDING_INTENT', amount: 467, event: 'custom_charge' }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.totals.candidates).toBe(1)
    expect(out.candidates[0]).toMatchObject({ invoiceId: 'AI', status: 'PENDING', amountCents: 46700, glofoxEvent: 'custom_charge' })
  })

  it('ARREARS-TYPE.2 — a PENDING_INTENT attempt alongside a failed one is still PAST_DUE (dunning reuses the invoice id)', () => {
    const rows = [
      mkStripe({ invoice_id: 'PI', paid: false, status: 'failed', failed_amount: 209 }),
      mkStripe({ invoice_id: 'PI', paid: false, status: 'pending authorization', transaction_status: 'PENDING_INTENT', amount: 209 }),
    ]
    const out = computeArrears(rows, { existingInvoiceIds: new Set() })
    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0].status).toBe('PAST_DUE')
  })
```

In `src/lib/glofox-reconcile.test.js`, add inside `describe('indexReportByInvoice …')` after the AWAITING-AUTH.2 test:

```js
  it('ARREARS-TYPE.2 — flags PENDING_INTENT / "pending authorization" (what Glofox actually sends for Awaiting authorization) as pending', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'PI', transaction_status: 'PENDING_INTENT', status: 'pending authorization', paid: false }),
      txn({ invoice_id: 'PS', status: 'pending authorization', paid: false }), // status alone
    ])
    expect(idx.get('PI')).toMatchObject({ pending: true, failed: false, settled: false, forgiven: false })
    expect(idx.get('PS')).toMatchObject({ pending: true, failed: false })
  })
```

Inside `describe('reconcileOpenPastDue …')` after the `'re-statuses a PAST_DUE row …'` test:

```js
  it('ARREARS-TYPE.2 — re-statuses a backfilled PAST_DUE row the report shows as PENDING_INTENT (the €467 custom-charge case)', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'cc467', transaction_status: 'PENDING_INTENT', status: 'pending authorization', paid: false, amount: 467 }),
    ])
    const out = reconcileOpenPastDue([{ id: 'cc467', status: 'PAST_DUE', invoice_date: '2026-01-27' }], idx, NOW)
    expect(out[0]).toMatchObject({ id: 'cc467', action: 'restatus', newStatus: 'PENDING', reason: 'awaiting_authorization' })
  })
```

Inside `describe('runArrearsReconcile — orchestration …')` after the `'commits the PAST_DUE→PENDING re-status when allowRestatus is set'` test:

```js
  it('ARREARS-TYPE.2 — the PENDING_INTENT case round-trips: proposed on a dry-run, written with allowRestatus', async () => {
    const rows = [{ id: 'cc467', status: 'PAST_DUE', invoice_date: '2026-01-27', amount_cents: 46700 }]
    const rep = { ok: true, status: 200, body: { TransactionsList: { details: [
      rtxn({ invoice_id: 'cc467', transaction_status: 'PENDING_INTENT', status: 'pending authorization', paid: false, amount: 467 }),
    ] } } }
    const { db: dryDb, updates: dryUpdates } = makeReconcileDb(rows)
    const dry = await runArrearsReconcile(dryDb, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => rep })
    expect(dry.restated).toBe(1)
    expect(dry.byReason).toMatchObject({ awaiting_authorization: 1 })
    expect(dryUpdates).toHaveLength(0)

    const { db, updates } = makeReconcileDb(rows)
    await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => rep, commit: true, allowRestatus: true })
    const written = new Map()
    for (const u of updates) for (const id of u.ids) written.set(id, u.payload)
    expect(written.get('cc467')).toMatchObject({ status: 'PENDING', reconciled_reason: 'awaiting_authorization' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/glofox-arrears.test.js src/lib/glofox-reconcile.test.js`
Expected: FAIL — the new computeArrears case reports `status: 'PAST_DUE'`; `idx.get('PI').pending` is `false`; the reconcile cases report `keep`/`restated: 0`.

- [ ] **Step 3: Implement**

Replace `isPendingTxn` and its comment in `src/lib/glofox-arrears.js`:

```js
// AWAITING-AUTH.2 / ARREARS-TYPE.2 — a transaction whose payment is IN PROGRESS
// / awaiting authorization. Per the Glofox OpenAPI spec, invoice status PENDING
// means "the payment is in progress but not yet confirmed"; Glofox's UI shows
// this as "Awaiting authorization". What the TransactionsList report ACTUALLY
// carries for such a charge (verified live 2026-08-23 on a "Client confirmation
// required: Custom Charge"): transaction_status 'PENDING_INTENT' with status
// 'pending authorization' and paid:false — the spec's PENDING never appears.
// Recognising only PENDING made the June backfill write every awaiting-auth
// custom charge as a PAST_DUE debt, and kept the reconcile from ever proposing
// the PAST_DUE→PENDING correction. This is DISTINCT from a failed charge (ERROR
// / SUBSCRIPTION_CYCLE_PAYMENT_FAILED), which is a genuine PAST_DUE debt.
function isPendingTxn(t) {
  return (
    t?.transaction_status === 'PENDING' ||
    t?.transaction_status === 'PENDING_INTENT' ||
    t?.status === 'PENDING' ||
    t?.status === 'pending' ||
    t?.status === 'pending authorization'
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/glofox-arrears.test.js src/lib/glofox-reconcile.test.js src/lib/arrears-retry-netting.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-arrears.js src/lib/glofox-arrears.test.js src/lib/glofox-reconcile.test.js
git commit -m "ARREARS-TYPE.2 — isPendingTxn: Glofox reports awaiting authorization as PENDING_INTENT / 'pending authorization'"
```

---

### Task 3: `bucketArrears` routes by kind; retire the €50 line

**Files:**
- Modify: `src/lib/churn-radar.js:525-580` (`OVERDUE_MIN_CENTS`, `splitArrears`, `bucketArrears`)
- Test: `src/lib/churn-radar.test.js:9-11, 667-687, 876-925`

- [ ] **Step 1: Write the failing tests**

In `src/lib/churn-radar.test.js`, remove `splitArrears,` and `OVERDUE_MIN_CENTS,` from the import list (keep `bucketArrears`). Delete the whole `describe('RADAR-OVERDUE.1 — splitArrears (€50 boundary)', …)` block (lines 667–687). Replace the whole `describe('bucketArrears (OWED-PENDING.1 / AWAITING-AUTH.1)', …)` block with:

```js
// ARREARS-TYPE.1 — tabs route by CHARGE TYPE, not by amount. The split itself
// (isMembershipInvoice) happens in fetchPastDue; bucketArrears maps its three
// per-contact maps onto the tabs and drops empty aggregates.
describe('bucketArrears — by charge type (ARREARS-TYPE.1)', () => {
  const M = (entries) => new Map(entries)
  const agg = (amountCents, oldestDueAt = '2026-05-01') => ({ amountCents, count: 1, oldestDueAt })

  it('routes PAST_DUE membership payments → Overdue at ANY amount (a €25 failed renewal)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ membershipById: M([['r', agg(2500)]]) })
    expect(overdueById.get('r')?.amountCents).toBe(2500)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.size).toBe(0)
  })

  it('routes every other PAST_DUE charge → Unpaid charges at ANY amount (a €380 failed class pack)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ chargesById: M([['p', agg(38000)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.get('p')?.amountCents).toBe(38000)
    expect(awaitingAuthById.size).toBe(0)
  })

  it('routes PENDING → Awaiting authorization only, even a €510 renewal in progress', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ pendingById: M([['a', agg(51000)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.get('a')?.amountCents).toBe(51000)
  })

  it('puts the SAME contact in Overdue and Unpaid charges with separate amounts (failed renewal + failed fee)', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({
      membershipById: M([['c', agg(19900, '2026-05-01')]]),
      chargesById: M([['c', agg(1000, '2026-05-20')]]),
      pendingById: M([['c', agg(500, '2026-05-26')]]),
    })
    expect(overdueById.get('c')).toMatchObject({ amountCents: 19900, oldestDueAt: '2026-05-01' })
    expect(unpaidById.get('c')).toMatchObject({ amountCents: 1000, oldestDueAt: '2026-05-20' })
    expect(awaitingAuthById.get('c')).toMatchObject({ amountCents: 500, oldestDueAt: '2026-05-26' })
  })

  it('drops zero-amount aggregates and tolerates missing maps / no argument', () => {
    const { overdueById, unpaidById, awaitingAuthById } = bucketArrears({ membershipById: M([['z', agg(0)]]) })
    expect(overdueById.size).toBe(0)
    expect(unpaidById.size).toBe(0)
    expect(awaitingAuthById.size).toBe(0)
    expect(bucketArrears(undefined)).toEqual({ overdueById: new Map(), unpaidById: new Map(), awaitingAuthById: new Map() })
    expect(bucketArrears({ membershipById: null, chargesById: 'nope' })).toEqual({ overdueById: new Map(), unpaidById: new Map(), awaitingAuthById: new Map() })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/churn-radar.test.js`
Expected: FAIL — the new `bucketArrears` cases (the current implementation reads positional Maps; an object argument yields empty buckets / wrong routing).

- [ ] **Step 3: Implement**

In `src/lib/churn-radar.js`, delete `OVERDUE_MIN_CENTS` and `splitArrears` (with their comments, lines ~525–547) and replace `bucketArrears` (with its JSDoc) with:

```js
// ARREARS-TYPE.1 — the tabs route by CHARGE TYPE (Richard's rule, 2026-08-23),
// not by the old €50 amount line (RADAR-OVERDUE.1). The amount was only ever a
// proxy for "is this a failed renewal or a small fee?", and it misrouted both
// ways: a €380 failed class pack landed on the chase-list, a €25 failed renewal
// would have been filed as a small charge. The split itself happens in
// fetchPastDue (churn-radar-data.js, via isMembershipInvoice); this maps its
// per-contact aggregates onto the tabs and drops empty ones.

/**
 * Bucket per-contact arrears into the three radar tabs:
 *   overdueById      — PAST_DUE membership payments (a failed subscription
 *                      renewal or first payment): the chase-list. Any amount.
 *   unpaidById       — every other PAST_DUE charge (late-cancel / no-show fees,
 *                      custom charges, class bookings, class packs, products).
 *                      Any amount.
 *   awaitingAuthById — PENDING ("awaiting authorization" in Glofox): a payment
 *                      in progress, not a confirmed debt. Never in the other two.
 * A contact can appear in more than one tab — a failed renewal in Overdue AND a
 * failed fee in Unpaid charges, each with its own amount.
 *
 * @param {{ membershipById?: Map, chargesById?: Map, pendingById?: Map }} arrears
 *   per-contact `{ amountCents, count, oldestDueAt }` aggregates from fetchPastDue
 * @returns {{ overdueById: Map, unpaidById: Map, awaitingAuthById: Map }}
 */
export function bucketArrears(arrears) {
  const nonEmpty = (m) => {
    const out = new Map()
    if (!(m instanceof Map)) return out
    for (const [id, agg] of m) {
      if ((agg?.amountCents || 0) > 0) out.set(id, agg)
    }
    return out
  }
  return {
    overdueById: nonEmpty(arrears?.membershipById),
    unpaidById: nonEmpty(arrears?.chargesById),
    awaitingAuthById: nonEmpty(arrears?.pendingById),
  }
}
```

Also update the `// ── overdue ──` section comment just above (the RADAR-OVERDUE.1 paragraph still describes the feature correctly; only the "€50" sentence about `OVERDUE_MIN_CENTS` goes away with the constant).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/churn-radar.test.js`
Expected: PASS. (`churn-radar-data.test.js` will now FAIL until Task 4 — expected.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/churn-radar.js src/lib/churn-radar.test.js
git commit -m "ARREARS-TYPE.3 — bucketArrears routes by charge type; OVERDUE_MIN_CENTS and splitArrears retired"
```

---

### Task 4: `fetchPastDue` aggregates per kind; wire both call sites

**Files:**
- Modify: `src/lib/churn-radar-data.js:19` (import), `:109-145` (`fetchPastDue`), `:362-385` (`loadRadar` badges), `:450-525` (`loadArrearsRows` + loader docs)
- Test: `src/lib/churn-radar-data.test.js`

- [ ] **Step 1: Update the existing tests to the new rule, then add the type-split suite**

The existing Overdue tests use subtype-less `PAST_DUE` rows as stand-ins for renewal debts. Under the type rule a row with no signal is an unpaid charge, so mark them as renewals. In `src/lib/churn-radar-data.test.js`:

- In the four `describe('loadOverdue — retry netting (Fix B)')` tests, add `line_item_subtypes: 'SUBSCRIPTION_RENEWAL'` to every `gInvoice({ … status: 'PAST_DUE' … })` call (`pd1` ×4 and `pd2`). The PAID rows stay as they are.
- In `'splits a small PAST_DUE (Unpaid charges) from a PENDING fee (Awaiting authorization)'`, add `line_item_subtypes: 'CUSTOM_CHARGE'` to the `pd` row and change the comment on the `expect(overdue).toHaveLength(0)` line to `// a €10 fee is not a membership payment → not on the chase-list`.
- In `'keeps a ≥€50 PAST_DUE debt on Overdue and its PENDING fee under Awaiting authorization'`, rename the test to `'keeps a failed renewal on Overdue and its PENDING fee under Awaiting authorization'` and add `line_item_subtypes: 'SUBSCRIPTION_RENEWAL'` to the `pd` row.

Then extend the `gInvoice` helper so a row can carry the backfill's event (add the parameter and the field):

```js
function gInvoice({ id, glofox_user_id, contact_id, amount_cents, status, invoice_date, line_item_subtypes = null, glofox_event = null }) {
  return { id, glofox_user_id, contact_id, amount_cents, status, invoice_date, line_item_subtypes, glofox_event, location_id: LOC }
}
```

Append this suite after the `PENDING custom-charge fees` describe block (before the `CHURN-RADAR-PERSON-AWARE` section):

```js
// ── ARREARS-TYPE.1: Overdue vs Unpaid charges by CHARGE TYPE ─────────────────
// Richard's rule (2026-08-23): Overdue = failed MEMBERSHIP payments only;
// Unpaid charges = every other failing transaction at ANY amount; pending stays
// in Awaiting authorization. The €50 line is gone.
describe('Overdue vs Unpaid charges — by charge type (ARREARS-TYPE.1)', () => {
  const PD = (over) => gInvoice({ status: 'PAST_DUE', invoice_date: '2026-05-03T00:00:00Z', ...over })

  it('a failed €380 class pack (lone UPFRONT_PAYMENT) is an Unpaid charge, not Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'pack', glofox_user_id: 'u1', contact_id: 'c-pack', amount_cents: 38000, line_item_subtypes: 'UPFRONT_PAYMENT' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-pack', name: 'Pack Buyer' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges, summary } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ contactId: 'c-pack', amountOwedCents: 38000, invoiceCount: 1 })
    expect(summary).toMatchObject({ total: 1, totalValueCents: 38000 })
  })

  it('a failed €25 renewal is Overdue, not an Unpaid charge', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'ren', glofox_user_id: 'u2', contact_id: 'c-ren', amount_cents: 2500, line_item_subtypes: 'SUBSCRIPTION_RENEWAL' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-ren', name: 'Small Renewal' })],
    })
    const { overdue, summary } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ contactId: 'c-ren', amountOwedCents: 2500 })
    expect(summary.totalValueCents).toBe(2500)
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(0)
  })

  it('a failed first payment at signup (SUBSCRIPTION_PAYMENT + €0 UPFRONT_PAYMENT) is Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'signup', glofox_user_id: 'u3', contact_id: 'c-new', amount_cents: 9900, line_item_subtypes: 'SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-new', name: 'New Signup' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue.map((r) => r.contactId)).toEqual(['c-new'])
  })

  it('a backfilled custom charge (no line items, raw_payload.candidate.glofoxEvent) is an Unpaid charge whatever its description or amount', async () => {
    // The €467 "Membership"-described custom charge from the June backfill.
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: '8e04230d', glofox_user_id: 'u4', contact_id: 'c-cc', amount_cents: 46700, line_item_subtypes: null, glofox_event: 'custom_charge', invoice_date: '2026-01-27T19:45:00Z' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-cc', name: 'Custom Charge' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(0)
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges.map((r) => [r.contactId, r.amountOwedCents])).toEqual([['c-cc', 46700]])
  })

  it('a backfilled failed renewal (glofoxEvent subscription_payment_failed) is Overdue', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [PD({ id: 'bf-ren', glofox_user_id: 'u5', contact_id: 'c-bf', amount_cents: 19900, line_item_subtypes: null, glofox_event: 'subscription_payment_failed' })]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-bf', name: 'Backfilled Renewal' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue.map((r) => r.contactId)).toEqual(['c-bf'])
  })

  it('the SAME contact with a failed renewal AND a failed fee appears in BOTH tabs with separate amounts', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [
            PD({ id: 'ren', glofox_user_id: 'u6', contact_id: 'c-both', amount_cents: 19900, line_item_subtypes: 'SUBSCRIPTION_RENEWAL', invoice_date: '2026-05-01T00:00:00Z' }),
            PD({ id: 'fee', glofox_user_id: 'u6', contact_id: 'c-both', amount_cents: 1000, line_item_subtypes: 'CUSTOM_CHARGE', invoice_date: '2026-05-20T00:00:00Z' }),
          ]
        : [],
      churn_radar_actions: [],
      contacts: [contact({ id: 'c-both', name: 'Both' })],
    })
    const { overdue } = await loadOverdue(db, LOC, NOW)
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ contactId: 'c-both', amountOwedCents: 19900, invoiceCount: 1 })
    const { charges } = await loadUnpaidCharges(db, LOC, NOW)
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ contactId: 'c-both', amountOwedCents: 1000, invoiceCount: 1 })
  })

  it('loadRadar summary badges match the tabs, and a fee-only contact still classifies as overdue (pill) without being on the chase-list', async () => {
    const db = makeDb({
      glofox_invoices: (state) => state.status === 'PAST_DUE'
        ? [
            PD({ id: 'ren', glofox_user_id: 'u7', contact_id: 'c-r', amount_cents: 19900, line_item_subtypes: 'SUBSCRIPTION_RENEWAL' }),
            PD({ id: 'pack', glofox_user_id: 'u8', contact_id: 'c-p', amount_cents: 38000, line_item_subtypes: 'UPFRONT_PAYMENT' }),
            PD({ id: 'fee', glofox_user_id: 'u9', contact_id: 'c-f', amount_cents: 1000, line_item_subtypes: 'CUSTOM_CHARGE' }),
          ]
        : state.status === 'PENDING'
          ? [gInvoice({ id: 'pend', glofox_user_id: 'u10', contact_id: 'c-a', amount_cents: 500, status: 'PENDING', invoice_date: '2026-05-26T00:00:00Z', line_item_subtypes: 'CUSTOM_CHARGE' })]
          : [],
      churn_radar_actions: [],
      contacts: ['c-r', 'c-p', 'c-f', 'c-a'].map((id) => contact({ id })),
      person_groups: [],
    })
    const { radar, summary } = await loadRadar(db, LOC, NOW)
    expect(summary).toMatchObject({
      overdue: 1, overdueValueCents: 19900,
      unpaidCharges: 2, unpaidChargesValueCents: 39000,
      awaitingAuth: 1, awaitingAuthValueCents: 500,
    })
    // Every contact with ANY open PAST_DUE is pulled off the at-risk list (ids/byId unchanged).
    expect(radar.map((r) => r.contactId)).not.toContain('c-f')
  })
})
```

Note: the `contacts` mock entries above have no `name` for the last test — `contact({ id })` defaults it to `'Member'`, which is fine.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/churn-radar-data.test.js`
Expected: FAIL — `bucketArrears(pastDue.byId, pastDue.pendingById)` now receives a Map as `arrears`, so every tab is empty; the new suite fails on routing.

- [ ] **Step 3: Implement**

In `src/lib/churn-radar-data.js`:

(a) Import the classifier:

```js
import { nettedOutByRetry, isMembershipInvoice } from '@/lib/glofox-arrears'
```

(b) Replace the body of `fetchPastDue` (keep the JSDoc above it, and append this paragraph to that JSDoc):

```js
 *
 * ARREARS-TYPE.1 — also splits the PAST_DUE aggregate by CHARGE TYPE: a
 * membership payment (a failed subscription renewal / first payment → the
 * Overdue tab) vs every other charge (fees, custom charges, class bookings,
 * class packs, products → the Unpaid-charges tab), via isMembershipInvoice on
 * `line_item_subtypes` (webhook rows) or the report event the June backfill
 * kept at raw_payload.candidate.glofoxEvent (backfilled rows have no line
 * items; PostgREST aliases it to `glofox_event` in the select). `ids` / `byId`
 * keep covering EVERY open PAST_DUE so the 'overdue' classification, the
 * profile pill and the P2-7 analytics are unchanged.
 * Returns `{ ids, byId, pendingById, membershipById, chargesById }`.
```

```js
export async function fetchPastDue(db, locationId) {
  const [pastDueRows, pendingRows, paidRows] = await Promise.all([
    fetchInvoicesByStatus(db, locationId, 'PAST_DUE', 'id, contact_id, glofox_user_id, amount_cents, invoice_date, status, line_item_subtypes, glofox_event:raw_payload->candidate->>glofoxEvent'),
    fetchInvoicesByStatus(db, locationId, 'PENDING', 'id, contact_id, glofox_user_id, amount_cents, invoice_date, status, line_item_subtypes'),
    fetchInvoicesByStatus(db, locationId, 'PAID', 'glofox_user_id, amount_cents, invoice_date'),
  ])
  // AWAITING-AUTH.2 — every PENDING invoice ("awaiting authorization" in Glofox:
  // a payment in progress, not yet confirmed) feeds the Awaiting-authorization
  // tab, whatever its charge type (class booking, product buy, fee or renewal).
  // Pending is never owed/overdue (see bucketArrears / the de-count); PAST_DUE
  // drives the Overdue + Unpaid-charges debt lists.
  const openRows = [...pastDueRows, ...pendingRows]
  // Net cross-invoice-id payment retries out before aggregating.
  const { kept } = nettedOutByRetry(openRows, paidRows)

  // OWED-PENDING.1 / AWAITING-AUTH.1 / ARREARS-TYPE.1 — aggregate the netted
  // rows per contact. PENDING stands alone (Awaiting authorization only).
  // PAST_DUE feeds `byId` (every debt — drives the 'overdue' classification)
  // AND one of the two tab maps by charge type.
  const byId = new Map()           // every PAST_DUE
  const membershipById = new Map() // PAST_DUE membership payments → Overdue
  const chargesById = new Map()    // PAST_DUE everything else → Unpaid charges
  const pendingById = new Map()    // PENDING → Awaiting authorization
  const add = (target, r) => {
    const cur = target.get(r.contact_id) || { amountCents: 0, count: 0, oldestDueAt: null }
    cur.amountCents += Number(r.amount_cents) || 0
    cur.count += 1
    if (r.invoice_date && (!cur.oldestDueAt || r.invoice_date < cur.oldestDueAt)) {
      cur.oldestDueAt = r.invoice_date
    }
    target.set(r.contact_id, cur)
  }
  for (const r of kept) {
    // A row with no contact_id can't be surfaced on a contact-keyed list.
    if (r.contact_id == null) continue
    if (r.status === 'PENDING') { add(pendingById, r); continue }
    add(byId, r)
    add(isMembershipInvoice(r) ? membershipById : chargesById, r)
  }
  // ids = PAST_DUE contacts only — a pending fee never classifies a member as
  // 'overdue' (no pill, off the chase-list); it shows in Awaiting authorization instead.
  return { ids: new Set(byId.keys()), byId, pendingById, membershipById, chargesById }
}
```

(c) In `loadRadar`, replace the comment + call:

```js
  // RADAR-OVERDUE.1 / AWAITING-AUTH.1 / ARREARS-TYPE.1 — split the full arrears
  // set so the headline badges match their tabs: Overdue (PAST_DUE membership
  // payments — failed renewals), Unpaid charges (every other PAST_DUE charge)
  // and Awaiting authorization (PENDING, not yet collected). Incl. ex-members
  // who owe. Pending never counts as Overdue or Unpaid charges. (A contact can
  // land in more than one bucket — a failed renewal AND a failed fee, say.)
  const { overdueById, unpaidById, awaitingAuthById } = bucketArrears(pastDue)
```

(d) In `loadArrearsRows`, replace the doc comment + the comment/call:

```js
/**
 * Build every open-arrears row at the location (minus dismissed), each with its
 * most recent contacting action, split into the three tabs: `overdue` (PAST_DUE
 * membership payments — the chase-list), `unpaidCharges` (every other PAST_DUE
 * charge) and `awaitingAuth` (PENDING, not yet collected). Shared by
 * loadOverdue + loadUnpaidCharges + loadAwaitingAuth so they read identical data.
 */
async function loadArrearsRows(db, locationId, nowMs) {
  const [pastDue, actions, dismissed] = await Promise.all([
    fetchPastDue(db, locationId),
    fetchActions(db, locationId),
    fetchDismissed(db, locationId),
  ])
  // ARREARS-TYPE.1 — by charge type: PAST_DUE membership payments → Overdue,
  // every other PAST_DUE charge → Unpaid charges, PENDING → Awaiting
  // authorization. A contact may appear in more than one tab.
  const { overdueById, unpaidById, awaitingAuthById } = bucketArrears(pastDue)
```

(e) Replace the `loadUnpaidCharges` JSDoc:

```js
/**
 * Load the "Unpaid charges" tab — contacts with an open CONFIRMED past-due
 * charge that is NOT a membership payment: late-cancel / no-show fees, staff
 * custom charges, class bookings, class packs and products, at any amount
 * (ARREARS-TYPE.1 — the old <€50 rule is gone). PENDING 'awaiting
 * authorization' charges are NOT here — they live in their own tab
 * (loadAwaitingAuth). Same row shape as Overdue.
 *
 * @returns {Promise<{ charges: object[], summary: object }>}
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/churn-radar-data.test.js src/lib/churn-radar.test.js`
Expected: PASS.

- [ ] **Step 5: Check nothing else reads the old shape**

Run: `grep -rn "bucketArrears(\|splitArrears\|OVERDUE_MIN_CENTS" src mobile --include='*.js' --include='*.jsx'`
Expected: only the two `bucketArrears(pastDue)` calls in `churn-radar-data.js`, the definition in `churn-radar.js`, and tests. (P2-7's `fetchPastDue` import reads `ids`/`byId` only — unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/churn-radar-data.js src/lib/churn-radar-data.test.js
git commit -m "ARREARS-TYPE.4 — fetchPastDue splits PAST_DUE by charge type; Overdue/Unpaid charges tabs follow"
```

---

### Task 5: `reconcile-fees` route — `restatus=true`

**Files:**
- Modify: `src/app/api/glofox/reconcile-fees/route.js`

- [ ] **Step 1: Implement** (no route test harness exists for this file; the gated behaviour it forwards to is covered in Task 2)

Replace the header comment's query-params block and the `commit` line:

```js
// Query params:
//   location_id  optional  defaults to user.activeLocation
//   commit       optional  'true' to write; anything else = dry run
//   restatus     optional  'true' to ALSO apply the PAST_DUE→PENDING
//                          awaiting-authorization re-status (AWAITING-AUTH.2 /
//                          ARREARS-TYPE.2). Proposed on every run (see
//                          `restated` / `byReason.awaiting_authorization` /
//                          `sample`); written only with commit=true&restatus=true.
//                          The daily cron never applies it on its own.
```

```js
  const commit = url.searchParams.get('commit') === 'true'
  const allowRestatus = url.searchParams.get('restatus') === 'true'
```

```js
    const res = await runArrearsReconcile(db, creds, locationId, { commit, allowRestatus })
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/app/api/glofox/reconcile-fees/route.js`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/glofox/reconcile-fees/route.js
git commit -m "ARREARS-TYPE.5 — reconcile-fees: restatus=true applies the awaiting-authorization correction from the browser"
```

---

### Task 6: UI copy + route comments

**Files:**
- Modify: `src/components/ChurnRadar.jsx:3-14` (header), `:840-930` (`OverdueList`, `UnpaidChargesList`, `AwaitingAuthList` copy)
- Modify: `src/app/api/churn-radar/unpaid-charges/route.js:1-8`, `src/app/api/churn-radar/overdue/route.js:1-8`

- [ ] **Step 1: Header comment in `ChurnRadar.jsx`**

```js
// Tabs:
//   At Risk       — scored active members + per-member win-back actions.
//   Win-back      — former members (lapsed 45–365 days) worth re-winning.
//   Overdue       — members whose MEMBERSHIP payment failed (a past-due
//                   subscription renewal / first payment); the chase-list.
//   Unpaid charges— every other confirmed past-due charge (fees, custom
//                   charges, class bookings, class packs, products), any amount.
//   Awaiting auth — PENDING charges Glofox hasn't collected yet (AWAITING-AUTH.1).
//   Quarantine    — zero-activity "ghost member" records for bulk triage.
```

- [ ] **Step 2: `OverdueList` copy**

Empty state:

```jsx
        <p className="mt-3 font-medium text-un1t-text">No failed membership payments</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          No member has a past-due membership renewal or first payment. Other
          unpaid items (fees, class packs, bookings, products) are under the{' '}
          <strong>Unpaid charges</strong> tab.
        </p>
```

Banner:

```jsx
      <p className="mb-1 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
        Members whose <strong>membership payment failed</strong> — a subscription
        renewal or first payment Glofox could not collect. The amount owed is the
        sum of their open past-due membership invoices, highest first; open a
        profile for their contact details. Fees, class packs, bookings and
        products are under <strong>Unpaid charges</strong>.
      </p>
```

- [ ] **Step 3: `UnpaidChargesList` copy** (also update the comment above the component)

```js
// ARREARS-TYPE.1 — every confirmed past-due charge that is NOT a membership
// payment: fees, custom charges, class bookings, class packs, products — any
// amount. Same row shape as Overdue, so it reuses OverdueRow; only the framing
// differs. PENDING 'awaiting authorization' charges are NOT here — own tab.
```

Empty state:

```jsx
        <p className="mt-3 font-medium text-un1t-text">No unpaid charges</p>
        <p className="mt-1 text-sm text-un1t-subtle">
          No member has a failed one-off charge. Failed membership payments are
          under the <strong>Overdue</strong> tab; charges still awaiting payment
          are under <strong>Awaiting authorization</strong>.
        </p>
```

Banner:

```jsx
      <p className="mb-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Failed one-off charges</strong> — late-cancel and no-show fees,
        custom charges, class bookings, class packs and products, at any amount.
        Not membership debts (those are under <strong>Overdue</strong>), but
        worth clearing. Charges not yet collected are under <strong>Awaiting
        authorization</strong>. Highest owed first.
      </p>
```

- [ ] **Step 4: `AwaitingAuthList` empty-state** — only the cross-reference sentence changes:

```jsx
          No member has a pending charge waiting to be collected. Confirmed
          past-due items are under the <strong>Overdue</strong> (membership
          payments) and <strong>Unpaid charges</strong> (everything else) tabs.
```

- [ ] **Step 5: Route header comments**

`src/app/api/churn-radar/unpaid-charges/route.js`:

```js
// GET /api/churn-radar/unpaid-charges
//
// ARREARS-TYPE.1 — the "Unpaid charges" tab: contacts with an open CONFIRMED
// past-due charge that is NOT a membership payment — late-cancel / no-show
// fees, custom charges, class bookings, class packs, products — at any amount
// (the old <€50 rule is gone). Same row shape as Overdue.
//
// Access: churn_radar permission (owner + head_coach by default).
```

`src/app/api/churn-radar/overdue/route.js`:

```js
// GET /api/churn-radar/overdue
//
// OVERDUE.1 / ARREARS-TYPE.1 — members whose MEMBERSHIP payment failed: an
// open PAST_DUE glofox_invoices row for a subscription renewal or first
// payment. A plain chase-list of customers who owe the business membership
// money, highest owed first. Other failed charges live under
// /api/churn-radar/unpaid-charges.
//
// Access: churn_radar permission (owner + head_coach by default).
```

- [ ] **Step 6: Lint the touched files**

Run: `npx eslint src/components/ChurnRadar.jsx src/app/api/churn-radar/unpaid-charges/route.js src/app/api/churn-radar/overdue/route.js`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/ChurnRadar.jsx src/app/api/churn-radar/unpaid-charges/route.js src/app/api/churn-radar/overdue/route.js
git commit -m "ARREARS-TYPE.6 — radar tab copy: Overdue = failed membership payments, Unpaid charges = everything else"
```

---

### Task 7: CHANGELOG, CI mirror, build

**Files:**
- Modify: `docs/CHANGELOG.md` (new row 570 at the top of the table)

- [ ] **Step 1: CHANGELOG row** — insert directly under the `|---|------|-------|` header line:

```markdown
| 570 | ARREARS-TYPE.1→.6 — churn-radar Overdue / Unpaid charges split by charge type, not €50; Glofox "awaiting authorization" charges no longer counted as debt | **Overdue** now = failed MEMBERSHIP payments only (`PAST_DUE` with `SUBSCRIPTION_RENEWAL` / `SUBSCRIPTION_PAYMENT` lines, or the backfill's `subscription_payment[_failed]` event); **Unpaid charges** = every other failing transaction at any amount (fees, custom charges, class bookings, class packs, products); Awaiting authorization unchanged. Richard's rule 2026-08-23 — the €50 line was a proxy that misrouted both ways (a €380 failed class pack on the chase-list). Pure `isMembershipInvoice` + `MEMBERSHIP_LINE_SUBTYPES` / `MEMBERSHIP_REPORT_EVENTS` (`glofox-arrears.js`); `fetchPastDue` adds `membershipById` / `chargesById` (`ids`/`byId` still = every `PAST_DUE`, so the pill / at-risk exclusion / profile / P2-7 are unchanged); `bucketArrears({ membershipById, chargesById, pendingById })`; `OVERDUE_MIN_CENTS` + `splitArrears` deleted. **Root cause of the €467 "Membership" custom charge sitting in Overdue:** Glofox's report carries awaiting-authorization charges as `transaction_status PENDING_INTENT` / `status 'pending authorization'`, not the spec's `PENDING` — `isPendingTxn` now recognises both, so the reconcile proposes the `PAST_DUE→PENDING` correction (still gated for the cron). Master route `/api/glofox/reconcile-fees` gains `restatus=true` (`commit=true&restatus=true` applies it from the browser). Tab copy rewritten. No migration. **Operator step after deploy:** dry-run the route, then commit+restatus once — ~6 backfilled rows / ~€1.9k move from Overdue to Awaiting authorization. Spec `docs/superpowers/specs/2026-08-23-arrears-type-split-design.md`. |
```

- [ ] **Step 2: Run the CI mirror** (one process at a time on this machine)

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every command exits 0. If vitest reports a worker timeout on an unrelated file, re-run `npm test` once before treating it as real (known 8 GB-machine flake).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: exits 0 (Task 4 changed an import line — this is the only check that proves it resolves).

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/CHANGELOG.md
git commit -m "ARREARS-TYPE.7 — CHANGELOG 570"
git push -u origin HEAD
gh pr create --base main --title "ARREARS-TYPE.1→.7 — Overdue/Unpaid charges split by charge type; Glofox PENDING_INTENT = awaiting authorization" --body-file - <<'EOF'
…(summary: rule, root cause, expected numbers, operator step; see CHANGELOG 570)…
EOF
```

- [ ] **Step 5: Verify on the Vercel preview (GET-only, prod data)**

Once the preview deploys: as master, open `<preview-url>/api/glofox/reconcile-fees?location_id=a0000000-0000-0000-0000-000000000001` — expect `restated ≥ 3` with `byReason.awaiting_authorization`; and `<preview-url>/api/churn-radar/overdue` — expect only renewal debts (≈7 contacts, ≈€1,870). Report both numbers in the PR.

---

## Self-review

- **Spec coverage:** §1 classifier → Task 1; §2 `fetchPastDue` → Task 4; §3 `bucketArrears` + deletions → Task 3; §4 `isPendingTxn` → Task 2; §5 route param → Task 5; §6 UI copy → Task 6; testing list → Tasks 1–4; post-deploy verification → Task 7 step 5. Out-of-scope items have no task (correct).
- **Placeholders:** none — every code step shows the code; the PR body in Task 7 is the one deliberately summarised line (it is prose the executor writes from the CHANGELOG row).
- **Type consistency:** `isMembershipInvoice(row)` reads `line_item_subtypes` + `glofox_event` (Task 1) and `fetchPastDue` supplies exactly those field names via the aliased select (Task 4). `bucketArrears(arrears)` takes `{ membershipById, chargesById, pendingById }` (Task 3) and both call sites pass the `fetchPastDue` result, which carries those keys (Task 4). `mkStripe`'s new `transaction_status` param (Task 2) matches the field `isPendingTxn` reads.
