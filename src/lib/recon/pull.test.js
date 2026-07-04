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
//   3. list ACTIVE bank accounts, fetch each one's Bank Statement report
//      for the window.
//   4. GUARD — an account with tracked non-terminal lines can never
//      legitimately parse to zero report rows (the report includes
//      reconciled lines too); zero rows there means shape drift, not a
//      quiet bank account. Skip the sync for that account, record the
//      anomaly, and the run finishes 'error' (not thrown — other
//      accounts still get synced).
//   5. audit the run: finished_at/status/stats always get written, even
//      on a thrown failure mid-pull (best-effort — never let a
//      bookkeeping failure mask the original error).
//
// Locked here: the ordinal contract is delegated to bank-statement.js
// (assignOrdinals over the FULL parsed report, filtered after) — this
// file locks that pull.js calls them in that order, not the ordinal math
// itself (see bank-statement.test.js for that).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fixture from './__fixtures__/bank-statement-report.json'

const mockDb = { from: vi.fn() }
vi.mock('@/lib/supabase', () => ({ createServerClient: () => mockDb }))

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

// The fixture parses to 3 transaction rows (Opening/Closing Balance
// skipped): two unreconciled MUSCLEFOOD LTD lines (ordinals 0, 1) and
// one reconciled ELECTRIC IRELAND line. So assignOrdinals+filter yields
// 2 unreconciled rows — verified against bank-statement.test.js, which
// asserts fixture parses to length 3 with rows[1].reconciled === true.
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
      .mockResolvedValueOnce(fixture)

    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' })

    expect(xfetch).toHaveBeenCalledTimes(2)
    const [reportUrl] = xfetch.mock.calls[1]
    expect(reportUrl).toContain('/Reports/BankStatement?bankAccountID=acct-1&fromDate=2026-04-05&toDate=2026-07-04')

    expect(syncBankLines).toHaveBeenCalledTimes(1)
    const syncArg = syncBankLines.mock.calls[0][1]
    expect(syncArg.lines).toHaveLength(FIXTURE_UNRECONCILED_COUNT)
    for (const line of syncArg.lines) {
      expect(line.key).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(syncArg.bankAccountId).toBe('acct-1')
    expect(syncArg.windowFrom).toBe('2026-04-05')
    expect(syncArg.windowTo).toBe('2026-07-04')

    expect(summary.accounts).toEqual([
      { bankAccountId: 'acct-1', bankAccountName: 'Current', pulled: 2, new: 1, covered: 0 },
    ])
    expect(summary.anomalies).toEqual([])

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
      .mockResolvedValueOnce({ Reports: [] }) // parses to zero rows

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
      .mockResolvedValueOnce({ Reports: [] })

    const summary = await pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'manual' })

    expect(syncBankLines).toHaveBeenCalledTimes(1)
    expect(syncBankLines.mock.calls[0][1].lines).toEqual([])
    expect(summary.anomalies).toEqual([])
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

    await expect(pull.runCoveragePull(mockDb, 'loc-1', { trigger: 'cron' }))
      .rejects.toThrow('already running')

    expect(withFreshToken).not.toHaveBeenCalled()
    expect(mockDb.from).toHaveBeenCalledTimes(2) // sweep + claim only — no run id to audit
  })

  it('audits a mid-pull failure to recon_runs as error, then rethrows the original error', async () => {
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
    }))
    expect(failUpdate.eq).toHaveBeenCalledWith('id', 'run-1')
  })
})
