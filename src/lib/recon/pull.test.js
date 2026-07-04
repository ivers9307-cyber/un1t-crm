// RCOV.P0 — pull orchestrator test coverage.
//
// runCoveragePull does five things per location, in order:
//   1. claim the run — sweep stale 'running' rows (>15 min, presumed
//      crashed), then insert a new recon_runs row. A 23505 unique
//      violation (recon_runs_one_running_per_location_idx) means
//      another run already holds the claim — surface a clean message,
//      never touch recon_runs after (there's no run id to update).
//   2. compute the pull window — oldest non-terminal tracked line, else
//      90 days back from Dublin-today.
//   3. list ACTIVE bank accounts, fetch each one's statement lines
//      via the Finance API BankStatementsPlus endpoint (upgrade
//      2026-07-04 — true statement lines, incl. unactioned feed lines
//      that /BankTransactions can't see; one call per account, no
//      pagination on this endpoint).
//   4. GUARD — an account with tracked non-terminal lines can never
//      legitimately fetch zero statement lines for a window enclosing
//      those lines (reconciled ones are still returned; isReconciled
//      filters client-side to preserve exactly this tripwire). Zero
//      rows there means fetch/shape drift, not a quiet bank account.
//      Skip the sync for that account, record the anomaly, and the run
//      finishes 'error' (not thrown — other accounts still get synced).
//   5. audit the run: finished_at/status/stats always get written, even
//      on a thrown failure mid-pull — and the error audit keeps the
//      per-account progress made before the throw (accounts synced so
//      far + failedAfter) so a partial pull is diagnosable (best-effort
//      — never let a bookkeeping failure mask the original error).
//
// Line identity is delegated to statement-lines.js (stable
// statementLineId keys — see statement-lines.test.js); this file
// locks the fetch/guard/sync orchestration only.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same counts every prior fixture had: 3 lines, 1 reconciled, 2
// unreconciled money-out — so every count assertion below carries over.
const btPage = {
  statements: [
    {
      statementLines: [
        { statementLineId: 'bt-a', type: 'DEBIT', isReconciled: false, isDeleted: false, postedDate: '2026-06-03', amount: 84.5, payee: 'MUSCLEFOOD LTD', reference: 'CARD 1234' },
        { statementLineId: 'bt-b', type: 'DEBIT', isReconciled: true, isDeleted: false, postedDate: '2026-06-05', amount: 230, payee: 'ELECTRIC IRELAND', reference: 'DD 8871' },
        { statementLineId: 'bt-c', type: 'DEBIT', isReconciled: false, isDeleted: false, postedDate: '2026-06-10', amount: 12, payee: 'COFFEE SUPPLIES' },
      ],
    },
  ],
}
const btEmpty = { statements: [] }

// No @/lib/supabase mock needed: pull takes `db` as a parameter, and the
// only transitive supabase importer in its graph (@/lib/xero/client) is
// fully mocked below — the real supabase module never loads.
const mockDb = { from: vi.fn() }

const xfetch = vi.fn()
const withFreshToken = vi.fn(async () => ({ conn: { tenant_id: 't-1' }, xfetch }))
vi.mock('@/lib/xero/client', () => ({
  withFreshToken: (...args) => withFreshToken(...args),
  XeroError: class XeroError extends Error {},
}))

const syncBankLines = vi.fn(async () => ({ pulled: 2, new: 1, covered: 0 }))
vi.mock('./coverage', () => ({ syncBankLines: (...args) => syncBankLines(...args) }))

vi.mock('@/lib/dublin-time', () => ({
  dublinTodayStr: () => '2026-07-04',
  addDaysISO: (d, days) => {
    const t = new Date(d + 'T00:00:00Z')
    t.setUTCDate(t.getUTCDate() + days)
    return t.toISOString().slice(0, 10)
  },
}))

let pull

// Chain whose FINAL method resolves; intermediate steps return this
// (house pattern — cf. coverage.test.js).
function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'update', 'insert', 'upsert', 'limit', 'maybeSingle', 'single', 'lt']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  xfetch.mockReset()
  withFreshToken.mockReset()
  withFreshToken.mockImplementation(async () => ({ conn: { tenant_id: 't-1' }, xfetch }))
  syncBankLines.mockReset()
  syncBankLines.mockImplementation(async () => ({ pulled: 2, new: 1, covered: 0 }))
  pull = await import('./pull')
})

// btPage maps to 3 rows, of which 2 are unreconciled (bt-a, bt-c) —
// mirrors bank-transactions.test.js's mapper contract.
const FIXTURE_UNRECONCILED_COUNT = 2

describe('runCoveragePull', () => {
  it('claims the run, pulls the default 90d window, and syncs each ACTIVE account', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const oldestLine = chainable({ data: null, error: null }, 'maybeSingle')
    const finalUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)       // 1. sweep stale running rows
      .mockReturnValueOnce(claim)       // 2. insert claim
      .mockReturnValueOnce(oldestLine)  // 3. oldest non-terminal line lookup
      .mockReturnValueOnce(finalUpdate) // 4. final recon_runs update

    xfetch
      .mockResolvedValueOnce({
        Accounts: [
          { AccountID: 'acct-1', Name: 'Current', Status: 'ACTIVE' },
          { AccountID: 'acct-2', Name: 'Old Savings', Status: 'ARCHIVED' },
        ],
      })
      .mockResolvedValueOnce(btPage)

    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' })

    expect(xfetch).toHaveBeenCalledTimes(2)
    const [stmtUrl] = xfetch.mock.calls[1]
    // Absolute Finance API URL (own base path — not api.xro/2.0);
    // SummaryOnly=false is required or statementLines is omitted.
    expect(stmtUrl).toContain('https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements?')
    expect(stmtUrl).toContain('BankAccountID=acct-1')
    expect(stmtUrl).toContain('FromDate=2026-04-05')
    expect(stmtUrl).toContain('ToDate=2026-07-04')
    expect(stmtUrl).toContain('SummaryOnly=false')

    expect(syncBankLines).toHaveBeenCalledTimes(1)
    const syncArg = syncBankLines.mock.calls[0][1]
    expect(syncArg.lines).toHaveLength(FIXTURE_UNRECONCILED_COUNT)
    // Stable Xero identity — no hash/ordinal machinery on this source.
    expect(syncArg.lines.map((l) => l.key)).toEqual(['sl:bt-a', 'sl:bt-c'])
    expect(syncArg.bankAccountId).toBe('acct-1')
    expect(syncArg.windowFrom).toBe('2026-04-05')
    expect(syncArg.windowTo).toBe('2026-07-04')

    expect(summary.accounts).toEqual([
      { bankAccountId: 'acct-1', bankAccountName: 'Current', pulled: 2, new: 1, covered: 0 },
    ])
    expect(summary.anomalies).toEqual([])
    expect(summary.forced).toBe(false) // no acceptMassCover → audited un-forced

    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }))
    expect(finalUpdate.eq).toHaveBeenCalledWith('id', 'run-1')
  })

  it('flags the zero-rows anomaly, skips the sync, and finishes the run as error', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const oldestLine = chainable({ data: null, error: null }, 'maybeSingle')
    const hasTracked = chainable({ data: { id: 'x' }, error: null }, 'maybeSingle')
    const finalUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(oldestLine)
      .mockReturnValueOnce(hasTracked)   // hasTrackedLines check for the anomalous account
      .mockReturnValueOnce(finalUpdate)

    xfetch
      .mockResolvedValueOnce({ Accounts: [{ AccountID: 'acct-1', Name: 'Current', Status: 'ACTIVE' }] })
      .mockResolvedValueOnce(btEmpty) // zero transactions fetched

    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' })

    expect(syncBankLines).not.toHaveBeenCalled()
    expect(summary.anomalies).toEqual([
      { bankAccountId: 'acct-1', bankAccountName: 'Current', skipped: 'zero_rows_anomaly' },
    ])
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.stringContaining('zero-rows anomaly'),
    }))
  })

  it('treats a genuinely dormant account (no tracked lines) as a harmless no-op sync, not an anomaly', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const oldestLine = chainable({ data: null, error: null }, 'maybeSingle')
    const hasTracked = chainable({ data: null, error: null }, 'maybeSingle')
    const finalUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(oldestLine)
      .mockReturnValueOnce(hasTracked)
      .mockReturnValueOnce(finalUpdate)

    xfetch
      .mockResolvedValueOnce({ Accounts: [{ AccountID: 'acct-1', Name: 'Current', Status: 'ACTIVE' }] })
      .mockResolvedValueOnce(btEmpty)

    // acceptMassCover piggybacked onto this call: the dormant-account
    // behaviour under test is unaffected (the breaker lives inside the
    // mocked syncBankLines), and it pins the force pass-through + the
    // forced:true audit (false-by-default is pinned in the happy path).
    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual', acceptMassCover: true })

    expect(syncBankLines).toHaveBeenCalledTimes(1)
    expect(syncBankLines.mock.calls[0][1].lines).toEqual([])
    expect(syncBankLines.mock.calls[0][1].acceptMassCover).toBe(true)
    expect(summary.anomalies).toEqual([])
    expect(summary.forced).toBe(true)
    expect(finalUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }))
  })

  it('surfaces a claim conflict cleanly and never touches Xero or recon_runs again', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable(
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      'single'
    )
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)

    const attempt = pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'cron' })
    await expect(attempt).rejects.toThrow('already running')
    // The machine contract the refresh route's 409 mapping branches on —
    // pinned on the error OBJECT, not the prose.
    await expect(attempt).rejects.toMatchObject({ code: 'recon_pull_running' })

    expect(withFreshToken).not.toHaveBeenCalled()
    expect(mockDb.from).toHaveBeenCalledTimes(2) // sweep + claim only — no run id to audit
  })

  it('audits an early failure (nothing pulled yet) as error with empty progress, then rethrows', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const failUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(failUpdate) // the catch-block error audit

    withFreshToken.mockImplementation(async () => { throw new Error('Xero token expired') })

    await expect(pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' }))
      .rejects.toThrow('Xero token expired')

    expect(failUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.stringContaining('Xero token expired'),
      stats: expect.objectContaining({ accounts: [], anomalies: [], failedAfter: 0 }),
    }))
    expect(failUpdate.eq).toHaveBeenCalledWith('id', 'run-1')
  })

  it('preserves per-account progress in the error audit when the failure throws mid-loop', async () => {
    // Two ACTIVE accounts; the first syncs fine, the second's sync
    // throws. The catch-block audit must carry the first account's
    // stats + failedAfter so the partial pull is diagnosable from
    // recon_runs alone.
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const oldestLine = chainable({ data: null, error: null }, 'maybeSingle')
    const failUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(oldestLine)
      .mockReturnValueOnce(failUpdate) // the catch-block error audit

    xfetch
      .mockResolvedValueOnce({
        Accounts: [
          { AccountID: 'acct-1', Name: 'Current', Status: 'ACTIVE' },
          { AccountID: 'acct-2', Name: 'Reserve', Status: 'ACTIVE' },
        ],
      })
      .mockResolvedValueOnce(btPage) // acct-1 transactions — sync fine
      .mockResolvedValueOnce(btPage) // acct-2 transactions — its sync throws below
    syncBankLines
      .mockResolvedValueOnce({ pulled: 2, new: 1, covered: 0 })
      .mockRejectedValueOnce(new Error('recon insert failed: boom'))

    await expect(pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' }))
      .rejects.toThrow('recon insert failed: boom')

    expect(failUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: expect.stringContaining('recon insert failed: boom'),
      stats: expect.objectContaining({
        failedAfter: 1,
        accounts: [
          { bankAccountId: 'acct-1', bankAccountName: 'Current', pulled: 2, new: 1, covered: 0 },
        ],
        anomalies: [],
      }),
    }))
    expect(failUpdate.eq).toHaveBeenCalledWith('id', 'run-1')
  })

  it('syncs the healthy account and flags the anomalous one in the same run (mixed accounts)', async () => {
    const sweep = chainable({ data: null, error: null }, 'lt')
    const claim = chainable({ data: { id: 'run-1' }, error: null }, 'single')
    const oldestLine = chainable({ data: null, error: null }, 'maybeSingle')
    const hasTracked = chainable({ data: { id: 'x' }, error: null }, 'maybeSingle')
    const finalUpdate = chainable({ data: null, error: null }, 'eq')
    mockDb.from
      .mockReturnValueOnce(sweep)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(oldestLine)
      .mockReturnValueOnce(hasTracked)  // only the zero-rows account reaches hasTrackedLines
      .mockReturnValueOnce(finalUpdate)

    xfetch
      .mockResolvedValueOnce({
        Accounts: [
          { AccountID: 'acct-1', Name: 'Current', Status: 'ACTIVE' },
          { AccountID: 'acct-2', Name: 'Reserve', Status: 'ACTIVE' },
        ],
      })
      .mockResolvedValueOnce(btPage)  // acct-1 — healthy, syncs normally
      .mockResolvedValueOnce(btEmpty) // acct-2 — zero rows + tracked lines = anomaly

    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'cron' })

    expect(syncBankLines).toHaveBeenCalledTimes(1)
    expect(syncBankLines.mock.calls[0][1].bankAccountId).toBe('acct-1')
    expect(summary.accounts).toEqual([
      { bankAccountId: 'acct-1', bankAccountName: 'Current', pulled: 2, new: 1, covered: 0 },
    ])
    expect(summary.anomalies).toEqual([
      { bankAccountId: 'acct-2', bankAccountName: 'Reserve', skipped: 'zero_rows_anomaly' },
    ])
    // The good account's stats must persist in the audit row even though
    // the run finishes 'error' for the anomalous one.
    const updatePayload = finalUpdate.update.mock.calls[0][0]
    expect(updatePayload.status).toBe('error')
    expect(updatePayload.error).toMatch(/zero-rows anomaly/)
    expect(updatePayload.stats.accounts).toEqual(summary.accounts)
  })
})
