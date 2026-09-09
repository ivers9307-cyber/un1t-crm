// ROSTER-FIX.2 — tenancy tests for /api/schedule/allowances.
//
// The route was role-scoped only: any manager could read or overwrite the
// leave allowance of a coach at another studio, and a partial PUT silently
// reset total_days to the 20-day default.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), getUserLocationIds: vi.fn(() => ['loc-1']) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, PUT } = await import('./route.js')

const PID = '11111111-1111-4111-8111-111111111111'

function req(body, url = 'http://x/api/schedule/allowances') {
  return { url, json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// links: which locations PID belongs to. existing: current allowance row or null.
function buildDb({ links = ['loc-1'], existing = null, existingError = null }) {
  const upsertSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t === 'profile_locations') {
        return { select: () => ({ eq: () => Promise.resolve({ data: links.map((l) => ({ location_id: l })), error: null }) }) }
      }
      if (t === 'staff_allowances') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existingError ? null : existing, error: existingError }) }) }) }),
          upsert: (row) => { upsertSpy(row); return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) } },
        }
      }
      throw new Error(t)
    },
  }
  return { db, upsertSpy }
}

beforeEach(() => { createServerClient.mockReset(); getCurrentUser.mockReset() })

describe('allowances tenancy', () => {
  it('GET 404 when the profile is not at any of the caller\'s locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    createServerClient.mockReturnValue(buildDb({ links: ['loc-9'] }).db)
    const res = await GET(req(null, `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`))
    expect(res.status).toBe(404)
  })

  it('PUT 404 for a profile outside the caller\'s locations', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    const { db, upsertSpy } = buildDb({ links: ['loc-9'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
    expect(res.status).toBe(404)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('PUT lets master and head_coach set an allowance', async () => {
    for (const role of ['master', 'head_coach']) {
      getCurrentUser.mockResolvedValue({ id: 'u', role })
      createServerClient.mockReturnValue(buildDb({}).db)
      const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
      expect(res.status).toBe(200)
    }
  })

  it('PUT 500 (no upsert) when the current-row read fails', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    const { db, upsertSpy } = buildDb({ existingError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ profile_id: PID, year: 2026, carried_over: 2 }))
    expect(res.status).toBe(500)
    // A discarded error here would have upserted total_days: 20 over a real
    // entitlement.
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('PUT with only carried_over keeps the existing total_days', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr', role: 'manager' })
    const { db, upsertSpy } = buildDb({ existing: { profile_id: PID, year: 2026, total_days: 25, carried_over: 0, used_days: 3 } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ profile_id: PID, year: 2026, carried_over: 2 }))
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ total_days: 25, carried_over: 2 }))
  })
})
