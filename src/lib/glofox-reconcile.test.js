import { describe, it, expect } from 'vitest'
import { indexReportByInvoice, reconcileOpenPastDue } from './glofox-arrears'
import { runArrearsReconcile } from './glofox-reconcile'

// GLOFOX-RECONCILE.1 — the churn radar reads glofox_invoices.status='PAST_DUE',
// a table fed by INVOICE_UPDATED webhooks that CREATE late-cancel / no-show fee
// rows as PAST_DUE. When a fee is later forgiven / cancelled / written off in
// Glofox, no webhook flips the local copy, so the row goes stale and the radar
// shows a member owing money they don't. The Glofox TransactionsList report is
// the source of truth; these helpers reconcile local PAST_DUE rows against it.
//
// Verified against live Glofox 2026-06-28: forgiven fees carry is_forgiven, and
// fees that were waived/cancelled are simply ABSENT from the report.

// A report detail row — the typed envelope shape ({ StripeCharge: { ... } }).
const txn = (over) => ({ StripeCharge: { invoice_id: 'inv', metadata: {}, ...over } })

describe('indexReportByInvoice (GLOFOX-RECONCILE.1)', () => {
  it('classifies each invoice_id as settled / forgiven / open from its transactions', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'A', paid: true }),
      txn({ invoice_id: 'B', status: 'failed', paid: false, metadata: { is_forgiven: true } }),
      txn({ invoice_id: 'C', status: 'failed', paid: false }),
    ])
    expect(idx.get('A')).toMatchObject({ settled: true })
    expect(idx.get('B')).toMatchObject({ forgiven: true })
    expect(idx.get('C')).toMatchObject({ settled: false, forgiven: false })
    // an invoice with no transactions is simply absent from the index
    expect(idx.has('Z')).toBe(false)
  })

  it('marks an invoice settled if ANY of its transactions settled (fail-then-pay retry under one id)', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'D', status: 'failed', paid: false }),
      txn({ invoice_id: 'D', paid: true }),
    ])
    expect(idx.get('D')).toMatchObject({ settled: true })
  })
})

describe('reconcileOpenPastDue (GLOFOX-RECONCILE.1)', () => {
  const NOW = Date.parse('2026-06-28T12:00:00Z')

  it('clears settled / forgiven, keeps genuinely-unpaid, and clears only AGED absences', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'paid1', paid: true }),
      txn({ invoice_id: 'forg1', status: 'failed', metadata: { is_forgiven: true } }),
      txn({ invoice_id: 'open1', status: 'failed', paid: false }),
    ])
    const rows = [
      { id: 'paid1', invoice_date: '2026-06-01' },
      { id: 'forg1', invoice_date: '2026-06-01' },
      { id: 'open1', invoice_date: '2026-06-01' },
      { id: 'absentOld', invoice_date: '2026-05-14' }, // ~45d → clear
      { id: 'absentNew', invoice_date: '2026-06-27' }, // ~1d → too new, keep
    ]
    const out = reconcileOpenPastDue(rows, idx, NOW, { absentAgeDays: 2 })
    const byId = Object.fromEntries(out.map((d) => [d.id, d]))

    expect(byId.paid1).toMatchObject({ action: 'clear', newStatus: 'PAID', reason: 'settled' })
    expect(byId.forg1).toMatchObject({ action: 'clear', newStatus: 'FORGIVEN', reason: 'forgiven' })
    expect(byId.open1).toMatchObject({ action: 'keep' })
    expect(byId.absentOld).toMatchObject({ action: 'clear', newStatus: 'CANCELLED', reason: 'absent_aged' })
    expect(byId.absentNew).toMatchObject({ action: 'keep' })
  })

  it('never clears an absent row whose invoice_date is missing/unparseable (cannot judge age)', () => {
    const out = reconcileOpenPastDue([{ id: 'x', invoice_date: null }], new Map(), NOW)
    expect(out[0]).toMatchObject({ action: 'keep' })
  })

  it('defaults the absent-age buffer when not supplied (a day-old absence is kept)', () => {
    const out = reconcileOpenPastDue([{ id: 'x', invoice_date: '2026-06-27T12:00:00Z' }], new Map(), NOW)
    expect(out[0].action).toBe('keep')
  })
})

// ── runArrearsReconcile — orchestration (GLOFOX-RECONCILE.1) ──────────────
// Fetches the open PAST_DUE rows + the Glofox report, applies the pure
// decisions, and (on commit) clears the stale rows. The report fetch is
// injected (reportFetcher) so the test stays offline.

function makeReconcileDb(pastDueRows) {
  const updates = []
  function builder() {
    const state = { isUpdate: false, payload: null, inIds: null, rangeFrom: null }
    const b = {
      select() { return b },
      eq() { return b },
      in(_col, vals) { state.inIds = vals; return b },
      order() { return b },
      range(from) { state.rangeFrom = from; return b },
      update(payload) { state.isUpdate = true; state.payload = payload; return b },
      then(resolve) {
        if (state.isUpdate) {
          updates.push({ ids: state.inIds, payload: state.payload })
          return Promise.resolve({ data: (state.inIds || []).map((id) => ({ id })), error: null }).then(resolve)
        }
        // First page returns the rows; subsequent pages are empty (stops paging).
        const rows = state.rangeFrom === 0 ? pastDueRows : []
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      },
    }
    return b
  }
  return { db: { from: () => builder() }, updates }
}

describe('runArrearsReconcile — orchestration (GLOFOX-RECONCILE.1)', () => {
  const NOW = Date.parse('2026-06-28T12:00:00Z')
  const creds = { branchId: 'b', apiKey: 'k', apiToken: 't', namespace: 'ns' }
  const rtxn = (over) => ({ StripeCharge: { invoice_id: 'inv', metadata: {}, ...over } })

  const pastDue = [
    { id: 'paid1', invoice_date: '2026-06-01', amount_cents: 1000 },
    { id: 'forg1', invoice_date: '2026-06-01', amount_cents: 3500 },
    { id: 'open1', invoice_date: '2026-06-01', amount_cents: 5000 },
    { id: 'absentOld', invoice_date: '2026-05-14', amount_cents: 500 },
    { id: 'absentNew', invoice_date: '2026-06-27', amount_cents: 500 },
  ]
  const report = {
    ok: true, status: 200,
    body: { TransactionsList: { details: [
      rtxn({ invoice_id: 'paid1', paid: true }),
      rtxn({ invoice_id: 'forg1', status: 'failed', metadata: { is_forgiven: true } }),
      rtxn({ invoice_id: 'open1', status: 'failed', paid: false }),
    ] } },
  }
  const reportFetcher = async () => report

  it('dry run: classifies but writes nothing', async () => {
    const { db, updates } = makeReconcileDb(pastDue)
    const res = await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, reportFetcher })
    expect(res.dryRun).toBe(true)
    expect(res.scanned).toBe(5)
    expect(res.cleared).toBe(3) // paid1 + forg1 + absentOld
    expect(res.kept).toBe(2) // open1 + absentNew
    expect(res.byReason).toMatchObject({ settled: 1, forgiven: 1, absent_aged: 1 })
    expect(updates).toHaveLength(0)
  })

  it('commit: clears the stale rows with the right status + reconciled_reason, keeps real debt', async () => {
    const { db, updates } = makeReconcileDb(pastDue)
    const res = await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, reportFetcher, commit: true })
    expect(res.dryRun).toBe(false)
    expect(res.cleared).toBe(3)
    const written = new Map()
    for (const u of updates) for (const id of u.ids) written.set(id, u.payload)
    expect(written.get('paid1')).toMatchObject({ status: 'PAID', reconciled_reason: 'settled' })
    expect(written.get('forg1')).toMatchObject({ status: 'FORGIVEN', reconciled_reason: 'forgiven' })
    expect(written.get('absentOld')).toMatchObject({ status: 'CANCELLED', reconciled_reason: 'absent_aged' })
    expect(written.has('open1')).toBe(false) // genuinely unpaid — left flagged
    expect(written.has('absentNew')).toBe(false) // too new to clear
    for (const u of updates) expect(u.payload.reconciled_at).toBeTruthy()
  })

  it('no open PAST_DUE rows → never fetches the report, writes nothing', async () => {
    const { db, updates } = makeReconcileDb([])
    let fetched = 0
    const res = await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, commit: true, reportFetcher: async () => { fetched++; return report } })
    expect(res.scanned).toBe(0)
    expect(res.cleared).toBe(0)
    expect(fetched).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('throws when the Glofox report fetch fails (so the cron records the per-location error)', async () => {
    const { db } = makeReconcileDb(pastDue)
    await expect(
      runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => ({ ok: false, status: 502 }) }),
    ).rejects.toThrow(/report/i)
  })
})
