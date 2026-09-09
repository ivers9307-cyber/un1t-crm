// ROSTER-FIX.2 — integrity tests for POST /api/schedule/time-off.
//
// The POST used to accept overlapping requests from the same person, count
// weekends against a holiday allowance, and write one row for a range that
// straddles 31 December (so the second year's allowance never saw it).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc-1']),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersAtRolesOnce: vi.fn(() => Promise.resolve()) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')

function req(body) {
  return { url: 'http://x/api/schedule/time-off', json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// A tolerant PostgREST chain: every filter returns itself (eq() also records
// its column, so a per-year canned result can be picked), and the terminals
// resolve `result` — a value, or a function of the recorded eq() filters.
function chain(result) {
  const c = { _eq: {} }
  for (const op of ['in', 'lte', 'gte', 'neq', 'is', 'order', 'not']) c[op] = () => c
  c.eq = (col, val) => { c._eq[col] = val; return c }
  const settle = () => Promise.resolve(typeof result === 'function' ? result(c._eq) : result)
  c.single = settle
  c.maybeSingle = settle
  c.then = (res, rej) => settle().then(res, rej)
  return c
}

function buildDb({
  overlapping = [], overlappingError = null,
  allowance = null, allowanceByYear = null,
  pendingHoliday = [],
}) {
  const insertSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t === 'staff_allowances') {
        return {
          select: () => chain((eq) => ({
            data: allowanceByYear ? (allowanceByYear[eq.year] ?? null) : allowance,
            error: null,
          })),
        }
      }
      if (t === 'time_off_requests') {
        return {
          select: (cols = '') => {
            // The holiday allowance check reads only total_days; everything
            // else selected here is the overlap probe.
            if (cols.replace(/\s/g, '') === 'total_days') return chain({ data: pendingHoliday, error: null })
            return chain({ data: overlappingError ? null : overlapping, error: overlappingError })
          },
          // ROSTER-FIX.2 — the POST now sends ONE insert carrying every
          // year-split row, so the spy sees an array and `.select()` is the
          // terminal (no `.single()`).
          insert: (rows) => {
            insertSpy(rows)
            return { select: () => Promise.resolve({ data: rows.map((r, i) => ({ id: `row-${i + 1}`, ...r })), error: null }) }
          },
        }
      }
      throw new Error(t)
    },
  }
  return { db, insertSpy }
}

const USER = { id: 'c', role: 'staff', full_name: 'Coach', activeLocation: { id: 'loc-1' } }

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('POST /api/schedule/time-off — request integrity', () => {
  it('409 when the range overlaps the caller\'s existing pending request', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({
      overlapping: [{ id: 'old', start_date: '2026-06-02', end_date: '2026-06-04', status: 'pending', type: 'holiday' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(res.status).toBe(409)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a Mon-Sun holiday counts 5 working days', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith([expect.objectContaining({ total_days: 5 })])
  })

  it('400 when the range has no working days for a holiday', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-06', end_date: '2026-06-07' }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a 30 Dec → 2 Jan range is split into one row per year, in ONE insert', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'sick', start_date: '2026-12-30', end_date: '2027-01-02' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith([
      expect.objectContaining({ start_date: '2026-12-30', end_date: '2026-12-31' }),
      expect.objectContaining({ start_date: '2027-01-01', end_date: '2027-01-02' }),
    ])
    const body = await res.json()
    expect(body.data.start_date).toBe('2026-12-30')
    expect(body.data_all).toHaveLength(2)
  })

  it('400 when the range is longer than a year', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'unpaid', start_date: '2026-01-01', end_date: '2027-06-01' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Time-off requests are limited to one year')
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('500 (no insert) when the overlap guard query fails', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({ overlappingError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-05' }))
    expect(res.status).toBe(500)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('400 when the SECOND year of a straddling holiday has no allowance left', async () => {
    getCurrentUser.mockResolvedValue(USER)
    // 28-31 Dec 2026 = 4 working days against 20; 1-8 Jan 2027 = 6 working
    // days against 1. Charging the whole range to the first year would pass.
    const { db, insertSpy } = buildDb({
      allowanceByYear: {
        2026: { total_days: 20, carried_over: 0, used_days: 0 },
        2027: { total_days: 1, carried_over: 0, used_days: 0 },
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-12-28', end_date: '2027-01-08' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Insufficient holiday balance/)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})
