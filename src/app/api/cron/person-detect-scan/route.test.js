// Route test for the person-detect-scan cron (PERSON-ACCT.10).
//
// Why this cron exists: PR1/PR2 taught the agent to read across a whole
// person_group and elect one account for writes, but that only helps once
// duplicate contacts are actually GROUPED. Grouping used to happen only
// when a human ran the detection scan by hand — this cron runs
// runDetection(db, { commit: true }) (the HIGH-CONFIDENCE auto-link path
// runDetection already implements) once daily for every active location,
// so a new ClassPass shadow account joins its person group within a day
// with no operator action.
//
// This test does NOT re-verify runDetection's matching rules (that's
// src/lib/person-detect.test.js) — it only verifies the cron shell:
//   - CRON_SECRET gate (401 without the Bearer header, and no DB touch)
//   - iterates every ACTIVE location, calling runDetection with commit:true
//   - one location's runDetection throwing does not abort the loop — the
//     remaining locations still run and the response reports the failure
//   - heartbeat stamped on a clean run (zero location failures)
//   - heartbeat WITHHELD when ANY location failed, not just when every
//     location failed — matching the wallet-overage-draws precedent
//     (`if (stats.failed === 0) await stampHeartbeat(...)`): a run that
//     silently dropped one location's linking should not read as healthy.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let locationsTable = []
let locationsError = null

const fakeDb = {
  from: vi.fn((table) => {
    if (table !== 'locations') {
      throw new Error(`unexpected table in test fake: ${table}`)
    }
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      then(resolve, reject) {
        return Promise.resolve({ data: locationsTable, error: locationsError }).then(resolve, reject)
      },
    }
    return builder
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))

const runDetectionMock = vi.fn()
vi.mock('@/lib/person-detect', () => ({ runDetection: (...args) => runDetectionMock(...args) }))

import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { GET } from './route.js'

const SECRET = 'test-cron-secret'

function req(auth = `Bearer ${SECRET}`) {
  return new Request('http://test.local/api/cron/person-detect-scan', {
    headers: auth ? { authorization: auth } : {},
  })
}

const LOC = (id, name) => ({ id, name })

const detectionResult = (over = {}) => ({
  dryRun: false,
  counts: { high: 1, medium: 0, low: 0 },
  autoLinked: 1,
  skipped: 0,
  failures: 0,
  totalCandidates: 1,
  superseded: 0,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  locationsTable = []
  locationsError = null
  process.env.CRON_SECRET = SECRET
  runDetectionMock.mockReset()
})

describe('GET /api/cron/person-detect-scan', () => {
  it('401s without the CRON_SECRET bearer and never touches the DB', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(fakeDb.from).not.toHaveBeenCalled()
    expect(runDetectionMock).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s with no authorization header at all', async () => {
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it('calls runDetection with commit:true for every active location', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan'), LOC('loc-2', 'Hatch Street')]
    runDetectionMock.mockResolvedValue(detectionResult())

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    expect(runDetectionMock).toHaveBeenCalledTimes(2)
    expect(runDetectionMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ locationId: 'loc-1', commit: true, actorId: null })
    )
    expect(runDetectionMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ locationId: 'loc-2', commit: true, actorId: null })
    )

    // locations query is scoped to active=true
    expect(fakeDb.from).toHaveBeenCalledWith('locations')
  })

  it('reports per-location high/medium/low counts and auto-linked totals', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan')]
    runDetectionMock.mockResolvedValue(
      detectionResult({ counts: { high: 3, medium: 2, low: 1 }, autoLinked: 3, skipped: 1 })
    )

    const body = await (await GET(req())).json()
    expect(body.data.perLocation).toEqual([
      expect.objectContaining({
        location_id: 'loc-1',
        location_name: 'Stillorgan',
        counts: { high: 3, medium: 2, low: 1 },
        autoLinked: 3,
        skipped: 1,
      }),
    ])
    expect(body.data.failed).toBe(0)
  })

  it('one location throwing does not abort the loop — the others still run and the failure is reported', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan'), LOC('loc-2', 'Hatch Street'), LOC('loc-3', 'Cork')]
    runDetectionMock
      .mockResolvedValueOnce(detectionResult())
      .mockRejectedValueOnce(new Error('boom: person_link_suggestions upsert failed'))
      .mockResolvedValueOnce(detectionResult())

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    // All three locations were attempted despite the middle one throwing.
    expect(runDetectionMock).toHaveBeenCalledTimes(3)
    expect(body.success).toBe(true)
    expect(body.data.failed).toBe(1)
    expect(body.data.locations).toBe(3)

    const failedEntry = body.data.perLocation.find((l) => l.location_id === 'loc-2')
    expect(failedEntry).toMatchObject({ location_id: 'loc-2', error: expect.stringContaining('boom') })

    // The other two locations still report their normal outcome.
    expect(body.data.perLocation.find((l) => l.location_id === 'loc-1')).toMatchObject({ autoLinked: 1 })
    expect(body.data.perLocation.find((l) => l.location_id === 'loc-3')).toMatchObject({ autoLinked: 1 })

    expect(logError).toHaveBeenCalledWith(
      'cron.person-detect-scan',
      expect.any(String),
      expect.objectContaining({ locationId: 'loc-2' })
    )
  })

  it('stamps the heartbeat on a clean run (zero location failures)', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan')]
    runDetectionMock.mockResolvedValue(detectionResult())

    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith(
      'person-detect-scan',
      expect.objectContaining({ locations: 1, failed: 0 })
    )
  })

  it('WITHHOLDS the heartbeat when at least one location failed (not just when every location failed)', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan'), LOC('loc-2', 'Hatch Street')]
    runDetectionMock
      .mockResolvedValueOnce(detectionResult())
      .mockRejectedValueOnce(new Error('boom'))

    const body = await (await GET(req())).json()
    expect(body.data.failed).toBe(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('WITHHOLDS the heartbeat when every location failed', async () => {
    locationsTable = [LOC('loc-1', 'Stillorgan')]
    runDetectionMock.mockRejectedValue(new Error('total failure'))

    const body = await (await GET(req())).json()
    expect(body.data.failed).toBe(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('surfaces a locations-lookup error as a 500 without ever calling runDetection', async () => {
    locationsError = { message: 'connection reset' }

    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(runDetectionMock).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('no active locations → clean no-op run, heartbeat stamped', async () => {
    locationsTable = []
    const res = await GET(req())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { locations: 0, failed: 0 } })
    expect(runDetectionMock).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('person-detect-scan', expect.objectContaining({ locations: 0 }))
  })
})
