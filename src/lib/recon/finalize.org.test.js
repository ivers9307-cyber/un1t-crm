// W0.7 — one receipt-coverage report per ORGANISATION.
//
// maybeFinalizeWeekly used to render every xero_connections location
// into ONE email (a section per location across every tenant) and send
// it to the env recipient RECEIPT_COVERAGE_REPORT_TO — tenant B's
// bank-line anomalies landed in tenant A's inbox. Now each section
// carries the connection's organisation; sections are bucketed by
// organisation and each bucket is sent through sendCoverageReportForOrg
// (→ sendOpsAlert → that org's ops_alert_emails). A platform-level
// error with no organisation (a connection whose location row is
// missing) is shown to every organisation. The 'report' recon_runs row
// and the heartbeat rule are unchanged: one row per cycle, heartbeat
// only when every per-location run was clean and no errors.
//
// Mock style matches finalize.test.js: chainable fake db whose FINAL
// method resolves, module-boundary mocks for report-email, app-url,
// cron-heartbeat, dublin-time, log.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = { from: vi.fn() }

const renderCoverageReportHtml = vi.fn(() => '<html/>')
const sendCoverageReportForOrg = vi.fn(async () => ({ channel: 'email', recipients: 1 }))
vi.mock('./report-email', () => ({
  renderCoverageReportHtml: (...args) => renderCoverageReportHtml(...args),
  sendCoverageReportForOrg: (...args) => sendCoverageReportForOrg(...args),
}))

const getAppUrl = vi.fn(() => 'https://crm.repset.ie')
vi.mock('@/lib/app-url', () => ({ getAppUrl: (...args) => getAppUrl(...args) }))

const stampHeartbeat = vi.fn(async () => {})
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: (...args) => stampHeartbeat(...args) }))

const dublinTodayStr = vi.fn(() => '2026-10-09')
vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: (...args) => dublinTodayStr(...args) }))

const logError = vi.fn()
vi.mock('@/lib/log', () => ({
  logError: (...args) => logError(...args),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}))

let finalize

function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'update', 'insert', 'upsert', 'range', 'not', 'is', 'limit', 'maybeSingle', 'single']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

const CRON_STARTED_AT = new Date(Date.now() - 3600 * 1000).toISOString()

const ORG_A = 'org-aaaa'
const ORG_B = 'org-bbbb'

function cleanRun(id) {
  return chainable({
    data: { id, status: 'ok', started_at: CRON_STARTED_AT, stats: { accounts: [{ pulled: 3, new: 1, covered: 1 }], anomalies: [] } },
    error: null,
  }, 'maybeSingle')
}
const emptyLimit = () => chainable({ data: [], error: null }, 'limit')
function uncoveredFor(description) {
  return chainable({
    data: [{ id: `line-${description}`, line_date: '2026-10-01', description, reference: 'REF', amount: -10 }],
    error: null,
  }, 'limit')
}

function queueGates() {
  const pending = chainable({ data: null, error: null }, 'maybeSingle')
  const lastCron = chainable({ data: { id: 'run-1', started_at: CRON_STARTED_AT }, error: null }, 'maybeSingle')
  const noExistingReport = chainable({ data: null, error: null }, 'maybeSingle')
  mockDb.from.mockReturnValueOnce(pending).mockReturnValueOnce(lastCron).mockReturnValueOnce(noExistingReport)
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  renderCoverageReportHtml.mockReset()
  renderCoverageReportHtml.mockReturnValue('<html/>')
  sendCoverageReportForOrg.mockReset()
  sendCoverageReportForOrg.mockResolvedValue({ channel: 'email', recipients: 1 })
  stampHeartbeat.mockReset()
  stampHeartbeat.mockResolvedValue()
  logError.mockReset()
  delete process.env.RECEIPT_COVERAGE_REPORT_TO
  finalize = await import('./finalize')
})

describe('maybeFinalizeWeekly — one report per organisation', () => {
  it('two connections in different organisations → two sends, each with only that org\'s sections, one report row, heartbeat stamped', async () => {
    queueGates()
    const connections = chainable({
      data: [
        { location_id: 'loc-a', location: { id: 'loc-a', name: 'Stillorgan', organization_id: ORG_A } },
        { location_id: 'loc-b', location: { id: 'loc-b', name: 'Tenant B Garage', organization_id: ORG_B } },
      ],
      error: null,
    }, 'select')
    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      // loc-a
      .mockReturnValueOnce(cleanRun('run-a'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(uncoveredFor('A-ONLY LINE'))
      // loc-b
      .mockReturnValueOnce(cleanRun('run-b'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(uncoveredFor('B-ONLY LINE'))
      .mockReturnValueOnce(reportInsert)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(connections.select).toHaveBeenCalledWith('location_id, location:location_id(id, name, organization_id)')

    expect(sendCoverageReportForOrg).toHaveBeenCalledTimes(2)
    expect(renderCoverageReportHtml).toHaveBeenCalledTimes(2)

    const [sendA, sendB] = sendCoverageReportForOrg.mock.calls.map((c) => c[0])
    expect(sendA).toMatchObject({ db: mockDb, organizationId: ORG_A, locationId: 'loc-a', html: '<html/>', dateStr: '2026-10-09' })
    expect(sendB).toMatchObject({ db: mockDb, organizationId: ORG_B, locationId: 'loc-b', html: '<html/>', dateStr: '2026-10-09' })

    const [renderA, renderB] = renderCoverageReportHtml.mock.calls.map((c) => c[0])
    expect(renderA.sections.map((s) => s.locationName)).toEqual(['Stillorgan'])
    expect(renderA.sections[0].uncovered.map((l) => l.description)).toEqual(['A-ONLY LINE'])
    expect(renderA.errors).toEqual([])
    expect(renderB.sections.map((s) => s.locationName)).toEqual(['Tenant B Garage'])
    expect(renderB.sections[0].uncovered.map((l) => l.description)).toEqual(['B-ONLY LINE'])
    expect(renderB.errors).toEqual([])
    // Tenant A's report never mentions tenant B's lines, and vice versa.
    expect(JSON.stringify(renderA)).not.toContain('B-ONLY')
    expect(JSON.stringify(renderB)).not.toContain('A-ONLY')

    expect(reportInsert.insert).toHaveBeenCalledTimes(1)
    expect(reportInsert.insert.mock.calls[0][0]).toMatchObject({ trigger: 'report', status: 'ok', stats: { locations: 2 } })
    expect(stampHeartbeat).toHaveBeenCalledWith('receipt-coverage-weekly')
    expect(result).toEqual({ finalized: true, sections: 2 })
  })

  it('a platform-level error with no organisation (connection whose location row is missing) is shown to EVERY organisation; heartbeat not stamped', async () => {
    queueGates()
    const connections = chainable({
      data: [
        { location_id: 'loc-a', location: { id: 'loc-a', name: 'Stillorgan', organization_id: ORG_A } },
        { location_id: 'loc-b', location: { id: 'loc-b', name: 'Tenant B Garage', organization_id: ORG_B } },
        { location_id: 'loc-orphan', location: null },
      ],
      error: null,
    }, 'select')
    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const orphanNoRun = chainable({ data: null, error: null }, 'maybeSingle')
    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(cleanRun('run-a'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(cleanRun('run-b'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(orphanNoRun)
      .mockReturnValueOnce(reportInsert)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(sendCoverageReportForOrg).toHaveBeenCalledTimes(2)
    const orgsSent = sendCoverageReportForOrg.mock.calls.map((c) => c[0].organizationId).sort()
    expect(orgsSent).toEqual([ORG_A, ORG_B])

    for (const [arg] of renderCoverageReportHtml.mock.calls) {
      expect(arg.errors).toEqual([{ locationName: 'loc-orphan', error: 'no cron run this cycle' }])
    }

    expect(reportInsert.insert).toHaveBeenCalledTimes(1)
    expect(reportInsert.insert.mock.calls[0][0]).toMatchObject({ trigger: 'report', status: 'error' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(result).toEqual({ finalized: true, sections: 2 })
  })

  it('an error that belongs to one organisation is shown only to that organisation', async () => {
    queueGates()
    const connections = chainable({
      data: [
        { location_id: 'loc-a', location: { id: 'loc-a', name: 'Stillorgan', organization_id: ORG_A } },
        { location_id: 'loc-a2', location: { id: 'loc-a2', name: 'Hatch', organization_id: ORG_A } },
        { location_id: 'loc-b', location: { id: 'loc-b', name: 'Tenant B Garage', organization_id: ORG_B } },
      ],
      error: null,
    }, 'select')
    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const hatchNoRun = chainable({ data: null, error: null }, 'maybeSingle')
    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(cleanRun('run-a'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(hatchNoRun)
      .mockReturnValueOnce(cleanRun('run-b'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(reportInsert)

    await finalize.maybeFinalizeWeekly(mockDb)

    expect(sendCoverageReportForOrg).toHaveBeenCalledTimes(2)
    const byOrg = new Map(renderCoverageReportHtml.mock.calls.map(([arg], i) => [sendCoverageReportForOrg.mock.calls[i][0].organizationId, arg]))
    expect(byOrg.get(ORG_A).errors).toEqual([{ locationName: 'Hatch', error: 'no cron run this cycle' }])
    expect(byOrg.get(ORG_B).errors).toEqual([])
  })

  it('a section whose connection has no organisation is never sent (sendCoverageReportForOrg would throw) — logged instead; other orgs still get theirs', async () => {
    queueGates()
    const connections = chainable({
      data: [
        { location_id: 'loc-a', location: { id: 'loc-a', name: 'Stillorgan', organization_id: ORG_A } },
        { location_id: 'loc-x', location: { id: 'loc-x', name: 'Unassigned', organization_id: null } },
      ],
      error: null,
    }, 'select')
    const foundHunts = chainable({ data: [], error: null }, 'gte')
    const reportInsert = chainable({ data: { id: 'report-row-1' }, error: null }, 'insert')

    mockDb.from
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(cleanRun('run-a'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(cleanRun('run-x'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(reportInsert)

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(sendCoverageReportForOrg).toHaveBeenCalledTimes(1)
    expect(sendCoverageReportForOrg.mock.calls[0][0].organizationId).toBe(ORG_A)
    expect(logError).toHaveBeenCalledWith('recon-finalize', expect.stringContaining('no organisation'), expect.objectContaining({ locations: ['Unassigned'] }))
    expect(reportInsert.insert).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ finalized: true, sections: 2 })
  })

  it('a send failure for one organisation returns email_failed and does NOT insert the report row (retried next tick)', async () => {
    queueGates()
    const connections = chainable({
      data: [
        { location_id: 'loc-a', location: { id: 'loc-a', name: 'Stillorgan', organization_id: ORG_A } },
        { location_id: 'loc-b', location: { id: 'loc-b', name: 'Tenant B Garage', organization_id: ORG_B } },
      ],
      error: null,
    }, 'select')
    const foundHunts = chainable({ data: [], error: null }, 'gte')

    mockDb.from
      .mockReturnValueOnce(connections)
      .mockReturnValueOnce(foundHunts)
      .mockReturnValueOnce(cleanRun('run-a'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(cleanRun('run-b'))
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())
      .mockReturnValueOnce(emptyLimit())

    sendCoverageReportForOrg.mockRejectedValueOnce(new Error('boom'))

    const result = await finalize.maybeFinalizeWeekly(mockDb)

    expect(result).toMatchObject({ finalized: false, reason: 'email_failed', error: 'boom' })
    // No insert registered: a stray from() call would return undefined and throw.
    expect(mockDb.from).toHaveBeenCalledTimes(13)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
