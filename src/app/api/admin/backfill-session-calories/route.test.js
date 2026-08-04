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

// Minimal chainable Supabase query builder. The select fan-out is paginated
// via selectAll, which calls the builder with (from, to) and AWAITS .range():
// the chain therefore terminates on .range() resolving { data, error }. We
// return the whole `sessions` array on the first page (< 1000 rows) so selectAll
// stops after one page. The update path terminates on .eq() resolving { error }.
function makeDb({ sessions = [], updateError = null } = {}) {
  const updateBuilder = {
    eq: function () { return this },
    then: (resolve) => Promise.resolve({ error: updateError }).then(resolve),
  }

  return {
    _calls: [],
    from(table) {
      this._calls.push(table)
      // select chain (for the paginated query) — resolves on .range()
      const selectBuilder = {
        select: function () { return this },
        eq: function () { return this },
        not: function () { return this },
        gte: function () { return this },
        order: function () { return this },
        range: (from) => Promise.resolve({ data: from === 0 ? sessions : [], error: null }),
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
      // Should be filled — has contact_id + avg_hr_bpm + stored zones_seconds,
      // resolveBodyMetrics returns metrics. Duration comes from the
      // zones_seconds sum (3000s = 50min), NOT ended_at − started_at (60min).
      {
        id: 'sess-1',
        contact_id: 'c-1',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T11:00:00Z',
        avg_hr_bpm: 145,
        calories_kcal: null,
        zones_seconds: { 1: 600, 2: 900, 3: 1500, 4: 0, 5: 0 },
      },
      // Should be skipped — no contact_id
      {
        id: 'sess-2',
        contact_id: null,
        started_at: '2026-06-01T12:00:00Z',
        ended_at: '2026-06-01T13:00:00Z',
        avg_hr_bpm: 130,
        calories_kcal: null,
        zones_seconds: { 1: 3600, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
    ]

    // Track update calls to verify sess-1 was written, sess-2 was not. The
    // select path is paginated (selectAll → .range), so it terminates on
    // .range(); the update path terminates on .eq('id', ...).
    const updatedIds = []
    const db = {
      from(table) {
        if (table === 'heart_rate_sessions') {
          let isUpdate = false
          const builder = {
            select: function () { return this },
            not: function () { return this },
            gte: function () { return this },
            order: function () { return this },
            // select terminator: first page returns the rows, later pages empty.
            range: (from) => Promise.resolve({ data: from === 0 ? sessions : [], error: null }),
            update: function () { isUpdate = true; return this },
            // update terminator: .eq('id', val) is the last call in the update chain.
            eq: function (col, val) {
              if (isUpdate && col === 'id') {
                updatedIds.push(val)
                return Promise.resolve({ error: null })
              }
              return this
            },
          }
          return builder
        }
        return { select: function () { return this }, range: () => Promise.resolve({ data: [], error: null }) }
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

    // Only the fillable session was written back.
    expect(updatedIds).toEqual(['sess-1'])

    // Verify resolveBodyMetrics was only called for the fillable session
    expect(resolveBodyMetrics).toHaveBeenCalledTimes(1)
    expect(resolveBodyMetrics).toHaveBeenCalledWith(db, 'c-1', expect.any(Number))

    // estimateCaloriesKcal called with correct shape — durationMin is the
    // SAMPLED duration (zones_seconds sum / 60), not the 60min wall clock.
    expect(estimateCaloriesKcal).toHaveBeenCalledWith({
      avgHr: 145,
      durationMin: 50,
      age: 30,
      weightKg: 80,
      gender: 'male',
    })
  })

  // C1 remainder — the backfill must not re-mint the 4h-auto-close ghost kcal
  // the endSession fix removed: duration comes from the gap-capped sampled
  // seconds already stored on zones_seconds, and a session with no samples is
  // SKIPPED, never overwritten with a wall-clock fabrication.
  it('uses sampled seconds for a 4h auto-closed session and skips zero-sample sessions', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm1', isMaster: true })

    const sessions = [
      // Auto-closed at the 4h backstop but only 2 minutes of samples →
      // durationMin must be 2, not 240.
      {
        id: 'sess-ghost',
        contact_id: 'c-1',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T14:00:00Z',
        avg_hr_bpm: 145,
        calories_kcal: null,
        zones_seconds: { 1: 120, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
      // Ended with no samples at all (null zones) → skip, no overwrite.
      {
        id: 'sess-empty',
        contact_id: 'c-2',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T14:00:00Z',
        avg_hr_bpm: 140,
        calories_kcal: 999,
        zones_seconds: null,
      },
      // All-zero zones (summariseSession over an empty sample set) → skip too.
      {
        id: 'sess-zero',
        contact_id: 'c-3',
        started_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-01T14:00:00Z',
        avg_hr_bpm: 140,
        calories_kcal: 999,
        zones_seconds: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
    ]

    const updatedIds = []
    const db = {
      from(table) {
        if (table === 'heart_rate_sessions') {
          let isUpdate = false
          const builder = {
            select: function () { return this },
            not: function () { return this },
            gte: function () { return this },
            order: function () { return this },
            range: (from) => Promise.resolve({ data: from === 0 ? sessions : [], error: null }),
            update: function () { isUpdate = true; return this },
            eq: function (col, val) {
              if (isUpdate && col === 'id') {
                updatedIds.push(val)
                return Promise.resolve({ error: null })
              }
              return this
            },
          }
          return builder
        }
        return { select: function () { return this }, range: () => Promise.resolve({ data: [], error: null }) }
      },
    }

    createServerClient.mockReturnValue(db)
    resolveBodyMetrics.mockResolvedValue({ age: 30, weightKg: 80, gender: 'male' })
    estimateCaloriesKcal.mockReturnValue(50)

    const res = await POST(makeReq({ location_id: 'loc-1', since: '2026-06-01' }))
    const json = await res.json()
    expect(json.data).toMatchObject({ scanned: 3, filled: 1, skipped: 2 })
    expect(updatedIds).toEqual(['sess-ghost'])
    expect(estimateCaloriesKcal).toHaveBeenCalledTimes(1)
    expect(estimateCaloriesKcal).toHaveBeenCalledWith(expect.objectContaining({ durationMin: 2 }))
    // The no-sample sessions never even resolved body metrics.
    expect(resolveBodyMetrics).toHaveBeenCalledTimes(1)
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
        zones_seconds: { 1: 3000, 2: 0, 3: 0, 4: 0, 5: 0 },
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
