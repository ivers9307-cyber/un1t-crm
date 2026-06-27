// Coverage for POST /api/admin/backfill-session-calories — master-gated bounded
// backfill of calories_kcal for already-ended ble_bridge sessions.
// Mirrors the harness pattern used by admin/studio-devices/activity/route.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/body-metrics', () => ({ resolveBodyMetrics: vi.fn() }))
vi.mock('@/lib/calories', () => ({ estimateCaloriesKcal: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { resolveBodyMetrics } = await import('@/lib/body-metrics')
const { estimateCaloriesKcal } = await import('@/lib/calories')
const { POST } = await import('./route.js')

// Build a fake NextRequest URL for the route.
function makeReq(params = {}) {
  const qs = new URLSearchParams(params).toString()
  return new Request(`http://localhost/api/admin/backfill-session-calories${qs ? `?${qs}` : ''}`)
}

// Minimal chainable Supabase query builder whose terminal `then` resolves
// with `{ data, error }`.  Chain methods that differ per call-site can be
// distinguished by the `from` table name.
function makeDb({ sessions = [], updateError = null } = {}) {
  const updateBuilder = {
    eq: function () { return this },
    then: (resolve) => Promise.resolve({ error: updateError }).then(resolve),
  }

  return {
    _calls: [],
    from(table) {
      this._calls.push(table)
      // select chain (for the query)
      const selectBuilder = {
        select: function () { return this },
        eq: function () { return this },
        not: function () { return this },
        gte: function () { return this },
        order: function () { return this },
        limit: function () { return this },
        then: (resolve) =>
          Promise.resolve({ data: sessions, error: null }).then(resolve),
      }
      if (table === 'heart_rate_sessions' && this._calls.filter((t) => t === table).length === 1) {
        return selectBuilder
      }
      // update chain (subsequent calls to the same table)
      return {
        update: () => updateBuilder,
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/admin/backfill-session-calories', () => {
  it('401s when there is no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(makeReq({ location_id: 'loc-1' }))
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403s a non-master user', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, profileRole: 'manager' })
    const res = await POST(makeReq({ location_id: 'loc-1' }))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Master only')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('400s when location_id is missing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true })
    const res = await POST(makeReq())
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('location_id required')
  })

  it('fills a session with full metrics and skips one without', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true })

    const sessions = [
      // Should be filled — has contact_id + avg_hr_bpm, resolveBodyMetrics returns metrics
      {
        id: 'sess-1',
        contact_id: 'c-1',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T11:00:00Z',
        avg_hr_bpm: 145,
        calories_kcal: null,
      },
      // Should be skipped — no contact_id
      {
        id: 'sess-2',
        contact_id: null,
        started_at: '2026-06-01T12:00:00Z',
        ended_at: '2026-06-01T13:00:00Z',
        avg_hr_bpm: 130,
        calories_kcal: null,
      },
    ]

    // Track update calls to verify sess-1 was written, sess-2 was not.
    const updatedIds = []
    const db = {
      from(table) {
        if (table === 'heart_rate_sessions') {
          let isUpdate = false
          let updateId = null
          const builder = {
            select: function () { return this },
            eq: function (col, val) {
              if (isUpdate && col === 'id') updateId = val
              return this
            },
            not: function () { return this },
            gte: function () { return this },
            order: function () { return this },
            limit: function () { return this },
            update: function () {
              isUpdate = true
              return this
            },
            then: (resolve) => {
              if (isUpdate) {
                updatedIds.push(updateId)
                return Promise.resolve({ error: null }).then(resolve)
              }
              return Promise.resolve({ data: sessions, error: null }).then(resolve)
            },
          }
          return builder
        }
        return { select: function () { return this }, then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve) }
      },
    }

    createServerClient.mockReturnValue(db)
    resolveBodyMetrics.mockResolvedValue({ age: 30, weightKg: 80, gender: 'male' })
    estimateCaloriesKcal.mockReturnValue(600)

    const res = await POST(makeReq({ location_id: 'loc-1', since: '2026-06-01' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.scanned).toBe(2)
    expect(json.data.filled).toBe(1)
    expect(json.data.skipped).toBe(1)

    // Verify resolveBodyMetrics was only called for the fillable session
    expect(resolveBodyMetrics).toHaveBeenCalledTimes(1)
    expect(resolveBodyMetrics).toHaveBeenCalledWith(db, 'c-1', expect.any(Number))

    // estimateCaloriesKcal called with correct shape
    expect(estimateCaloriesKcal).toHaveBeenCalledWith({
      avgHr: 145,
      durationMin: 60,
      age: 30,
      weightKg: 80,
      gender: 'male',
    })
  })

  it('skips a session when estimateCaloriesKcal returns null (insufficient metrics)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true })

    const sessions = [
      {
        id: 'sess-3',
        contact_id: 'c-2',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T11:00:00Z',
        avg_hr_bpm: 145,
        calories_kcal: null,
      },
    ]

    createServerClient.mockReturnValue(makeDb({ sessions }))
    resolveBodyMetrics.mockResolvedValue({ age: null, weightKg: null, gender: null })
    estimateCaloriesKcal.mockReturnValue(null)

    const res = await POST(makeReq({ location_id: 'loc-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.filled).toBe(0)
    expect(json.data.skipped).toBe(1)
  })
})
