// SNAPSHOT.1 — GET /api/schedule/rosters/[id]/compare. The comparison itself
// is tested in src/lib/roster-snapshot.test.js and roster-compare.test.js;
// this pins the gate (the blocks/[id] shape: a manager somewhere, 404 for an
// outsider, 403 for a member without the role there), the query checks, and
// that a failure is never passed off as an empty comparison.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    // REAL: membership (404) and the role at the roster's studio (403) are under test.
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster-snapshot', () => ({ loadRosterComparison: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { loadRosterComparison } = await import('@/lib/roster-snapshot')
const { GET } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const RID = 'c0000000-0000-0000-0000-000000000001'
const SID = 'd0000000-0000-0000-0000-000000000001'
const ROSTER = {
  id: RID, location_id: LOC, status: 'published', period_start: '2026-09-14', period_end: '2026-09-20',
  published_at: '2026-09-12T13:02:00+00:00', published_by: 'mgr-1',
}
const MANAGER = { id: 'mgr-1', profileRole: 'staff', locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'manager' } }
const DATA = { roster: { id: RID }, baseline: { snapshot_id: SID }, blocks: [], totals: {} }

function props(id = RID) {
  return { params: Promise.resolve({ id }) }
}
function get(query = '') {
  return new Request(`http://localhost/api/schedule/rosters/${RID}/compare${query}`)
}
function rosterDb({ roster = ROSTER, error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {
        select: (cols) => { q.ops.push(['select', cols]); return b },
        eq: (c, v) => { q.ops.push(['eq', c, v]); return b },
        maybeSingle: () => Promise.resolve({ data: error ? null : roster, error }),
      }
      return b
    },
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  loadRosterComparison.mockReset()
  getCurrentUser.mockResolvedValue(MANAGER)
  loadRosterComparison.mockResolvedValue({ data: DATA })
})

describe('GET /api/schedule/rosters/[id]/compare', () => {
  it('answers a manager at the studio with the comparison, for the window asked', async () => {
    const db = rosterDb()
    createServerClient.mockReturnValue(db)
    const res = await GET(get('?from=2026-09-15&to=2026-09-16'), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: DATA })
    expect(db.calls[0].table).toBe('rosters')
    expect(db.calls[0].ops).toContainEqual(['eq', 'id', RID])
    const [dbArg, args] = loadRosterComparison.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(args).toMatchObject({ roster: ROSTER, againstId: null, from: '2026-09-15', to: '2026-09-16' })
    expect(Number.isFinite(args.nowMs)).toBe(true)
  })

  it('passes a chosen baseline through', async () => {
    createServerClient.mockReturnValue(rosterDb())
    await GET(get(`?against=${SID}`), props())
    expect(loadRosterComparison.mock.calls[0][1]).toMatchObject({ againstId: SID, from: null, to: null })
  })

  it('no manager role anywhere: 403 before any read', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no session: 403', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(), props())).status).toBe(403)
  })

  it('refuses a date that is not real, a reversed range and a malformed baseline id', async () => {
    createServerClient.mockReturnValue(rosterDb())
    expect((await GET(get('?from=2026-02-30'), props())).status).toBe(400)
    expect((await GET(get('?from=2026-09-20&to=2026-09-14'), props())).status).toBe(400)
    expect((await GET(get('?against=not-a-uuid'), props())).status).toBe(400)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a malformed roster id is simply not found', async () => {
    const res = await GET(get(), props('nope'))
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('an unknown roster: 404', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: null }))
    expect((await GET(get(), props())).status).toBe(404)
  })

  it('a failed roster read is a 500, never a 404', async () => {
    createServerClient.mockReturnValue(rosterDb({ error: { message: 'timeout' } }))
    expect((await GET(get(), props())).status).toBe(500)
  })

  it("a roster at another studio is indistinguishable from a missing one: 404", async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { [LOC]: 'manager' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(404)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a member of the studio who is not a manager THERE: 403', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({
      ...MANAGER,
      locations: [{ id: LOC }, { id: OTHER }],
      rolesByLocation: { [LOC]: 'manager', [OTHER]: 'staff' },
    })
    expect((await GET(get(), props())).status).toBe(403)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a master reaches any studio', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, location_id: OTHER } }))
    getCurrentUser.mockResolvedValue({ id: 'm', profileRole: 'master', locations: [{ id: LOC }, { id: OTHER }], rolesByLocation: {} })
    expect((await GET(get(), props())).status).toBe(200)
  })

  it('a draft published nothing: 409', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, status: 'draft' } }))
    expect((await GET(get(), props())).status).toBe(409)
    expect(loadRosterComparison).not.toHaveBeenCalled()
  })

  it('a superseded roster was published, so it can be compared', async () => {
    createServerClient.mockReturnValue(rosterDb({ roster: { ...ROSTER, status: 'superseded' } }))
    expect((await GET(get(), props())).status).toBe(200)
  })

  it('a chosen baseline that is not at this studio: 404', async () => {
    createServerClient.mockReturnValue(rosterDb())
    loadRosterComparison.mockResolvedValue({ notFound: true })
    expect((await GET(get(`?against=${SID}`), props())).status).toBe(404)
  })

  it('a failed comparison read is a 500, never an empty comparison', async () => {
    createServerClient.mockReturnValue(rosterDb())
    loadRosterComparison.mockResolvedValue({ error: { message: 'down' } })
    const res = await GET(get(), props())
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
