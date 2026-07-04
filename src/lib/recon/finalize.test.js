// RCOV.P1 — maybeFinalizeWeekly test coverage.
//
// The weekly cycle's last step, ticked by process-receipt-hunts every
// 5 min. Gate order:
//   1. any pending hunt (hunt_queued_at not null anywhere) → bail,
//      hunts_pending (queue not drained yet).
//   2. no cron run (trigger='cron') within the last 48h → bail,
//      no_recent_cron (nothing to finalize against).
//   3. a report row (trigger='report') newer than that cron run
//      already exists → bail, already_reported (idempotent).
//   4. otherwise compile sections per xero_connections location from
//      live state (that location's own latest cron run + hunts +
//      submitted/needs_attention/uncovered lines), render v2, email,
//      audit a 'report' recon_runs row, and stamp the weekly heartbeat
//      ONLY when every per-location cron run used was clean (status
//      'ok', zero anomalies) AND the errors list is empty — a
//      degraded cycle still emails but leaves the heartbeat stale so
//      sentinel notices (Phase 0's strict-health rule, preserved).
//
// Mock style matches statuses.test.js/pull.test.js: a chainable mock
// whose FINAL method resolves; intermediate steps return `this`. `db`
// is a parameter (no @/lib/supabase mock needed). report-email,
// app-url, cron-heartbeat and dublin-time are mocked at the module
// boundary since finalize.js orchestrates them, not their internals.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = { from: vi.fn() }

const renderCoverageReportHtml = vi.fn(() => '<html/>')
const sendCoverageReport = vi.fn(async () => ({ ok: true }))
vi.mock('./report-email', () => ({
  renderCoverageReportHtml: (...args) => renderCoverageReportHtml(...args),
  sendCoverageReport: (...args) => sendCoverageReport(...args),
}))

const getAppUrl = vi.fn(() => 'https://crm.un1tdublin.com')
vi.mock('@/lib/app-url', () => ({ getAppUrl: (...args) => getAppUrl(...args) }))

const stampHeartbeat = vi.fn(async () => {})
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: (...args) => stampHeartbeat(...args) }))

const dublinTodayStr = vi.fn(() => '2026-07-04')
vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: (...args) => dublinTodayStr(...args) }))

let finalize

// Chain whose FINAL method resolves; intermediate steps return this
// (house pattern — cf. coverage.test.js/pull.test.js/statuses.test.js).
function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'update', 'insert', 'upsert', 'range', 'not', 'is', 'limit', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  renderCoverageReportHtml.mockReset()
  renderCoverageReportHtml.mockReturnValue('<html/>')
  sendCoverageReport.mockReset()
  sendCoverageReport.mockResolvedValue({ ok: true })
  getAppUrl.mockReset()
  getAppUrl.mockReturnValue('https://crm.un1tdublin.com')
  stampHeartbeat.mockReset()
  stampHeartbeat.mockResolvedValue()
  dublinTodayStr.mockReset()
  dublinTodayStr.mockReturnValue('2026-07-04')
  finalize = await import('./finalize')
})

const CRON_STARTED_AT = '2026-07-03T08:00:00.000Z' // within the last 48h of "now"

describe('maybeFinalizeWeekly — gates', () => {
  it('bails hunts_pending when any line still has hunt_queued_at set, before any other query', async () => {
    const pending = chainable({ data: { id: 'line-1' }, error: null }, 'maybeSingle')
    mockDb.from.mockReturnValueOnce(pending)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toEqual({ finalized: false, reason: 'hunts_pending' })
    expect(mockDb.from).toHaveBeenCalledTimes(1)
    expect(mockDb.from).toHaveBeenCalledWith('recon_bank_lines')
    expect(sendCoverageReport).not.toHaveBeenCalled()
  })

  it('bails no_recent_cron when there is no cron run at all', async () => {
    const pending = chainable({ data: null, error: null }, 'maybeSingle')
    const lastCron = chainable({ data: null, error: null }, 'maybeSingle')
    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(lastCron)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toEqual({ finalized: false, reason: 'no_recent_cron' })
    expect(mockDb.from).toHaveBeenCalledTimes(2)
  })

  it('bails no_recent_cron when the latest cron run is older than 48h', async () => {
    const pending = chainable({ data: null, error: null }, 'maybeSingle')
    const staleCron = chainable(
      { data: { id: 'run-old', started_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString() }, error: null },
      'maybeSingle'
    )
    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(staleCron)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toEqual({ finalized: false, reason: 'no_recent_cron' })
  })

  it('bails already_reported when a report row newer than the cron run exists', async () => {
    const pending = chainable({ data: null, error: null }, 'maybeSingle')
    const lastCron = chainable({ data: { id: 'run-1', started_at: CRON_STARTED_AT }, error: null }, 'maybeSingle')
    const existingReport = chainable({ data: { id: 'report-1' }, error: null }, 'maybeSingle')
    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(lastCron)
      .mockReturnValueOnce(existingReport)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toEqual({ finalized: false, reason: 'already_reported' })
    expect(mockDb.from).toHaveBeenCalledTimes(3)
    expect(sendCoverageReport).not.toHaveBeenCalled()
  })
})

describe('maybeFinalizeWeekly — compile + send', () => {
  function setUpThroughGates() {
    const pending = chainable({ data: null, error: null }, 'maybeSingle')
    const lastCron = chainable({ data: { id: 'run-1', started_at: CRON_STARTED_AT }, error: null }, 'maybeSingle')
    const noExistingReport = chainable({ data: null, error: null }, 'maybeSingle')
    return { pending, lastCron, noExistingReport }
  }

  it('happy path: clean cron run, one connection, one of each section → emails once, inserts a report row, stamps the heartbeat', async () => {
    const { pending, lastCron, noExistingReport } = setUpThroughGates()

    const connections = chainable({
      data: [{ location_id: 'loc-1', location: { id: 'loc-1', name: 'Stillorgan' } }],
      error: null,
    }, 'select')

    const locationCronRun = chainable({
      data: {
        id: 'run-loc-1',
        status: 'ok',
        started_at: CRON_STARTED_AT,
        stats: {
          accounts: [{ pulled: 5, new: 2, covered: 1 }],
          anomalies: [],
        },
      },
      error: null,
    }, 'maybeSingle')

    const foundHunts = chainable({
      data: [{
        id: 'hunt-1',
        finished_at: '2026-07-03T09:00:00.000Z',
        evidence: { verdict: { supplier_name: 'Musclefood' }, deduped: false },
        submitted_queue_id: 'q-1',
        bank_line_id: 'line-1',
        line: { location_id: 'loc-1', line_date: '2026-07-01', description: 'MUSCLEFOOD LTD', amount: -84.5 },
      }],
      error: null,
    }, 'gte')

    const inReviewLines = chainable({
      data: [{ id: 'line-2', invoices_queue_id: 'q-2', line_date: '2026-07-02', description: 'ESB ELECTRIC', amount: -120 }],
      error: null,
    }, 'limit')
    const inReviewQueueStatuses = chainable({ data: [{ id: 'q-2', status: 'quality_approved' }], error: null }, 'in')

    const needsAttentionLines = chainable({
      data: [{ id: 'line-3', invoices_queue_id: 'q-3', line_date: '2026-06-30', description: 'OFFICE SUPPLIES', amount: -45 }],
      error: null,
    }, 'limit')
    const needsAttentionQueueStatuses = chainable({ data: [{ id: 'q-3', reject_reason: 'blurry' }], error: null }, 'in')

    const uncoveredLines = chainable({
      data: [{ id: 'line-4', line_date: '2026-06-20', description: 'STILL MISSING LTD', reference: 'CARD 999', amount: -10 }],
      error: null,
    }, 'limit')

    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(lastCron)
      .mockReturnValueOnce(noExistingReport)
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(locationCronRun)
      .mockReturnValueOnce(inReviewLines)
      .mockReturnValueOnce(inReviewQueueStatuses)
      .mockReturnValueOnce(needsAttentionLines)
      .mockReturnValueOnce(needsAttentionQueueStatuses)
      .mockReturnValueOnce(uncoveredLines)
      .mockReturnValueOnce(reportInsert)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(sendCoverageReport).toHaveBeenCalledTimes(1)
    expect(renderCoverageReportHtml).toHaveBeenCalledTimes(1)
    const renderArg = renderCoverageReportHtml.mock.calls[0][0]
    expect(renderArg.appUrl).toBe('https://crm.un1tdublin.com')
    expect(renderArg.dateStr).toBe('2026-07-04')
    expect(renderArg.sections).toHaveLength(1)
    expect(renderArg.sections[0].locationName).toBe('Stillorgan')
    expect(renderArg.sections[0].found).toEqual([
      { line_date: '2026-07-01', description: 'MUSCLEFOOD LTD', amount: -84.5, supplier_name: 'Musclefood', deduped: false },
    ])
    expect(renderArg.sections[0].inReview).toEqual([
      { line_date: '2026-07-02', description: 'ESB ELECTRIC', amount: -120, queue_status: 'quality_approved' },
    ])
    expect(renderArg.sections[0].needsAttention).toEqual([
      { line_date: '2026-06-30', description: 'OFFICE SUPPLIES', amount: -45, reject_reason: 'blurry' },
    ])
    expect(renderArg.sections[0].uncovered).toEqual([
      { line_date: '2026-06-20', description: 'STILL MISSING LTD', reference: 'CARD 999', amount: -10 },
    ])

    expect(reportInsert.insert).toHaveBeenCalledTimes(1)
    const insertPayload = reportInsert.insert.mock.calls[0][0]
    expect(insertPayload.trigger).toBe('report')
    expect(insertPayload.status).toBe('ok')

    expect(stampHeartbeat).toHaveBeenCalledWith('receipt-coverage-weekly')
    expect(result).toEqual({ finalized: true, sections: 1 })
  })

  it('degraded cycle (a location cron run has anomalies/status error) still emails and inserts the report row, but does NOT stamp the heartbeat', async () => {
    const { pending, lastCron, noExistingReport } = setUpThroughGates()

    const connections = chainable({
      data: [{ location_id: 'loc-1', location: { id: 'loc-1', name: 'Stillorgan' } }],
      error: null,
    }, 'select')

    const locationCronRun = chainable({
      data: {
        id: 'run-loc-1',
        status: 'error',
        started_at: CRON_STARTED_AT,
        stats: {
          accounts: [{ pulled: 5, new: 2, covered: 1 }],
          anomalies: [{ bankAccountName: 'Current', skipped: 'zero_rows_anomaly' }],
        },
      },
      error: null,
    }, 'maybeSingle')

    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const inReviewLines = chainable({ data: [], error: null }, 'limit')
    const needsAttentionLines = chainable({ data: [], error: null }, 'limit')
    const uncoveredLines = chainable({ data: [], error: null }, 'limit')
    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(lastCron)
      .mockReturnValueOnce(noExistingReport)
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(locationCronRun)
      .mockReturnValueOnce(inReviewLines)
      .mockReturnValueOnce(needsAttentionLines)
      .mockReturnValueOnce(uncoveredLines)
      .mockReturnValueOnce(reportInsert)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(sendCoverageReport).toHaveBeenCalledTimes(1)
    expect(reportInsert.insert).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(result).toEqual({ finalized: true, sections: 1 })
  })

  it('email failure returns email_failed and does NOT insert a report row (retried next tick)', async () => {
    const { pending, lastCron, noExistingReport } = setUpThroughGates()

    const connections = chainable({
      data: [{ location_id: 'loc-1', location: { id: 'loc-1', name: 'Stillorgan' } }],
      error: null,
    }, 'select')

    const locationCronRun = chainable({
      data: { id: 'run-loc-1', status: 'ok', started_at: CRON_STARTED_AT, stats: { accounts: [], anomalies: [] } },
      error: null,
    }, 'maybeSingle')

    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const inReviewLines = chainable({ data: [], error: null }, 'limit')
    const needsAttentionLines = chainable({ data: [], error: null }, 'limit')
    const uncoveredLines = chainable({ data: [], error: null }, 'limit')

    mockDb.from
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(lastCron)
      .mockReturnValueOnce(noExistingReport)
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(locationCronRun)
      .mockReturnValueOnce(inReviewLines)
      .mockReturnValueOnce(needsAttentionLines)
      .mockReturnValueOnce(uncoveredLines)

    sendCoverageReport.mockRejectedValueOnce(new Error('Postmark 500'))

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toMatchObject({ finalized: false, reason: 'email_failed' })
    // No further from() calls beyond the ones already queued above — the
    // insert mock was never registered, so a stray 13th call would grab
    // `undefined` and throw on .insert(), failing the test loudly.
    expect(mockDb.from).toHaveBeenCalledTimes(9)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
