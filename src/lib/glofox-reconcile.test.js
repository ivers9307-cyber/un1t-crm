import { describe, it, expect } from 'vitest'
import { indexReportByInvoice, reconcileOpenPastDue, isCountedOwedRow } from './glofox-arrears'
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

  it('flags an invoice pending when a transaction is in-progress / awaiting authorization (AWAITING-AUTH.2)', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'P', transaction_status: 'PENDING' }),
      txn({ invoice_id: 'F', transaction_status: 'ERROR', paid: false }),           // failed, not pending
      txn({ invoice_id: 'S', transaction_status: 'SUBSCRIPTION_CYCLE_PAYMENT_FAILED' }), // failed sub, not pending
    ])
    expect(idx.get('P')).toMatchObject({ pending: true, failed: false, settled: false, forgiven: false })
    expect(idx.get('F')).toMatchObject({ pending: false, failed: true })
    expect(idx.get('S')).toMatchObject({ pending: false, failed: true })
  })
  it('ARREARS-TYPE.2 — flags PENDING_INTENT / "pending authorization" (what Glofox actually sends for Awaiting authorization) as pending', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'PI', transaction_status: 'PENDING_INTENT', status: 'pending authorization', paid: false }),
      txn({ invoice_id: 'PS', status: 'pending authorization', paid: false }), // status alone
    ])
    expect(idx.get('PI')).toMatchObject({ pending: true, failed: false, settled: false, forgiven: false })
    expect(idx.get('PS')).toMatchObject({ pending: true, failed: false })
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

  // OWED-PENDING.1 — a PENDING fee isn't charged yet, so it's expected to be
  // absent from the transactions ledger; absence must NOT clear it.
  it('keeps a PENDING fee that is absent from the report regardless of age', () => {
    const out = reconcileOpenPastDue(
      [{ id: 'p1', status: 'PENDING', invoice_date: '2026-05-01' }], // 58d old + absent
      new Map(), NOW, { absentAgeDays: 2 },
    )
    expect(out[0]).toMatchObject({ action: 'keep', reason: 'pending_open' })
  })

  it('still clears a PENDING fee the report shows settled / forgiven', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'pp', paid: true }),
      txn({ invoice_id: 'pf', metadata: { is_forgiven: true } }),
    ])
    const out = reconcileOpenPastDue([
      { id: 'pp', status: 'PENDING', invoice_date: '2026-06-01' },
      { id: 'pf', status: 'PENDING', invoice_date: '2026-06-01' },
    ], idx, NOW)
    const byId = Object.fromEntries(out.map((d) => [d.id, d]))
    expect(byId.pp).toMatchObject({ action: 'clear', newStatus: 'PAID', reason: 'settled' })
    expect(byId.pf).toMatchObject({ action: 'clear', newStatus: 'FORGIVEN', reason: 'forgiven' })
  })

  // AWAITING-AUTH.2 — a PAST_DUE row the report shows as an in-progress (PENDING)
  // payment is awaiting authorization, not a failed debt: re-status it to PENDING.
  it('re-statuses a PAST_DUE row the report shows as an in-progress (PENDING) payment', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'await1', transaction_status: 'PENDING' }),
      txn({ invoice_id: 'fail1', transaction_status: 'ERROR', paid: false }),
    ])
    const out = reconcileOpenPastDue([
      { id: 'await1', status: 'PAST_DUE', invoice_date: '2026-05-08' },
      { id: 'fail1', status: 'PAST_DUE', invoice_date: '2026-05-08' },
    ], idx, NOW)
    const byId = Object.fromEntries(out.map((d) => [d.id, d]))
    expect(byId.await1).toMatchObject({ action: 'restatus', newStatus: 'PENDING', reason: 'awaiting_authorization' })
    expect(byId.fail1).toMatchObject({ action: 'keep', reason: 'report_unpaid' }) // genuinely failed → stays a debt
  })

  it('ARREARS-TYPE.2 — re-statuses a backfilled PAST_DUE row the report shows as PENDING_INTENT (the €467 custom-charge case)', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'cc467', transaction_status: 'PENDING_INTENT', status: 'pending authorization', paid: false, amount: 467 }),
    ])
    const out = reconcileOpenPastDue([{ id: 'cc467', status: 'PAST_DUE', invoice_date: '2026-01-27' }], idx, NOW)
    expect(out[0]).toMatchObject({ id: 'cc467', action: 'restatus', newStatus: 'PENDING', reason: 'awaiting_authorization' })
  })

  it('does not re-status a row that is already PENDING (only PAST_DUE flips)', () => {
    const idx = indexReportByInvoice([txn({ invoice_id: 'p', transaction_status: 'PENDING' })])
    const out = reconcileOpenPastDue([{ id: 'p', status: 'PENDING', invoice_date: '2026-06-01' }], idx, NOW)
    expect(out[0].action).toBe('keep')
  })

  it('keeps a PAST_DUE debt when the report shows a failed attempt alongside a pending one (AWAITING-AUTH.2)', () => {
    // subscription dunning reuses one invoice_id: a pending + a failed attempt →
    // still a real debt; awaiting-auth must not mask it.
    const idx = indexReportByInvoice([
      txn({ invoice_id: 'mix', transaction_status: 'PENDING' }),
      txn({ invoice_id: 'mix', transaction_status: 'SUBSCRIPTION_CYCLE_PAYMENT_FAILED' }),
    ])
    expect(idx.get('mix')).toMatchObject({ pending: true, failed: true })
    const out = reconcileOpenPastDue([{ id: 'mix', status: 'PAST_DUE', invoice_date: '2026-06-01' }], idx, NOW)
    expect(out[0]).toMatchObject({ action: 'keep', reason: 'report_unpaid' })
  })

  it('prioritises settled over a stray pending flag (a paid-then-pending invoice is cleared PAID, not re-statused)', () => {
    const idx = indexReportByInvoice([
      txn({ invoice_id: 's', transaction_status: 'PENDING' }),
      txn({ invoice_id: 's', paid: true }),
    ])
    const out = reconcileOpenPastDue([{ id: 's', status: 'PAST_DUE', invoice_date: '2026-06-01' }], idx, NOW)
    expect(out[0]).toMatchObject({ action: 'clear', newStatus: 'PAID', reason: 'settled' })
  })
})

describe('isCountedOwedRow (OWED-PENDING.1)', () => {
  it('counts every PAST_DUE row', () => {
    expect(isCountedOwedRow({ status: 'PAST_DUE' })).toBe(true)
    expect(isCountedOwedRow({ status: 'PAST_DUE', line_item_subtypes: null })).toBe(true)
  })
  it('counts PENDING only when it is a custom-charge fee', () => {
    expect(isCountedOwedRow({ status: 'PENDING', line_item_subtypes: 'CUSTOM_CHARGE' })).toBe(true)
    expect(isCountedOwedRow({ status: 'PENDING', line_item_subtypes: 'SUBSCRIPTION_PAYMENT,UPFRONT_PAYMENT' })).toBe(false)
    expect(isCountedOwedRow({ status: 'PENDING', line_item_subtypes: null })).toBe(false)
  })
  it('never counts PAID / CANCELLED / other statuses', () => {
    expect(isCountedOwedRow({ status: 'PAID', line_item_subtypes: 'CUSTOM_CHARGE' })).toBe(false)
    expect(isCountedOwedRow({ status: 'CANCELLED' })).toBe(false)
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
    { id: 'paid1', status: 'PAST_DUE', invoice_date: '2026-06-01', amount_cents: 1000 },
    { id: 'forg1', status: 'PAST_DUE', invoice_date: '2026-06-01', amount_cents: 3500 },
    { id: 'open1', status: 'PAST_DUE', invoice_date: '2026-06-01', amount_cents: 5000 },
    { id: 'absentOld', status: 'PAST_DUE', invoice_date: '2026-05-14', amount_cents: 500 },
    { id: 'absentNew', status: 'PAST_DUE', invoice_date: '2026-06-27', amount_cents: 500 },
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

  // AWAITING-AUTH.2 — the PAST_DUE→PENDING re-status is gated: proposed in a
  // dry-run and surfaced on every run, but only WRITTEN when allowRestatus is set.
  it('proposes re-status in a dry-run and does NOT write it on a plain commit (gated)', async () => {
    const rows = [{ id: 'await1', status: 'PAST_DUE', invoice_date: '2026-05-08', amount_cents: 2500 }]
    const rep = { ok: true, status: 200, body: { TransactionsList: { details: [rtxn({ invoice_id: 'await1', transaction_status: 'PENDING' })] } } }

    const { db: db1 } = makeReconcileDb(rows)
    const dry = await runArrearsReconcile(db1, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => rep })
    expect(dry.dryRun).toBe(true)
    expect(dry.restated).toBe(1)
    expect(dry.cleared).toBe(0)
    expect(dry.byReason).toMatchObject({ awaiting_authorization: 1 })

    const { db: db2, updates: u2 } = makeReconcileDb(rows)
    const res2 = await runArrearsReconcile(db2, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => rep, commit: true })
    expect(res2.restated).toBe(1)          // still surfaced
    expect(res2.restatusApplied).toBe(false)
    expect(u2).toHaveLength(0)             // but not written
  })

  it('commits the PAST_DUE→PENDING re-status when allowRestatus is set', async () => {
    const rows = [{ id: 'await1', status: 'PAST_DUE', invoice_date: '2026-05-08', amount_cents: 2500 }]
    const rep = { ok: true, status: 200, body: { TransactionsList: { details: [rtxn({ invoice_id: 'await1', transaction_status: 'PENDING' })] } } }
    const { db, updates } = makeReconcileDb(rows)
    const res = await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, reportFetcher: async () => rep, commit: true, allowRestatus: true })
    expect(res.restatusApplied).toBe(true)
    const written = new Map()
    for (const u of updates) for (const id of u.ids) written.set(id, u.payload)
    expect(written.get('await1')).toMatchObject({ status: 'PENDING', reconciled_reason: 'awaiting_authorization' })
    expect(written.get('await1').reconciled_at).toBeTruthy()
  })

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

  it('OWED-PENDING.1 — scans PENDING custom-charge fees (kept when absent), drops pending subscriptions', async () => {
    const rows = [
      { id: 'pd', status: 'PAST_DUE', invoice_date: '2026-05-14', amount_cents: 1000 }, // absent+old → clear
      { id: 'pendFee', status: 'PENDING', line_item_subtypes: 'CUSTOM_CHARGE', invoice_date: '2026-05-01', amount_cents: 1000 }, // absent → kept
      { id: 'pendSub', status: 'PENDING', line_item_subtypes: 'SUBSCRIPTION_PAYMENT', invoice_date: '2026-05-01', amount_cents: 20900 }, // not owed → not scanned
    ]
    const { db, updates } = makeReconcileDb(rows)
    const res = await runArrearsReconcile(db, creds, 'loc-1', { nowMs: NOW, commit: true, reportFetcher: async () => ({ ok: true, status: 200, body: { TransactionsList: { details: [] } } }) })
    expect(res.scanned).toBe(2) // pd + pendFee; pendSub filtered out
    expect(res.cleared).toBe(1) // only the aged-absent PAST_DUE
    const written = new Map()
    for (const u of updates) for (const id of u.ids) written.set(id, u.payload)
    expect(written.get('pd')).toMatchObject({ status: 'CANCELLED', reconciled_reason: 'absent_aged' })
    expect(written.has('pendFee')).toBe(false) // pending fee kept, not cleared
    expect(written.has('pendSub')).toBe(false)
  })
})
