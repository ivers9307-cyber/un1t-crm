// ROSTER-FIX.2 — tenancy tests for /api/schedule/allowances.
//
// The route was role-scoped only: any manager could read or overwrite the
// leave allowance of a coach at another studio, and a partial PUT silently
// reset total_days to the 20-day default.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    getUserLocationIds: real.getUserLocationIds,
    // SCHEDROLES.1 — REAL: the per-studio role decision is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET, PUT } = await import('./route.js')

const PID = '11111111-1111-4111-8111-111111111111'

// Caller fixtures carry what getCurrentUser really returns: the ACTIVE
// studio's `role`, the estate `profileRole`, and the per-studio map.
const at = (role, locs = ['loc-1']) => ({
  role, profileRole: role === 'master' ? 'master' : 'staff',
  locations: locs.map((id) => ({ id })),
  rolesByLocation: role === 'master' ? {} : Object.fromEntries(locs.map((id) => [id, role])),
})
const MGR = { id: 'mgr', ...at('manager') }

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
    getCurrentUser.mockResolvedValue(MGR)
    createServerClient.mockReturnValue(buildDb({ links: ['loc-9'] }).db)
    const res = await GET(req(null, `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`))
    expect(res.status).toBe(404)
  })

  it('PUT 404 for a profile outside the caller\'s locations', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, upsertSpy } = buildDb({ links: ['loc-9'] })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
    expect(res.status).toBe(404)
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('PUT lets master and head_coach set an allowance', async () => {
    for (const role of ['master', 'head_coach']) {
      getCurrentUser.mockResolvedValue({ id: 'u', ...at(role) })
      createServerClient.mockReturnValue(buildDb({}).db)
      const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
      expect(res.status).toBe(200)
    }
  })

  it('PUT 500 (no upsert) when the current-row read fails', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, upsertSpy } = buildDb({ existingError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(req({ profile_id: PID, year: 2026, carried_over: 2 }))
    expect(res.status).toBe(500)
    // A discarded error here would have upserted total_days: 20 over a real
    // entitlement.
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('PUT with only carried_over keeps the existing total_days', async () => {
    getCurrentUser.mockResolvedValue(MGR)
    const { db, upsertSpy } = buildDb({ existing: { profile_id: PID, year: 2026, total_days: 25, carried_over: 0, used_days: 3 } })
    createServerClient.mockReturnValue(db)
    await PUT(req({ profile_id: PID, year: 2026, carried_over: 2 }))
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ total_days: 25, carried_over: 2 }))
  })

  // SCHEDROLES.1 — head coach at loc-1 (their ACTIVE studio), staff at loc-2.
  describe('per-studio role (SCHEDROLES.1)', () => {
    const mixed = (active) => ({
      id: 'mix', role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
      activeLocation: { id: active },
      locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
      rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
    })

    it('refuses a coach who is only at the studio where the caller is staff (PUT 403, GET 403)', async () => {
      getCurrentUser.mockResolvedValue(mixed('loc-1'))
      const { db, upsertSpy } = buildDb({ links: ['loc-2'] })
      createServerClient.mockReturnValue(db)
      const put = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
      expect(put.status).toBe(403)
      expect(upsertSpy).not.toHaveBeenCalled()
      const get = await GET(req(null, `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`))
      expect(get.status).toBe(403)
    })

    it('allows a coach at the studio the caller manages', async () => {
      getCurrentUser.mockResolvedValue(mixed('loc-1'))
      createServerClient.mockReturnValue(buildDb({ links: ['loc-1'] }).db)
      const res = await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))
      expect(res.status).toBe(200)
    })

    it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
      getCurrentUser.mockResolvedValue(mixed('loc-2'))
      createServerClient.mockReturnValue(buildDb({ links: ['loc-1'] }).db)
      expect((await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))).status).toBe(200)
      expect((await GET(req(null, `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`))).status).toBe(200)
    })

    it('master is allowed anywhere; a plain coach still reads their OWN allowance', async () => {
      getCurrentUser.mockResolvedValue({ id: 'boss', ...at('master', []) })
      createServerClient.mockReturnValue(buildDb({ links: ['loc-2'] }).db)
      expect((await PUT(req({ profile_id: PID, year: 2026, total_days: 25 }))).status).toBe(200)

      getCurrentUser.mockResolvedValue({ id: PID, ...at('staff') })
      createServerClient.mockReturnValue(buildDb({}).db)
      expect((await GET(req(null, 'http://x/api/schedule/allowances?year=2026'))).status).toBe(200)
    })
  })
})
