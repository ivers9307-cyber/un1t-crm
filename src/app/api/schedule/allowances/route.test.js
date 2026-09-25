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
function buildDb({ links = ['loc-1'], existing = null, existingError = null, employmentType = 'fte', entitlement = null, pending = [], pendingError = null }) {
  const pendingCalls = []
  const upsertSpy = vi.fn()
  const one = (data) => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data, error: null }) }) })
  const db = {
    from: (t) => {
      // LEAVE.2 — employment type + contract entitlement for the defaults.
      if (t === 'profiles') return { select: () => one({ employment_type: employmentType }) }
      if (t === 'profile_compensation') {
        return { select: () => one(entitlement === undefined ? null : { annual_leave_entitlement: entitlement }) }
      }
      if (t === 'profile_locations') {
        return { select: () => ({ eq: () => Promise.resolve({ data: links.map((l) => ({ location_id: l })), error: null }) }) }
      }
      if (t === 'staff_allowances') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existingError ? null : existing, error: existingError }) }) }) }),
          upsert: (row) => { upsertSpy(row); return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) } },
        }
      }
      // LEAVEDAYS.1 — getPendingHolidayDays: select → eq ×3 → gte → lte, awaited.
      if (t === 'time_off_requests') {
        const chain = {
          select: (cols) => { pendingCalls.push(['select', cols]); return chain },
          eq: (...a) => { pendingCalls.push(['eq', ...a]); return chain },
          gte: (...a) => { pendingCalls.push(['gte', ...a]); return chain },
          lte: (...a) => { pendingCalls.push(['lte', ...a]); return chain },
          then: (res, rej) => Promise.resolve({ data: pendingError ? null : pending, error: pendingError }).then(res, rej),
        }
        return chain
      }
      throw new Error(t)
    },
  }
  return { db, upsertSpy, pendingCalls }
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

// LEAVE.4 / LEAVE.3 — the no-row default is the contract entitlement, and a
// contractor's allowance is flagged not applicable.
describe('allowance defaults', () => {
  const ME = { id: PID, ...at('staff') }
  const url = `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`

  it('seeds the default from profile_compensation.annual_leave_entitlement', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ entitlement: 15 }).db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data).toMatchObject({ total_days: 15, remaining: 15, used_days: 0, not_applicable: false })
  })

  it('falls back to 20 only when the entitlement is null', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ entitlement: null }).db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data).toMatchObject({ total_days: 20, remaining: 20 })
  })

  it('an existing row is returned as stored, not re-seeded', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ entitlement: 15, existing: { total_days: 20, used_days: 2, carried_over: 0 } }).db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data).toMatchObject({ total_days: 20, remaining: 18 })
  })

  it('flags a contractor as not applicable', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ employmentType: 'contractor', existing: { total_days: 20, used_days: 1, carried_over: 0 } }).db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data.not_applicable).toBe(true)
  })
})

// LEAVEDAYS.1 — the form judged "exceeds balance" on `remaining`, while the
// POST refuses on remaining MINUS pending holiday days. The GET now reports
// that sum, from the function the POST uses (getPendingHolidayDays).
describe('pending_days', () => {
  const ME = { id: PID, ...at('staff') }
  const url = `http://x/api/schedule/allowances?profile_id=${PID}&year=2026`

  it('is reported beside an existing row, and `remaining` keeps its meaning (pending NOT deducted)', async () => {
    getCurrentUser.mockResolvedValue(ME)
    const { db, pendingCalls } = buildDb({ existing: { total_days: 20, used_days: 17, carried_over: 0 }, pending: [{ total_days: 1 }, { total_days: '1.0' }] })
    createServerClient.mockReturnValue(db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data).toMatchObject({ total_days: 20, used_days: 17, remaining: 3, pending_days: 2 })
    expect(pendingCalls).toEqual([
      ['select', 'total_days'],
      ['eq', 'profile_id', PID], ['eq', 'type', 'holiday'], ['eq', 'status', 'pending'],
      ['gte', 'start_date', '2026-01-01'], ['lte', 'start_date', '2026-12-31'],
    ])
  })

  it('is reported when there is no row yet', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ entitlement: 15, pending: [{ total_days: 4 }] }).db)
    const json = await (await GET(req(null, url))).json()
    expect(json.data).toMatchObject({ total_days: 15, remaining: 15, pending_days: 4 })
  })

  it('is 0, not absent, when nothing is pending', async () => {
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({}).db)
    expect((await (await GET(req(null, url))).json()).data.pending_days).toBe(0)
  })

  it('an unreadable sum is OMITTED, never 0, and the allowance still loads', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    getCurrentUser.mockResolvedValue(ME)
    createServerClient.mockReturnValue(buildDb({ existing: { total_days: 20, used_days: 2, carried_over: 0 }, pendingError: { message: 'down' } }).db)
    const res = await GET(req(null, url))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.remaining).toBe(18)
    expect(json.data).not.toHaveProperty('pending_days')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
