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

// A tolerant PostgREST chain: every filter returns itself, the terminals
// resolve the canned result.
function chain(result) {
  const c = {}
  for (const op of ['eq', 'in', 'lte', 'gte', 'neq', 'is', 'order', 'not']) c[op] = () => c
  c.single = () => Promise.resolve(result)
  c.maybeSingle = () => Promise.resolve(result)
  c.then = (res, rej) => Promise.resolve(result).then(res, rej)
  return c
}

function buildDb({ overlapping = [], allowance = null, pendingHoliday = [] }) {
  const insertSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t === 'staff_allowances') return { select: () => chain({ data: allowance, error: null }) }
      if (t === 'time_off_requests') {
        return {
          select: (cols = '') => {
            // The holiday allowance check reads only total_days; everything
            // else selected here is the overlap probe.
            if (cols.replace(/\s/g, '') === 'total_days') return chain({ data: pendingHoliday, error: null })
            return chain({ data: overlapping, error: null })
          },
          insert: (row) => {
            insertSpy(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: `row-${insertSpy.mock.calls.length}`, ...row }, error: null }) }) }
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
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ total_days: 5 }))
  })

  it('400 when the range has no working days for a holiday', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'holiday', start_date: '2026-06-06', end_date: '2026-06-07' }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a 30 Dec → 2 Jan range is split into one row per year', async () => {
    getCurrentUser.mockResolvedValue(USER)
    const { db, insertSpy } = buildDb({})
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ type: 'sick', start_date: '2026-12-30', end_date: '2027-01-02' }))
    expect(res.status).toBe(201)
    expect(insertSpy).toHaveBeenCalledTimes(2)
    expect(insertSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ start_date: '2026-12-30', end_date: '2026-12-31' }))
    expect(insertSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ start_date: '2027-01-01', end_date: '2027-01-02' }))
    const body = await res.json()
    expect(body.data.start_date).toBe('2026-12-30')
    expect(body.data_all).toHaveLength(2)
  })
})
