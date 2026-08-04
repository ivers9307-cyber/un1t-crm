// Route test for the prune-hr-detections cron (H1c).
//
// Focus: the destructive path must be BOUNDED and GUARDED —
//   - CRON_SECRET gate (401 without the Bearer header, and no DB touch),
//   - visits pruned before detections (cascade ordering),
//   - every DELETE re-asserts the age filter (.lt on the age column) alongside
//     the .in(id) list, so a wrong id list can never touch a recent row,
//   - the per-table delete cap stops the run cleanly (cap_reached reported),
//   - success stamps the prune-hr-detections heartbeat.
//
// Mirrors the recorded-query-builder pattern of
// auto-end-stale-hr-sessions/route.test.js: every builder method records its
// name+args and awaiting resolves canned rows — no real DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HR_DETECTIONS_PRUNE_BATCH,
} from '@/lib/hr-detections-retention'

let builders = []
// Rows each SELECT batch resolves, consumed in order, per table.
let selectBatches = { hr_detection_visits: [], hr_detections: [] }

function makeBuilder(table) {
  const calls = []
  const builder = {
    table,
    calls,
    then(resolve) {
      const isSelect = calls.some((c) => c.method === 'select')
      const isDelete = calls.some((c) => c.method === 'delete')
      if (isSelect && !isDelete) {
        const rows = selectBatches[table]?.shift() || []
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      }
      if (isDelete) {
        const inCall = calls.find((c) => c.method === 'in')
        const count = inCall ? inCall.args[1].length : 0
        return Promise.resolve({ data: null, error: null, count }).then(resolve)
      }
      return Promise.resolve({ data: [], error: null }).then(resolve)
    },
  }
  for (const method of ['select', 'delete', 'lt', 'order', 'range', 'in']) {
    builder[method] = vi.fn((...args) => { calls.push({ method, args }); return builder })
  }
  return builder
}

const fakeDb = {
  from: vi.fn((table) => {
    const b = makeBuilder(table)
    builders.push(b)
    return b
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { GET } from './route.js'

const SECRET = 'test-cron-secret'

function req(auth = `Bearer ${SECRET}`) {
  return new Request('http://test.local/api/cron/prune-hr-detections', {
    headers: auth ? { authorization: auth } : {},
  })
}

const ids = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }))

beforeEach(() => {
  vi.clearAllMocks()
  builders = []
  selectBatches = { hr_detection_visits: [], hr_detections: [] }
  process.env.CRON_SECRET = SECRET
})

describe('prune-hr-detections cron', () => {
  it('401s without the CRON_SECRET bearer and never touches the DB', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(fakeDb.from).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('prunes visits then detections, re-asserting the age filter on every DELETE', async () => {
    selectBatches.hr_detection_visits = [ids(3, 'v')]
    selectBatches.hr_detections = [ids(2, 'd')]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.visits_deleted).toBe(3)
    expect(body.data.detections_deleted).toBe(2)
    expect(body.data.cap_reached).toBe(false)
    expect(body.data.retention_days).toBe(30)

    // Table order: visits before detections (cascade ordering).
    const tablesTouched = builders.map((b) => b.table)
    expect(tablesTouched.indexOf('hr_detection_visits')).toBeLessThan(tablesTouched.indexOf('hr_detections'))

    // Every DELETE carries BOTH the id list and the re-asserted age filter,
    // on the right age column per table.
    const deletes = builders.filter((b) => b.calls.some((c) => c.method === 'delete'))
    expect(deletes.length).toBe(2)
    for (const d of deletes) {
      const ageCol = d.table === 'hr_detection_visits' ? 'last_sample_at' : 'last_seen_at'
      const lt = d.calls.find((c) => c.method === 'lt')
      expect(lt.args[0]).toBe(ageCol)
      // The cutoff is ~30 days ago — assert it's a historic ISO timestamp.
      expect(new Date(lt.args[1]).getTime()).toBeLessThan(Date.now() - 29 * 24 * 60 * 60 * 1000)
      expect(d.calls.some((c) => c.method === 'in' && c.args[0] === 'id')).toBe(true)
    }

    expect(stampHeartbeat).toHaveBeenCalledWith('prune-hr-detections', expect.objectContaining({
      visits_deleted: 3,
      detections_deleted: 2,
    }))
  })

  it('selects use the same age columns, oldest first, in bounded batches', async () => {
    selectBatches.hr_detection_visits = [ids(1, 'v')]
    selectBatches.hr_detections = [ids(1, 'd')]

    await GET(req())

    const selects = builders.filter((b) =>
      b.calls.some((c) => c.method === 'select') && !b.calls.some((c) => c.method === 'delete'))
    expect(selects.length).toBe(2)
    for (const s of selects) {
      const ageCol = s.table === 'hr_detection_visits' ? 'last_sample_at' : 'last_seen_at'
      expect(s.calls.find((c) => c.method === 'lt').args[0]).toBe(ageCol)
      expect(s.calls.find((c) => c.method === 'order').args[0]).toBe(ageCol)
      expect(s.calls.find((c) => c.method === 'range').args).toEqual([0, HR_DETECTIONS_PRUNE_BATCH - 1])
    }
  })

  it('stops at the per-table cap and reports cap_reached', async () => {
    // 10 full batches = exactly the 5000 cap, plus an 11th the cap must refuse.
    selectBatches.hr_detection_visits = Array.from({ length: 11 }, (_, i) =>
      ids(HR_DETECTIONS_PRUNE_BATCH, `v${i}`))
    selectBatches.hr_detections = [[]]

    const res = await GET(req())
    const body = await res.json()
    expect(body.data.visits_deleted).toBe(5000)
    expect(body.data.cap_reached).toBe(true)
    // Detections phase still ran after the visits cap.
    expect(builders.some((b) => b.table === 'hr_detections')).toBe(true)
    // Heartbeat still stamps — a capped run is a SUCCESSFUL bounded run.
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('an empty backlog deletes nothing and still stamps the heartbeat (idempotent)', async () => {
    selectBatches.hr_detection_visits = [[]]
    selectBatches.hr_detections = [[]]

    const res = await GET(req())
    const body = await res.json()
    expect(body.data.visits_deleted).toBe(0)
    expect(body.data.detections_deleted).toBe(0)
    // No DELETE builder was ever constructed.
    expect(builders.some((b) => b.calls.some((c) => c.method === 'delete'))).toBe(false)
    expect(stampHeartbeat).toHaveBeenCalled()
  })
})
