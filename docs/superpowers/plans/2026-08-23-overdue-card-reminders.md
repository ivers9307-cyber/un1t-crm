# Overdue card-update reminders — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member's membership payment fails (the Overdue category), automatically send them a WhatsApp + email card-update reminder run (3 touches), exiting when the membership invoice is paid; make it operable from the churn-radar settings; re-runs allowed for later failures.

**Architecture:** Re-aim the existing reactive dunning (`src/lib/dunning.js` + Glofox webhook 7b) at membership invoices only via `isMembershipInvoice`; add an opt-in `allowReenrol` re-activation path to `enrolContacts` (dunning callers only, full unique index untouched); derive a transactional lane in the step senders from the enrolment's `source_type`; expose `dunning_auto_enroll` in the settings route/UI; rewrite the gallery template as the 3-touch automation with WhatsApp steps resolved by template name at install.

**Tech Stack:** Next.js 16 app routes, Supabase (no migration), vitest. Existing engine: `src/lib/sequences/*`.

**Spec:** `docs/superpowers/specs/2026-08-23-overdue-card-reminders-design.md`

**Machine note:** 8 GB dev Mac — one vitest run at a time, no parallel agents.

---

## File map

| File | Change |
|---|---|
| `src/lib/glofox-invoices.js` | `applyInvoiceWebhook` returns `is_membership` |
| `src/lib/dunning.js` | `dunningActionFor`; `maybeEnrolDunning` gates on `isMembership`, passes `allowReenrol` |
| `src/lib/dunning.test.js` | gate + action tests |
| `src/app/api/webhooks/glofox/route.js` | 7b uses `dunningActionFor` |
| `src/lib/sequences/cooldown.js` | `planReenrolments` |
| `src/lib/sequences/cooldown.test.js` | its tests |
| `src/lib/sequences/enrol.js` | `allowReenrol` re-activation |
| `src/lib/sequences/enrol.test.js` | mock gains `update`; re-activation tests |
| `src/lib/sequences/steps.js` | `TRANSACTIONAL_SOURCE_TYPES`, `isTransactionalEnrolment`; email + WhatsApp transactional gates |
| `src/lib/sequences/per-location-consent.test.js` | transactional cases |
| `src/app/api/churn-radar/action/route.js` | membership-invoice check; `allowReenrol` |
| `src/components/ChurnRadar.jsx` | reminder button only on Overdue; settings checkbox |
| `src/app/api/churn-radar/dunning-settings/route.js` | `dunning_auto_enroll` GET/PUT |
| `src/lib/sequence-templates.js` | template rewrite |
| `src/lib/sequence-templates.test.js` | template pins |
| `src/app/api/sequences/from-template/route.js` + `src/lib/sequences/template-install.js` (new) | `resolveWhatsappTemplateIds` |
| `docs/CHANGELOG.md` | entry 571 |

---

### Task 1: Trigger/exit follow the Overdue category

**Files:**
- Modify: `src/lib/glofox-invoices.js` (`applyInvoiceWebhook`, ~line 150)
- Modify: `src/lib/dunning.js`
- Modify: `src/app/api/webhooks/glofox/route.js:310-332`
- Test: `src/lib/dunning.test.js`

- [ ] **Step 1: Failing tests**

In `src/lib/dunning.test.js` change the import line to:

```js
import { maybeEnrolDunning, exitDunningForContact, dunningActionFor } from './dunning.js'
```

Replace the test `'skips when the member is not actually behind'` body's call and add the gate tests. Every existing `maybeEnrolDunning(db, 'loc', 'c1', {...})` call in the file that expects enrolment (or the paused / not-behind skips) must now pass `isMembership: true` — update each call's options to include it, e.g. `maybeEnrolDunning(db, 'loc', 'c1', { isMembership: true })`. Then append inside `describe('maybeEnrolDunning', …)`:

```js
  it('DUNNING.1 — never enrols for a non-membership invoice (a fee / class pack / custom charge), and fails closed when the flag is missing', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'fee1', isMembership: false })).toEqual({ enrolled: 0, reason: 'not_membership_invoice' })
    expect(await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'fee1' })).toEqual({ enrolled: 0, reason: 'not_membership_invoice' })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('DUNNING.1 — a failed membership invoice enrols as a transactional, re-runnable dunning enrolment', async () => {
    vi.mocked(paymentTroubleKind).mockReturnValue('overdue')
    vi.mocked(enrolContacts).mockResolvedValue({ enrolled: 1, skipped: 0, reactivated: 0 })
    const db = fakeDb({
      location: { dunning_sequence_id: 'seq1', dunning_auto_enroll: true },
      sequence: ACTIVE_SEQ,
      contact: { glofox_membership_state: 'active' },
    })
    const res = await maybeEnrolDunning(db, 'loc', 'c1', { invoiceId: 'inv-renewal', isMembership: true })
    expect(res).toMatchObject({ enrolled: 1, sequence_id: 'seq1' })
    expect(enrolContacts).toHaveBeenCalledWith({
      sequenceId: 'seq1', contactIds: ['c1'], sourceType: 'invoice_past_due', sourceRef: 'inv-renewal', allowReenrol: true,
    })
  })
```

Append a new describe at the end of the file:

```js
describe('dunningActionFor (DUNNING.1) — the webhook decision', () => {
  it('enrols on a failed MEMBERSHIP invoice only', () => {
    expect(dunningActionFor('PAST_DUE', true)).toBe('enrol')
    expect(dunningActionFor('PAST_DUE', false)).toBeNull()
    expect(dunningActionFor('PAST_DUE', undefined)).toBeNull()
  })
  it('exits on a settled MEMBERSHIP invoice only — a paid fee never cancels a reminder run', () => {
    expect(dunningActionFor('PAID', true)).toBe('exit')
    expect(dunningActionFor('FORGIVEN', true)).toBe('exit')
    expect(dunningActionFor('PAID', false)).toBeNull()
    expect(dunningActionFor('FORGIVEN', false)).toBeNull()
  })
  it('ignores every other status and is case-insensitive', () => {
    expect(dunningActionFor('PENDING', true)).toBeNull()
    expect(dunningActionFor('CANCELLED', true)).toBeNull()
    expect(dunningActionFor('past_due', true)).toBe('enrol')
    expect(dunningActionFor(null, true)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/dunning.test.js`
Expected: FAIL — `dunningActionFor` is not exported; the gate test gets `enrolled` instead of `not_membership_invoice`.

- [ ] **Step 3: Implement**

`src/lib/glofox-invoices.js` — add the import at the top (after the `selectAll` import):

```js
import { isMembershipInvoice } from '@/lib/glofox-arrears'
```

and in `applyInvoiceWebhook`'s success return add the field:

```js
  return {
    ok: true,
    invoice_id: parsed.id,
    invoice_status: parsed.status,
    amount_cents: parsed.amount_cents,
    // DUNNING.1 — is this a membership payment (renewal / first payment), i.e.
    // the churn radar's Overdue category? Drives reactive dunning: only a
    // failed MEMBERSHIP invoice starts card-update reminders, and only a
    // settled one stops them.
    is_membership: isMembershipInvoice(parsed),
    aggregates: aggs,
  }
```

`src/lib/dunning.js` — update the header comment's first bullet and `maybeEnrolDunning`:

```js
//   PAST_DUE  → maybeEnrolDunning(): opt-in per location
//               (dunning_auto_enroll, default off), MEMBERSHIP invoices
//               only (DUNNING.1 — the radar's Overdue category; a failed
//               fee / class pack / custom charge never starts "update your
//               card" reminders), never dun a paused member, re-derive
//               trouble server-side (same guard as the manual path), then
//               enrolContacts (idempotent, allowReenrol so a later failure
//               re-runs the reminders — see enrol.js).
//   PAID /    → exitDunningForContact(): stop any in-flight dunning —
//   FORGIVEN    the gap the manual flow never closed. MEMBERSHIP invoices
//               only (a paid €5 fee must not cancel the run).
```

```js
/**
 * DUNNING.1 — what the Glofox INVOICE_UPDATED webhook should do about
 * dunning for this invoice. Pure.
 *   PAST_DUE + membership         → 'enrol'
 *   PAID / FORGIVEN + membership  → 'exit'
 *   anything else                 → null (fees, class packs, custom charges,
 *                                   pending, cancelled — never touch the run)
 * @param {string|null|undefined} invoiceStatus
 * @param {boolean|undefined} isMembership  applyInvoiceWebhook().is_membership
 * @returns {'enrol'|'exit'|null}
 */
export function dunningActionFor(invoiceStatus, isMembership) {
  if (isMembership !== true) return null
  const st = String(invoiceStatus || '').toUpperCase()
  if (st === 'PAST_DUE') return 'enrol'
  if (st === 'PAID' || st === 'FORGIVEN') return 'exit'
  return null
}
```

In `maybeEnrolDunning`, change the signature and add the gate as the first check after `no_contact`:

```js
export async function maybeEnrolDunning(db, locationId, contactId, { invoiceId, isMembership } = {}) {
  try {
    if (!contactId) return { enrolled: 0, reason: 'no_contact' }
    // DUNNING.1 — fail closed: only a MEMBERSHIP invoice (the Overdue
    // category) starts reminders; an absent flag is treated as "not".
    if (isMembership !== true) return { enrolled: 0, reason: 'not_membership_invoice' }
```

and the `enrolContacts` call gains the flag:

```js
    const res = await enrolContacts({
      sequenceId: seqId,
      contactIds: [contactId],
      sourceType: 'invoice_past_due',
      sourceRef: invoiceId || null,
      // DUNNING.2 — a member whose card fails again months later must be
      // reminded again; the full unique index would otherwise block them
      // forever. Dunning is the only automatic caller allowed to re-run.
      allowReenrol: true,
    })
```

`src/app/api/webhooks/glofox/route.js` — import and 7b block:

```js
import { maybeEnrolDunning, exitDunningForContact, dunningActionFor } from '@/lib/dunning'
```

```js
    // 7b. GLOFOX-REACTIVE / DUNNING.1 — event-driven dunning off the invoice
    // status, MEMBERSHIP invoices only (the churn radar's Overdue category).
    // PAST_DUE → enrol into the location's dunning sequence (opt-in via
    // locations.dunning_auto_enroll; paused members skipped; idempotent so a
    // retry storm collapses to one enrolment). PAID / FORGIVEN → stop any
    // in-flight dunning. A fee / class pack / custom charge never starts OR
    // stops a run — dunningActionFor returns null for those.
    // Best-effort: the helpers never throw, but guard anyway.
    let dunningResult = null
    if (isInvoiceEvent && ltvResult?.ok) {
      const invStatus = String(ltvResult.invoice_status || '').toUpperCase()
      const action = dunningActionFor(invStatus, ltvResult.is_membership)
      try {
        if (action === 'enrol') {
          dunningResult = await maybeEnrolDunning(db, creds.locationId, contact.id, { invoiceId: ltvResult.invoice_id, isMembership: true })
        } else if (action === 'exit') {
          dunningResult = await exitDunningForContact(db, creds.locationId, contact.id, `invoice_${invStatus.toLowerCase()}`)
        }
      } catch (e) {
        logWarn('glofox-webhook', 'reactive dunning threw', { err: e?.message, contact_id: contact.id })
      }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/dunning.test.js src/lib/glofox-invoices.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-invoices.js src/lib/dunning.js src/lib/dunning.test.js src/app/api/webhooks/glofox/route.js
git commit -m "DUNNING.1 — reactive dunning follows the Overdue category: membership invoices start and stop it, fees never do"
```

---

### Task 2: `planReenrolments` — who may re-run

**Files:**
- Modify: `src/lib/sequences/cooldown.js`
- Test: `src/lib/sequences/cooldown.test.js`

- [ ] **Step 1: Failing tests** — change the import to `import { findBlockedByCooldown, planReenrolments } from './cooldown.js'` and append:

```js
// DUNNING.2 — re-activation planning. The full unique index on
// (sequence_id, contact_id) means a contact with a terminal row can never be
// INSERTED again; dunning callers re-activate that row instead. This decides,
// per contact, whether that is allowed right now.
describe('planReenrolments (DUNNING.2)', () => {
  const NOW = Date.parse('2026-08-23T12:00:00Z')
  const term = (contactId, endIso, over = {}) => ({
    id: `enr-${contactId}`, contact_id: contactId, status: 'completed',
    last_processed_at: endIso, created_at: endIso, source_ref: 'inv-old', ...over,
  })

  it('re-activates a terminal row outside the cooldown for a NEW source ref', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString())], 14, 'inv-new', NOW)
    expect(plan.get('a')).toEqual({ decision: 'reactivate', row: expect.objectContaining({ id: 'enr-a' }) })
  })

  it('blocks a terminal row inside the cooldown', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 3 * DAY).toISOString())], 14, 'inv-new', NOW)
    expect(plan.get('a').decision).toBe('blocked')
  })

  it('never re-runs for the SAME source ref (Glofox re-sends PAST_DUE on every retry of one invoice)', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString(), { source_ref: 'inv-same' })], 14, 'inv-same', NOW)
    expect(plan.get('a').decision).toBe('same_source')
  })

  it('a null source ref (operator click) always qualifies once the cooldown has passed', () => {
    const plan = planReenrolments([term('a', new Date(NOW - 20 * DAY).toISOString())], 14, null, NOW)
    expect(plan.get('a').decision).toBe('reactivate')
  })

  it('no cooldown configured → blocked (legacy single-enrolment semantics are preserved)', () => {
    expect(planReenrolments([term('a', new Date(NOW - 400 * DAY).toISOString())], null, 'inv-new', NOW).get('a').decision).toBe('blocked')
    expect(planReenrolments([term('a', new Date(NOW - 400 * DAY).toISOString())], 0, 'inv-new', NOW).get('a').decision).toBe('blocked')
  })

  it('uses the most recent terminal row per contact', () => {
    const rows = [
      term('a', new Date(NOW - 40 * DAY).toISOString(), { id: 'enr-old' }),
      term('a', new Date(NOW - 2 * DAY).toISOString(), { id: 'enr-new' }),
    ]
    expect(planReenrolments(rows, 14, 'inv-new', NOW).get('a').decision).toBe('blocked')
    const rows2 = [
      term('a', new Date(NOW - 40 * DAY).toISOString(), { id: 'enr-old' }),
      term('a', new Date(NOW - 20 * DAY).toISOString(), { id: 'enr-new' }),
    ]
    expect(planReenrolments(rows2, 14, 'inv-new', NOW).get('a')).toMatchObject({ decision: 'reactivate', row: { id: 'enr-new' } })
  })

  it('tolerates empty / malformed input', () => {
    expect(planReenrolments([], 14, 'x', NOW).size).toBe(0)
    expect(planReenrolments(null, 14, 'x', NOW).size).toBe(0)
    expect(planReenrolments([{ contact_id: null }], 14, 'x', NOW).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/sequences/cooldown.test.js` → FAIL (`planReenrolments` undefined).

- [ ] **Step 3: Implement** — append to `src/lib/sequences/cooldown.js`:

```js
/**
 * DUNNING.2 — decide, per contact, whether a TERMINAL enrolment row may be
 * re-activated for a fresh run. Used only by callers that pass
 * `allowReenrol` to enrolContacts (the dunning paths); every other caller
 * keeps the one-enrolment-ever semantics the full unique index enforces.
 *
 *   'blocked'      — inside the cooldown, or no cooldown configured
 *   'same_source'  — the new sourceRef equals the latest run's source_ref
 *                    (Glofox re-sends PAST_DUE on every retry of ONE invoice;
 *                    subscription dunning reuses the invoice id — that is not
 *                    a new failure). A null sourceRef always qualifies.
 *   'reactivate'   — outside the cooldown, different source → run again
 *
 * @param {Array<{ id:string, contact_id:string, status:string, last_processed_at?:string|null, created_at?:string, source_ref?:string|null }>} history
 *   terminal rows (completed / exited) for the candidate contacts
 * @param {number|null|undefined} cooldownDays
 * @param {string|null} sourceRef   the new run's source ref
 * @param {number} [nowMs]
 * @returns {Map<string, { decision: 'blocked'|'same_source'|'reactivate', row: object }>}
 */
export function planReenrolments(history, cooldownDays, sourceRef, nowMs = Date.now()) {
  const out = new Map()
  if (!Array.isArray(history) || history.length === 0) return out
  // Latest terminal row per contact (the one a re-run would revive).
  const latest = new Map()
  for (const h of history) {
    if (!h?.contact_id) continue
    const end = h.last_processed_at || h.created_at || ''
    const prior = latest.get(h.contact_id)
    if (!prior || end > (prior.last_processed_at || prior.created_at || '')) latest.set(h.contact_id, h)
  }
  const blocked = findBlockedByCooldown(history, cooldownDays, nowMs)
  for (const [cid, row] of latest) {
    let decision = 'reactivate'
    if (blocked.has(cid)) decision = 'blocked'
    else if (sourceRef != null && row.source_ref != null && String(row.source_ref) === String(sourceRef)) decision = 'same_source'
    out.set(cid, { decision, row })
  }
  return out
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/sequences/cooldown.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/cooldown.js src/lib/sequences/cooldown.test.js
git commit -m "DUNNING.2 — planReenrolments: when a terminal enrolment may be re-activated"
```

---

### Task 3: `enrolContacts({ allowReenrol })` re-activates in place

**Files:**
- Modify: `src/lib/sequences/enrol.js`
- Test: `src/lib/sequences/enrol.test.js`

- [ ] **Step 1: Failing tests**

Extend the mock in `src/lib/sequences/enrol.test.js`: add an `updates` collector and an `update` builder on `sequence_enrollments`. In `mockDb`'s destructured options nothing changes; add `const updates = []` next to `const inserts = []`, and inside the `sequence_enrollments` branch add, after `upsert`:

```js
          // DUNNING.2 — re-activation is an UPDATE guarded by id + the
          // terminal status that was read. Records {payload, filters}.
          update: vi.fn((payload) => {
            const rec = { payload, filters: [] }
            updates.push(rec)
            const b = {
              eq: vi.fn((col, val) => { rec.filters.push([col, val]); return b }),
              select: vi.fn(async () => ({ data: [{ id: rec.filters.find((f) => f[0] === 'id')?.[1] }], error: null })),
            }
            return b
          }),
```

and return `updates` from `mockDb` (add it to the returned object). The history read mock returns whatever `history` rows the test passes — give them the wider shape. Append tests:

```js
describe('allowReenrol — re-activate a terminal enrolment (DUNNING.2)', () => {
  const NOW_ISO = '2026-08-23T12:00:00.000Z'
  const old = (over = {}) => ({
    id: 'enr-a', contact_id: 'a', status: 'completed', source_type: 'invoice_past_due', source_ref: 'inv-old',
    last_processed_at: '2026-07-01T00:00:00.000Z', created_at: '2026-06-24T00:00:00.000Z',
    enrolled_at: '2026-06-24T00:00:00.000Z', completed_at: '2026-07-01T00:00:00.000Z', exited_at: null, exit_reason: null,
    metadata: null, ...over,
  })

  it('default path is untouched: a terminal row outside the cooldown still only hits the index (skipped, no update)', async () => {
    const m = mockDb({ history: [old()], cooldownDays: 14, conflictedContactIds: ['a'] })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-new' })
    expect(res).toMatchObject({ enrolled: 0, skipped: 1 })
    expect(m.updates).toHaveLength(0)
  })

  it('re-activates the terminal row in place for a new source ref outside the cooldown', async () => {
    const m = mockDb({ history: [old()], cooldownDays: 14 })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-new', allowReenrol: true })
    expect(res).toMatchObject({ enrolled: 1, reactivated: 1, skipped: 0 })
    expect(m.inserts).toHaveLength(0)                     // never an insert for a re-run
    expect(m.updates).toHaveLength(1)
    const u = m.updates[0]
    expect(u.filters).toEqual([['id', 'enr-a'], ['status', 'completed']])   // status guard
    expect(u.payload).toMatchObject({
      status: 'active', current_step_order: 0, exit_reason: null, completed_at: null, exited_at: null,
      last_error: null, error_count: 0, last_processed_at: null,
      source_type: 'invoice_past_due', source_ref: 'inv-new',
    })
    expect(typeof u.payload.next_step_at).toBe('string')
    expect(typeof u.payload.enrolled_at).toBe('string')
    expect(u.payload.metadata.previous_runs).toEqual([{
      source_type: 'invoice_past_due', source_ref: 'inv-old', status: 'completed',
      enrolled_at: '2026-06-24T00:00:00.000Z', ended_at: '2026-07-01T00:00:00.000Z', exit_reason: null,
    }])
    expect(m.rpcCalls).toEqual([{ name: 'increment_sequence_enrolled', args: { p_sequence_id: 's', p_delta: 1 } }])
  })

  it('appends to an existing previous_runs list and preserves other metadata', async () => {
    const m = mockDb({ history: [old({ metadata: { previous_runs: [{ source_ref: 'inv-older' }], note: 'keep' } })], cooldownDays: 14 })
    createServerClient.mockReturnValue(m.db)
    await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-new', allowReenrol: true })
    expect(m.updates[0].payload.metadata).toMatchObject({ note: 'keep' })
    expect(m.updates[0].payload.metadata.previous_runs.map((r) => r.source_ref)).toEqual(['inv-older', 'inv-old'])
  })

  it('does NOT re-activate for the same source ref (a Glofox retry of the same invoice)', async () => {
    const m = mockDb({ history: [old({ source_ref: 'inv-same' })], cooldownDays: 14 })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-same', allowReenrol: true })
    expect(res).toMatchObject({ enrolled: 0, reactivated: 0, skipped: 1 })
    expect(m.updates).toHaveLength(0)
    expect(m.inserts).toHaveLength(0)
  })

  it('does NOT re-activate inside the cooldown', async () => {
    const m = mockDb({ history: [old({ last_processed_at: NOW_ISO })], cooldownDays: 14 })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-new', allowReenrol: true })
    expect(res).toMatchObject({ enrolled: 0, reactivated: 0, skipped: 1 })
    expect(m.updates).toHaveLength(0)
  })

  it('a contact with no history still INSERTS normally under allowReenrol', async () => {
    const m = mockDb({ history: [], cooldownDays: 14 })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['b'], sourceType: 'invoice_past_due', sourceRef: 'inv-1', allowReenrol: true })
    expect(res).toMatchObject({ enrolled: 1, reactivated: 0 })
    expect(m.inserts[0].map((r) => r.contact_id)).toEqual(['b'])
    expect(m.updates).toHaveLength(0)
  })

  it('a lost status-guard race (0 rows updated) is a skip, not an enrolment', async () => {
    const m = mockDb({ history: [old()], cooldownDays: 14 })
    // Simulate the guard losing: update().select() returns no rows.
    const realFrom = m.db.from
    m.db.from = vi.fn((table) => {
      const b = realFrom(table)
      if (table === 'sequence_enrollments' && b.update) {
        const origUpdate = b.update
        b.update = vi.fn((payload) => {
          const chain = origUpdate(payload)
          chain.select = vi.fn(async () => ({ data: [], error: null }))
          return chain
        })
      }
      return b
    })
    createServerClient.mockReturnValue(m.db)
    const res = await enrolContacts({ sequenceId: 's', contactIds: ['a'], sourceType: 'invoice_past_due', sourceRef: 'inv-new', allowReenrol: true })
    expect(res).toMatchObject({ enrolled: 0, reactivated: 0, skipped: 1 })
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/sequences/enrol.test.js` → the new describe fails (no `reactivated`, no updates).

- [ ] **Step 3: Implement** in `src/lib/sequences/enrol.js`:

Import: `import { findBlockedByCooldown, planReenrolments } from './cooldown.js'`

JSDoc + signature:

```js
 * @param {boolean} [args.allowReenrol=false]  DUNNING.2 — re-activate a
 *   contact's TERMINAL enrolment row (completed / exited) in place when the
 *   sequence's cooldown has passed and the sourceRef differs from the last
 *   run's. Only the dunning paths pass this: the full unique index on
 *   (sequence_id, contact_id) otherwise means one enrolment per contact EVER
 *   (ENROLDEDUP.1), and a member whose card fails again months later must be
 *   reminded again. Every other caller keeps the one-enrolment semantics —
 *   this is deliberately not a cohort-wide re-entry.
 * @returns {Promise<{ enrolled: number, skipped: number, reactivated: number }>}
 */
export async function enrolContacts({
  sequenceId, contactIds, sourceType = 'manual', sourceRef = null, allowReenrol = false,
}) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { enrolled: 0, skipped: 0, reactivated: 0 }
  }
```

Widen the history read's select so re-activation has what it needs (the mock keys on `last_processed_at` being present):

```js
        .select('id, contact_id, status, last_processed_at, created_at, source_type, source_ref, enrolled_at, completed_at, exited_at, exit_reason, metadata')
```

Keep `blockedFromHistory = findBlockedByCooldown(history, cooldownDays)` as is, then directly after it (inside the same `if (candidatesNotActive.length > 0)` block) add:

```js
    // DUNNING.2 — with allowReenrol, a contact whose latest terminal row is
    // outside the cooldown AND carries a different source_ref is re-activated
    // in place below. Everyone with history is removed from the INSERT path
    // either way: an insert for them can only hit the index.
    if (allowReenrol) {
      reenrolPlan = planReenrolments(history, cooldownDays, sourceRef)
      for (const cid of reenrolPlan.keys()) blockedFromHistory.add(cid)
    }
```

(declare `let reenrolPlan = new Map()` next to `let blockedFromHistory = new Set()`).

After the `toInsert` array is built and before `if (toInsert.length === 0)`, add the re-activation block and change the early return / final return to include `reactivated`:

```js
  // DUNNING.2 — re-activate in place. One UPDATE per contact (dunning is
  // per-member, never a fan-out), guarded by id + the terminal status we
  // read so a concurrent activation can never be clobbered. The previous
  // run is kept on metadata.previous_runs so run history stays honest.
  let reactivated = 0
  let reenrolSkipped = 0
  if (allowReenrol && reenrolPlan.size > 0) {
    const nowIso = new Date().toISOString()
    for (const [, plan] of reenrolPlan) {
      if (plan.decision !== 'reactivate') { reenrolSkipped++; continue }
      const row = plan.row
      const prevMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}
      const previousRuns = Array.isArray(prevMeta.previous_runs) ? prevMeta.previous_runs : []
      const { data: updated, error: updErr } = await db
        .from('sequence_enrollments')
        .update({
          status: 'active',
          current_step_order: 0,
          next_step_at: nowIso,
          enrolled_at: nowIso,
          exit_reason: null,
          completed_at: null,
          exited_at: null,
          last_error: null,
          error_count: 0,
          last_processed_at: null,
          source_type: sourceType,
          source_ref: sourceRef,
          metadata: {
            ...prevMeta,
            previous_runs: [
              ...previousRuns,
              {
                source_type: row.source_type ?? null,
                source_ref: row.source_ref ?? null,
                status: row.status,
                enrolled_at: row.enrolled_at ?? null,
                ended_at: row.completed_at || row.exited_at || row.last_processed_at || null,
                exit_reason: row.exit_reason ?? null,
              },
            ],
          },
        })
        .eq('id', row.id)
        .eq('status', row.status)
        .select('id')
      if (updErr) throw new Error(`Re-enrol failed: ${updErr.message}`)
      if ((updated || []).length > 0) reactivated++
      else reenrolSkipped++
    }
  }

  if (toInsert.length === 0) {
    await bumpEnrolledCounter(db, sequenceId, reactivated)
    return { enrolled: reactivated, skipped: alreadyActive.size + exemptSkipped + reenrolSkipped, reactivated }
  }
```

Replace the existing counter-bump `try { await db.rpc(...) } catch {}` with a call `await bumpEnrolledCounter(db, sequenceId, enrolledCount + reactivated)` and add the helper above `enrolContacts`:

```js
// Bump the cached counter on the parent sequence. Best-effort — the runner
// doesn't depend on it; it's the admin dashboard's number. A supabase-js
// builder is a thenable with no `.catch`, so this must be try/await/catch.
async function bumpEnrolledCounter(db, sequenceId, delta) {
  if (!delta) return
  try {
    await db.rpc('increment_sequence_enrolled', { p_sequence_id: sequenceId, p_delta: delta })
  } catch { /* RPC not present / best-effort counter — no-op */ }
}
```

Final return:

```js
  return {
    enrolled: enrolledCount + reactivated,
    skipped: alreadyActive.size + exemptSkipped + reenrolSkipped + (toInsert.length - enrolledCount),
    reactivated,
  }
```

Note: the existing tests assert `rpcCalls` shapes for the insert path — `bumpEnrolledCounter` must not call the RPC when `delta` is 0 (the old code called it with `p_delta: enrolledCount` even when 0 — check the existing test expectations; if one asserts a zero-delta call, keep calling when `enrolledCount` is a number and only skip for the early-return path). Adjust so existing tests still pass.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/sequences/enrol.test.js src/lib/sequences/cooldown.test.js src/lib/dunning.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/enrol.js src/lib/sequences/enrol.test.js
git commit -m "DUNNING.2 — enrolContacts allowReenrol: dunning re-activates a terminal enrolment in place"
```

---

### Task 4: Transactional lane in the step senders

**Files:**
- Modify: `src/lib/sequences/steps.js` (`sendEmailStep` ~160-220, `sendWhatsappStep` ~344-410)
- Test: `src/lib/sequences/per-location-consent.test.js`

- [ ] **Step 1: Failing tests** — append to `per-location-consent.test.js`:

```js
// DUNNING.3 — transactional lane. A dunning enrolment (source_type
// invoice_past_due / churn_radar) is a service message about the member's
// own account: it skips the MARKETING consent gate but keeps every hard
// block (on the list, bounced/complained/suppressed, wa opted_out/blocked).
describe('DUNNING.3 — transactional enrolments skip the marketing gate, keep the hard blocks', () => {
  const txn = { id: 'e-dun', source_type: 'invoice_past_due' }
  const utilityRoute = (state) => {
    if (state.table === 'whatsapp_templates') {
      return { data: { id: 'tpl-1', name: 'outstanding_payment_', category: 'UTILITY', language: 'en', status: 'APPROVED', location_id: 'loc-hatch', components: [] } }
    }
    if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
    return {}
  }
  const marketingRoute = (state) => {
    if (state.table === 'whatsapp_templates') {
      return { data: { id: 'tpl-1', name: 'promo', category: 'MARKETING', language: 'en', status: 'APPROVED', location_id: 'loc-hatch', components: [] } }
    }
    if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
    return {}
  }

  it('EMAIL: sends to a member who opted OUT of marketing at this location', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: true, maxPerWindow: 0, windowDays: 7 } })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })

  it('EMAIL: still skips someone NOT on this location\'s list', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: contact({ global: true, atOther: true }), frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('EMAIL: still skips bounced / complained / suppressed', async () => {
    for (const patch of [{ email_status: 'bounced' }, { email_status: 'complained' }, { email_suppressed_at: '2026-08-01T00:00:00Z' }]) {
      vi.clearAllMocks()
      const { db } = makeDb(route)
      await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: { ...contact({ global: false, atHatch: false }), ...patch }, frequencyCap: { enabled: false } })
      expect(sendMarketingEmail).not.toHaveBeenCalled()
    }
  })

  it('EMAIL: a marketing enrolment to the same opted-out member is still skipped (lane is per enrolment)', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: { id: 'e1', source_type: 'trigger:tag_added' }, step: emailStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('WHATSAPP: sends a UTILITY template to a member who opted OUT of WhatsApp marketing', async () => {
    const { db } = makeDb(utilityRoute)
    await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: true, maxPerWindow: 0, windowDays: 7 } })
    expect(sendTemplateMessage).toHaveBeenCalled()
  })

  it('WHATSAPP: a MARKETING template keeps the marketing gate even in a transactional enrolment', async () => {
    const { db } = makeDb(marketingRoute)
    await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: false } })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('WHATSAPP: still skips opted_out / blocked / undeliverable and off-list', async () => {
    for (const c of [
      { ...contact({ global: false, atHatch: false }), wa_status: 'opted_out' },
      { ...contact({ global: false, atHatch: false }), wa_status: 'blocked' },
      { ...contact({ global: false, atHatch: false }), wa_status: 'undeliverable' },
      contact({ global: true, atOther: true }),
    ]) {
      vi.clearAllMocks()
      const { db } = makeDb(utilityRoute)
      await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: c, frequencyCap: { enabled: false } })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    }
  })

  it('the manual radar reminder (churn_radar) is transactional too', () => {
    expect(isTransactionalEnrolment({ source_type: 'churn_radar' })).toBe(true)
    expect(isTransactionalEnrolment({ source_type: 'invoice_past_due' })).toBe(true)
    expect(isTransactionalEnrolment({ source_type: 'manual' })).toBe(false)
    expect(isTransactionalEnrolment(null)).toBe(false)
    expect(TRANSACTIONAL_SOURCE_TYPES).toEqual(['invoice_past_due', 'churn_radar'])
  })
})
```

and extend the import: `import { sendEmailStep, sendWhatsappStep, isTransactionalEnrolment, TRANSACTIONAL_SOURCE_TYPES } from './steps.js'`.

Check the existing `makeDb`/`route` in this file: the WhatsApp template mock has no `category` — the MARKETING-gate behaviour for the existing tests must be unchanged (a template with no category is treated as NOT utility → marketing gate). Also the `frequencyCap` object shape: look at `assertNotFrequencyCapped` (line ~84) to pass a cap that WOULD defer under the marketing lane; the transactional tests above pass `enabled: true, maxPerWindow: 0` as a "would defer" cap — adjust the field names to whatever that function reads.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/sequences/per-location-consent.test.js` → FAIL.

- [ ] **Step 3: Implement** in `src/lib/sequences/steps.js`.

Add near the top (after the imports):

```js
// ── DUNNING.3 — transactional lane ───────────────────────────────
// A dunning enrolment is a SERVICE message about the member's own account
// (their membership payment failed; update the card), not marketing — so
// it must reach members who have opted out of promos, who are exactly the
// ones most likely to lapse quietly. The lane is a property of HOW the
// contact was enrolled, never of the sequence: an operator cannot flag a
// promo sequence "transactional", and the same sequence enrolled by hand
// stays marketing. What the lane changes: the marketing-consent gate and
// the frequency cap are skipped. What it never changes: the location
// feature gate, "must be on this location's list" (row absent = may never
// send), bounced / complained / suppressed email, wa opted_out / blocked /
// undeliverable, and — for WhatsApp — only a UTILITY-category template
// rides the lane (a MARKETING template keeps the marketing gate).
export const TRANSACTIONAL_SOURCE_TYPES = Object.freeze(['invoice_past_due', 'churn_radar'])

/** @param {{ source_type?: string|null }|null|undefined} enrollment */
export function isTransactionalEnrolment(enrollment) {
  return TRANSACTIONAL_SOURCE_TYPES.includes(String(enrollment?.source_type || ''))
}
```

`sendEmailStep`: rename the parameter back to `enrollment` (it is `_enrollment` today) and change the consent block:

```js
  const transactional = isTransactionalEnrolment(enrollment)
  const emailConsent = locationConsent(contact, sequence)
  if (!emailConsent) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'email', reason: 'not on this location’s list' })
    return null
  }
  if (!transactional && emailConsent.email_marketing !== true) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'email', reason: 'no email marketing consent for this location' })
    return null
  }
```

and the cap line becomes:

```js
  if (!transactional) assertNotFrequencyCapped(contact, frequencyCap)
```

`sendWhatsappStep`: move the template resolution (the `whatsapp_templates` select + the APPROVED / location checks) to directly after the `wa_phone` check and before the consent gate, then:

```js
  const transactional = isTransactionalEnrolment(enrollment)
    && String(template.category || '').toUpperCase() === 'UTILITY'
  const waConsent = locationConsent(contact, sequence)
  if (!waConsent) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: 'not on this location’s list' })
    return null
  }
  if (!transactional && waConsent.whatsapp_marketing !== true) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: 'no WhatsApp marketing consent for this location' })
    return null
  }
  if (['opted_out', 'blocked', 'undeliverable'].includes(contact.wa_status)) {
    await recordStepSkip(db, { contact, sequence, step, channel: 'WhatsApp', reason: `wa_status is '${contact.wa_status}'` })
    return null
  }
  if (!transactional) assertNotFrequencyCapped(contact, frequencyCap)
```

Keep every comment that explains the existing gates; add one line noting the DUNNING.3 ordering (template first so the category can decide the lane — a config fault still throws before any consent read, same as before).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/sequences/per-location-consent.test.js src/lib/sequences/frequency-cap-steps.test.js src/lib/sequences/steps.test.js src/lib/sequences/bundle-gate.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequences/steps.js src/lib/sequences/per-location-consent.test.js
git commit -m "DUNNING.3 — transactional lane: dunning enrolments skip the marketing gate, keep every hard block"
```

---

### Task 5: Manual reminder follows the category; button only on Overdue

**Files:**
- Modify: `src/app/api/churn-radar/action/route.js:205-255`
- Modify: `src/components/ChurnRadar.jsx` (`OverdueRow` ~943-990; the three render sites 872/906/938)

- [ ] **Step 1: Route** — import `isMembershipInvoice`:

```js
import { isMembershipInvoice } from '@/lib/glofox-arrears'
```

Replace the `pastDueInv` read + `pastDueIds` line:

```js
    // DUNNING.1 — "overdue" for a card-update reminder means a PAST_DUE
    // MEMBERSHIP invoice (the radar's Overdue category), not any past-due
    // row: a failed €5 fee is an unpaid charge, and the reminder copy says
    // "membership payment". Same classifier as fetchPastDue.
    const { data: pastDueInv } = await db
      .from('glofox_invoices')
      .select('id, line_item_subtypes, glofox_event:raw_payload->candidate->>glofoxEvent')
      .eq('contact_id', contactId)
      .eq('status', 'PAST_DUE')
      .limit(50)
    const hasMembershipDebt = (pastDueInv || []).some(isMembershipInvoice)
    const pastDueIds = hasMembershipDebt ? new Set([contactId]) : new Set()
```

and the enrol call gains `allowReenrol: true`:

```js
      const res = await enrolContacts({
        sequenceId: seqId,
        contactIds: [contactId],
        sourceType: 'churn_radar',
        sourceRef: `payment_${kind}`,
        // DUNNING.2 — an operator re-sending to a member who completed an
        // earlier run (outside the cooldown) re-activates it.
        allowReenrol: true,
      })
```

- [ ] **Step 2: UI** — `OverdueRow` gains a `canRemind` prop (default true) and renders the reminder button only when set:

```jsx
function OverdueRow({ m, busy, onAction, onRefresh, variant = 'owed', canRemind = true }) {
```

```jsx
        {canRemind && (
          <ActionBtn icon={CreditCard} label="Send payment reminder" disabled={isBusy} primary
            onClick={() => onAction(m.contactId, 'payment_reminder')} />
        )}
```

Render sites: Overdue (line ~872) unchanged; Unpaid charges (~906) passes `canRemind={false}`; Awaiting authorization (~938) passes `canRemind={false}`. Update the `UnpaidChargesList` comment: "no card-update reminder here — these aren't membership payments".

- [ ] **Step 3: Lint** — `npx eslint src/app/api/churn-radar/action/route.js src/components/ChurnRadar.jsx` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/churn-radar/action/route.js src/components/ChurnRadar.jsx
git commit -m "DUNNING.4 — manual payment reminder requires a past-due membership invoice; button only on Overdue"
```

---

### Task 6: Settings — expose the auto-enrol switch

**Files:**
- Modify: `src/app/api/churn-radar/dunning-settings/route.js`
- Modify: `src/components/ChurnRadar.jsx` (`DunningSettings` ~438-535)

- [ ] **Step 1: Route**

Schema:

```js
const DunningSettingsSchema = z.object({
  dunning_sequence_id: z.union([uuidLike, z.literal(''), z.null()]).optional(),
  // DUNNING.5 — start reminders automatically when a membership payment
  // fails (locations.dunning_auto_enroll, mig 428 — had no UI until now).
  dunning_auto_enroll: z.boolean().optional(),
})
```

GET: select `'dunning_sequence_id, dunning_auto_enroll'` and return `dunning_auto_enroll: !!loc?.dunning_auto_enroll`.

PUT: after validating `seqId`, compute the effective values and reject auto-enrol without a sequence:

```js
  const autoEnroll = typeof body?.dunning_auto_enroll === 'boolean' ? body.dunning_auto_enroll : undefined
  const effectiveSeqId = raw === undefined ? (currentSeqId) : seqId
```

where `currentSeqId` is read from `locations` when `raw === undefined` (so a PUT that only flips the checkbox still validates against the stored pointer):

```js
  let currentSeqId = null
  if (raw === undefined || autoEnroll === true) {
    const { data: cur } = await db.from('locations').select('dunning_sequence_id').eq('id', g.locationId).maybeSingle()
    currentSeqId = cur?.dunning_sequence_id || null
  }
  const effectiveSeqId = raw === undefined ? currentSeqId : seqId
  if (autoEnroll === true && !effectiveSeqId) {
    return NextResponse.json({ success: false, error: 'Pick a reminder sequence before turning on automatic reminders.' }, { status: 400 })
  }
  const patch = {}
  if (raw !== undefined) patch.dunning_sequence_id = seqId
  if (autoEnroll !== undefined) patch.dunning_auto_enroll = autoEnroll
  // Clearing the sequence also turns automatic reminders off — nothing could fire.
  if (raw !== undefined && seqId === null) patch.dunning_auto_enroll = false
  if (Object.keys(patch).length === 0) return NextResponse.json({ success: true, data: { dunning_sequence_id: effectiveSeqId, dunning_auto_enroll: undefined } })
  const { error } = await db.from('locations').update(patch).eq('id', g.locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { dunning_sequence_id: effectiveSeqId, dunning_auto_enroll: patch.dunning_auto_enroll ?? autoEnroll ?? null } })
```

Update the header comment: GET also returns `dunning_auto_enroll`; PUT accepts it.

- [ ] **Step 2: UI** — in `DunningSettings`: state `const [auto, setAuto] = useState(false)`; on load `setAuto(!!j.data.dunning_auto_enroll)`; `save()` sends `{ dunning_sequence_id: sel || null, dunning_auto_enroll: sel ? auto : false }`. Rename the card title to "Payment reminders" and the intro copy:

```jsx
      <p className="mt-1 text-xs text-un1t-subtle">
        The automation that reminds a member to update their card when a{' '}
        <span className="font-medium">membership payment fails</span>. Install
        "Overdue membership payment → card update reminders" from the
        automations templates (or build a manual one), pick it here, and choose
        whether it starts by itself. The one-click{' '}
        <span className="font-medium">Send payment reminder</span> on the Overdue tab
        uses the same automation.
      </p>
```

Below the select (inside the `<>` branch, before the Save row):

```jsx
          <label className={`mt-3 flex items-start gap-2 text-xs ${sel ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
            <input type="checkbox" className="mt-0.5" checked={!!sel && auto} disabled={!sel}
              onChange={(e) => setAuto(e.target.checked)} />
            <span>
              <span className="font-medium">Start reminders automatically</span> when a membership
              payment fails. Fees, class packs and custom charges never trigger it; the run stops
              the moment the membership payment is paid or written off, or the membership pauses.
            </span>
          </label>
```

Button label: "Save payment reminders". Empty-state copy: "No manual automations yet — install the card-update reminders template under Automations → Templates, then come back to pick it here."

- [ ] **Step 3: Lint** — `npx eslint src/app/api/churn-radar/dunning-settings/route.js src/components/ChurnRadar.jsx` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/churn-radar/dunning-settings/route.js src/components/ChurnRadar.jsx
git commit -m "DUNNING.5 — churn-radar settings expose automatic payment reminders (dunning_auto_enroll)"
```

---

### Task 7: Gallery template + install-time WhatsApp template resolution

**Files:**
- Modify: `src/lib/sequence-templates.js` (`overdue_payment_dunning`, ~718-770)
- Create: `src/lib/sequences/template-install.js`
- Modify: `src/app/api/sequences/from-template/route.js`
- Test: `src/lib/sequence-templates.test.js`, `src/lib/sequences/template-install.test.js` (new)

- [ ] **Step 1: Failing tests**

Append to `src/lib/sequence-templates.test.js`:

```js
describe('DUNNING.6 — overdue membership payment → card update reminders', () => {
  const tpl = getTemplate('overdue_payment_dunning')
  it('is a manual-trigger automation (the dunning picker + auto-enrol enrol directly), 14-day cooldown, daytime window', () => {
    expect(tpl.trigger_type).toBe('manual')
    expect(tpl.re_enrolment_cooldown_days).toBe(14)
    expect(tpl.send_window).toEqual({ start_hour: 9, end_hour: 19, skip_days: [] })
  })
  it('is wait → WhatsApp + email (1h) → email (day 3) → WhatsApp + email (day 7)', () => {
    expect(tpl.steps.map((s) => s.step_type)).toEqual(['wait', 'whatsapp', 'email', 'email', 'whatsapp', 'email'])
    expect(tpl.steps.map((s) => [s.delay_days ?? 0, s.delay_hours ?? 0])).toEqual([[0, 0], [0, 1], [0, 0], [3, 0], [4, 0], [0, 0]])
  })
  it('both WhatsApp steps use the approved utility template by NAME with the first name as {{1}}', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'whatsapp')) {
      expect(s.whatsapp_template_name).toBe('outstanding_payment_')
      expect(s.whatsapp_variables).toEqual({ '1': 'first_name' })
    }
  })
  it('email copy is low-key: no em-dashes, no emoji, mentions updating the card', () => {
    for (const s of tpl.steps.filter((s) => s.step_type === 'email')) {
      expect(s.subject).not.toMatch(/—/)
      expect(s.html_content).not.toMatch(/—/)
      expect(s.html_content).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
      expect(s.html_content.toLowerCase()).toMatch(/card/)
    }
  })
})
```

Create `src/lib/sequences/template-install.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { resolveWhatsappTemplateIds } from './template-install.js'

describe('resolveWhatsappTemplateIds (DUNNING.6)', () => {
  const rows = [
    { id: 'w-1', name: 'outstanding_payment_', status: 'APPROVED' },
    { id: 'w-2', name: 'promo', status: 'APPROVED' },
    { id: 'w-3', name: 'pending_one', status: 'PENDING' },
  ]
  it('resolves a whatsapp step by template name to the APPROVED row id', () => {
    const out = resolveWhatsappTemplateIds([{ step_type: 'whatsapp', whatsapp_template_name: 'outstanding_payment_' }], rows)
    expect(out[0].whatsapp_template_id).toBe('w-1')
    expect(out[0].whatsapp_template_name).toBeUndefined()
  })
  it('leaves the id null when the name is missing at this location or not APPROVED (pre-publish validation flags it)', () => {
    const out = resolveWhatsappTemplateIds([
      { step_type: 'whatsapp', whatsapp_template_name: 'nope' },
      { step_type: 'whatsapp', whatsapp_template_name: 'pending_one' },
    ], rows)
    expect(out.map((s) => s.whatsapp_template_id)).toEqual([null, null])
  })
  it('an explicit whatsapp_template_id wins; non-whatsapp steps pass through untouched', () => {
    const out = resolveWhatsappTemplateIds([
      { step_type: 'whatsapp', whatsapp_template_id: 'explicit', whatsapp_template_name: 'outstanding_payment_' },
      { step_type: 'email', subject: 'x' },
    ], rows)
    expect(out[0].whatsapp_template_id).toBe('explicit')
    expect(out[1]).toEqual({ step_type: 'email', subject: 'x' })
  })
  it('tolerates empty input', () => {
    expect(resolveWhatsappTemplateIds([], rows)).toEqual([])
    expect(resolveWhatsappTemplateIds(null, rows)).toEqual([])
    expect(resolveWhatsappTemplateIds([{ step_type: 'whatsapp', whatsapp_template_name: 'x' }], null)[0].whatsapp_template_id).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/sequence-templates.test.js src/lib/sequences/template-install.test.js` → FAIL.

- [ ] **Step 3: Implement**

`src/lib/sequences/template-install.js`:

```js
// DUNNING.6 — gallery templates can name a WhatsApp template instead of
// carrying a location-specific whatsapp_templates uuid. At install time the
// name resolves against the installing location's APPROVED templates; a miss
// leaves the id null, and the pre-publish validation ("WhatsApp needs a
// template") makes the operator pick one. Pure.

/**
 * @param {Array<object>} steps   gallery template steps
 * @param {Array<{ id:string, name:string, status?:string }>} rows  the location's whatsapp_templates
 * @returns {Array<object>} steps with whatsapp_template_id filled and the name key removed
 */
export function resolveWhatsappTemplateIds(steps, rows) {
  const byName = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.name && String(r.status || '').toUpperCase() === 'APPROVED') byName.set(r.name, r.id)
  }
  return (Array.isArray(steps) ? steps : []).map((s) => {
    if (s?.step_type !== 'whatsapp' || !('whatsapp_template_name' in (s || {}))) return s
    const { whatsapp_template_name: name, ...rest } = s
    const id = rest.whatsapp_template_id || byName.get(name) || null
    return { ...rest, whatsapp_template_id: id }
  })
}
```

`src/app/api/sequences/from-template/route.js` — import and resolve before building `stepRows`:

```js
import { resolveWhatsappTemplateIds } from '@/lib/sequences/template-install'
```

```js
  // DUNNING.6 — resolve WhatsApp steps named by template (gallery templates
  // can't carry a location's uuid) against this location's approved templates.
  let steps = tpl.steps || []
  if (steps.some((s) => s?.step_type === 'whatsapp' && s.whatsapp_template_name)) {
    const { data: waRows } = await db
      .from('whatsapp_templates')
      .select('id, name, status')
      .eq('location_id', locationId)
    steps = resolveWhatsappTemplateIds(steps, waRows || [])
  }
  const stepRows = steps.map((s, i) => ({
```

`src/lib/sequence-templates.js` — replace the `overdue_payment_dunning` entry (and its preceding comment):

```js
  // DUNNING.6 — the ready-made automation behind the churn radar's Overdue
  // tab: a member's MEMBERSHIP payment fails → WhatsApp + email asking them
  // to update their card, three touches over a week. Manual trigger: the
  // radar's auto-enrol (locations.dunning_auto_enroll) and the one-click
  // "Send payment reminder" enrol directly; fees, class packs and custom
  // charges never do. The run exits the moment the membership invoice is
  // paid / written off or the membership pauses. Enrolments from those
  // paths are TRANSACTIONAL (steps.js): they reach members who opted out of
  // marketing, and still respect every hard block. The WhatsApp copy is the
  // approved Meta template's (outstanding_payment_) and can't change without
  // re-approval; the emails are editable in /automations. The first wait
  // gives Glofox's own quick retry an hour to succeed first.
  {
    id: 'overdue_payment_dunning',
    category: 'Recovery',
    name: 'Overdue membership payment → card update reminders',
    description: 'When a membership payment fails, reminds the member to update their card: a WhatsApp and an email about an hour after the failure, an email on day 3, and a WhatsApp plus a final email on day 7. Stops as soon as the payment goes through. Install, review the copy, activate, then pick it under Churn radar → Payment reminders and turn on automatic starts. Fees and class packs never trigger it.',
    trigger_type: 'manual',
    trigger_config: {},
    goal_config: null,
    re_enrolment_cooldown_days: 14,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      { step_type: 'wait', delay_days: 0, delay_hours: 0 },
      {
        step_type: 'whatsapp',
        delay_days: 0,
        delay_hours: 1,
        whatsapp_template_name: 'outstanding_payment_',
        whatsapp_variables: { '1': 'first_name' },
      },
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'A quick heads-up about your payment, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>We tried to take your membership payment and it didn't go through. It happens, usually a card that has expired or been replaced.</p>
<p>Your membership is still active. To keep it that way, update your card in the Glofox app, or reply to this email and we'll sort it with you.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'email',
        delay_days: 3,
        delay_hours: 0,
        subject: 'Still no luck with your membership payment',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your membership payment is still outstanding. Updating your card in the Glofox app takes about a minute, and we'll take the payment from there.</p>
<p>If something else is going on, reply here and we'll figure it out together.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'whatsapp',
        delay_days: 4,
        delay_hours: 0,
        whatsapp_template_name: 'outstanding_payment_',
        whatsapp_variables: { '1': 'first_name' },
      },
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Action needed to keep your UN1T membership',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your membership payment is now a week overdue and we don't want you to lose your spot.</p>
<p>Two minutes fixes it: update your card in the Glofox app, or reply to this email and we'll take it from there. No awkwardness, we just want to keep you training.</p>
<p>UN1T {{location_name}}</p>`,
      },
    ],
  },
```

Check `src/lib/sequence-templates.test.js`'s generic invariants (every step type known, etc.) and any `step_type` allow-list the installer or graph compiler enforces for `wait` — the engaged template already uses `wait`, so it is supported.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/sequence-templates.test.js src/lib/sequences/template-install.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sequence-templates.js src/lib/sequence-templates.test.js src/lib/sequences/template-install.js src/lib/sequences/template-install.test.js src/app/api/sequences/from-template/route.js
git commit -m "DUNNING.6 — gallery template: Overdue membership payment → 3-touch WhatsApp + email card reminders; WhatsApp steps resolve by template name at install"
```

---

### Task 8: CHANGELOG, CI mirror, build, PR

- [ ] **Step 1: CHANGELOG row 571** (top of the table):

```markdown
| 571 | DUNNING.1→.6 — Overdue membership payment → automatic WhatsApp + email card-update reminders | Richard 2026-08-23: "once a member lands in Overdue, send a WhatsApp and an email to update their card." The July reactive dunning (PR #994) was dormant — `dunning_auto_enroll` had no UI, no sequence was set. Now: **trigger/exit follow the Overdue category** (`dunningActionFor` — only a `PAST_DUE` MEMBERSHIP invoice starts a run, only a settled one stops it; a paid €5 fee no longer cancels reminders); **transactional lane** (`isTransactionalEnrolment` by `source_type` ∈ `invoice_past_due`/`churn_radar` — skips the marketing-consent gate + frequency cap, keeps on-list / bounced / complained / suppressed / wa opted_out; WhatsApp only for UTILITY templates) — 28 of 190 subscription members had opted out of marketing email and would never have been reminded; **re-runs** via `enrolContacts({ allowReenrol })` re-activating the terminal row in place (full unique index untouched, ENROLDEDUP.1 stands; `planReenrolments`: outside cooldown + different invoice; `metadata.previous_runs` keeps history) — dunning callers only; **settings** card exposes the auto-enrol switch; **gallery template** rewritten as manual-trigger wait → WhatsApp (`outstanding_payment_`, approved UTILITY) + email (1h) → email (day 3) → WhatsApp + email (day 7), cooldown 14d, installer resolves WhatsApp steps by template name. Manual "Send payment reminder" needs a past-due membership invoice and shows on Overdue only. No migration. **Go-live (operator):** install the template → activate → Churn radar → Payment reminders → pick it + tick automatic → click the button on the 7 current Overdue rows. Spec `docs/superpowers/specs/2026-08-23-overdue-card-reminders-design.md`. |
```

- [ ] **Step 2: CI mirror** (sequential):

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: all exit 0 (re-run `npm test` once on a worker-timeout flake).

- [ ] **Step 3: Build** — `npm run build` → exit 0 (new import in from-template + a new lib file).

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/CHANGELOG.md
git commit -m "DUNNING.7 — CHANGELOG 571"
git push -u origin HEAD
gh pr create --base main --title "DUNNING.1→.7 — Overdue membership payment → automatic WhatsApp + email card-update reminders" --body-file - <<'EOF'
…(summary from CHANGELOG 571: what was dormant, the three fixes, the lane, re-runs, template, go-live steps)…
EOF
```

- [ ] **Step 5: Post-merge verification on prod (GET-only + operator steps)**: `GET /api/churn-radar/dunning-settings` shows `dunning_auto_enroll`; after Richard installs + activates + picks the template and ticks automatic, confirm `locations.dunning_auto_enroll = true` and that a click on one Overdue row creates a `sequence_enrollments` row with `source_type = 'churn_radar'`, then that the scheduler's next tick records the WhatsApp send in `whatsapp_messages` (template `outstanding_payment_`) and the email in `email_sends`.

---

## Self-review

- **Spec coverage:** §1 → Task 1 (+ Task 5 for the manual path); §2 → Tasks 2–3; §3 → Task 4; §4 → Task 6; §5 → Task 7; go-live → Task 8 step 5. Out-of-scope items have no task.
- **Placeholders:** none beyond the PR body prose (written from the CHANGELOG row).
- **Type consistency:** `dunningActionFor(invoiceStatus, isMembership)` (T1) consumes `ltvResult.is_membership` (T1); `enrolContacts({ allowReenrol })` (T3) is what `maybeEnrolDunning` (T1) and the action route (T5) pass; `planReenrolments(history, cooldownDays, sourceRef, nowMs)` (T2) is called with the widened history rows (T3); `isTransactionalEnrolment(enrollment)` (T4) reads `source_type`, which both dunning callers set (`invoice_past_due`, `churn_radar`); `resolveWhatsappTemplateIds(steps, rows)` (T7) consumes `whatsapp_template_name` exactly as the template (T7) writes it.
