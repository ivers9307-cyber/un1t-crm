// USAGE.1 — the App usage report routes: the master-only gate (service-role
// reads, so the gate is the whole access control), tenant and studio
// scoping, and the 90-day timeline window.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')
const { GET: GET_PERSON } = await import('./[profileId]/route.js')

const ORG_U = '0a000000-0000-4000-8000-000000000001'
const ORG_C = '0a000000-0000-4000-8000-000000000002'
const LOC_S = '0b000000-0000-4000-8000-000000000001'
const LOC_H = '0b000000-0000-4000-8000-000000000002'
const LOC_C = '0b000000-0000-4000-8000-000000000003'
const P_AOIFE = '0c000000-0000-4000-8000-000000000001'
const P_CONOR = '0c000000-0000-4000-8000-000000000002'
const P_CAR = '0c000000-0000-4000-8000-000000000003'

const TABLES = {
  organizations: [{ id: ORG_U, name: 'UN1T Group' }, { id: ORG_C, name: 'CCF Autos' }],
  locations: [
    { id: LOC_S, name: 'Stillorgan', organization_id: ORG_U },
    { id: LOC_H, name: 'Hatch Street', organization_id: ORG_U },
    { id: LOC_C, name: 'CCF', organization_id: ORG_C },
  ],
  profiles: [
    { id: P_AOIFE, full_name: 'Aoife', role: 'staff' },
    { id: P_CONOR, full_name: 'Conor', role: 'staff' },
    { id: P_CAR, full_name: 'Cathal', role: 'staff' },
  ],
  profile_locations: [
    { profile_id: P_AOIFE, location_id: LOC_S },
    { profile_id: P_CONOR, location_id: LOC_H },
    { profile_id: P_CAR, location_id: LOC_C },
  ],
  profile_organizations: [],
  app_usage_sessions: [],
  app_usage_visits: [],
}

function makeDb({ summary = [], lastActive = [], tables = TABLES } = {}) {
  const calls = []
  const builder = (data) => {
    const b = {
      select() { return b }, eq(c, v) { calls.push(['eq', c, v]); return b }, neq(c, v) { calls.push(['neq', c, v]); return b },
      is(c, v) { calls.push(['is', c, v]); return b }, in() { return b }, lt() { return b }, gte() { return b },
      order() { return b }, range() { return b },
      then(resolve) { return Promise.resolve({ data, error: null }).then(resolve) },
    }
    return b
  }
  return {
    calls,
    from(table) { calls.push(['from', table]); return builder(tables[table] || []) },
    rpc(fn, args) {
      calls.push(['rpc', fn, args])
      if (fn === 'app_usage_summary') {
        return builder(summary.filter((r) => args.p_profile_ids.includes(r.profile_id)
          && (!args.p_location_id || r.location_id === args.p_location_id)))
      }
      return builder(lastActive)
    },
  }
}

const master = { id: 'm1', profileRole: 'master', isMaster: true }
const req = (q = '') => new Request(`http://x/api/admin/app-usage${q}`)
const personReq = (id, q = '') => [new Request(`http://x/api/admin/app-usage/${id}${q}`), { params: Promise.resolve({ profileId: id }) }]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(master)
})

describe('GET /api/admin/app-usage', () => {
  it('401s signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('403s anyone but a master, before any read', async () => {
    getCurrentUser.mockResolvedValue({ id: 'o1', profileRole: 'owner', isMaster: false })
    expect((await GET(req())).status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403s a master viewing as someone else', async () => {
    getCurrentUser.mockResolvedValue({ ...master, profileRole: 'staff', impersonatingFrom: { id: 'm1' } })
    expect((await GET(req())).status).toBe(403)
  })

  it('lists every in-scope staff member, unused ones included, and never masters or tombstones', async () => {
    const db = makeDb({ summary: [{ profile_id: P_AOIFE, platform: 'all', feature: '_session', visits: 3, seconds: 600, days: 1 }] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req('?range=7d'))).json()
    expect(body.data.rows.map((r) => r.name)).toEqual(['Aoife', 'Cathal', 'Conor'])
    expect(body.data.totals).toMatchObject({ activeStaff: 1, staffCount: 3, sessions: 3, seconds: 600 })
    expect(db.calls).toContainEqual(['neq', 'role', 'master'])
    expect(db.calls).toContainEqual(['is', 'deleted_at', null])
    expect(db.calls).toContainEqual(['eq', 'active', true])
  })

  it('narrows to one tenant and labels rows with it', async () => {
    createServerClient.mockReturnValue(makeDb())
    const body = await (await GET(req(`?organization_id=${ORG_C}`))).json()
    expect(body.data.rows.map((r) => [r.name, r.tenant])).toEqual([['Cathal', 'CCF Autos']])
  })

  it('studio filter: people assigned there plus anyone with usage there', async () => {
    const db = makeDb({ summary: [{ profile_id: P_CONOR, platform: 'all', feature: '_session', visits: 1, seconds: 60, days: 1, location_id: LOC_S }] })
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req(`?organization_id=${ORG_U}&location_id=${LOC_S}`))).json()
    expect(body.data.rows.map((r) => r.name).sort()).toEqual(['Aoife', 'Conor'])
    expect(db.calls.find((c) => c[1] === 'app_usage_summary')[2].p_location_id).toBe(LOC_S)
  })

  it('400s a studio outside the chosen tenant', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await GET(req(`?organization_id=${ORG_C}&location_id=${LOC_S}`))).status).toBe(400)
  })

  it('answers the features view', async () => {
    createServerClient.mockReturnValue(makeDb({ summary: [{ profile_id: P_AOIFE, platform: 'web', feature: 'contacts', visits: 2, seconds: 120, days: 1 }] }))
    const body = await (await GET(req('?view=features'))).json()
    expect(body.data.rows).toEqual([expect.objectContaining({ feature: 'contacts', people: 1, visits: 2, avgVisitSec: 60 })])
  })
})

describe('GET /api/admin/app-usage/[profileId]', () => {
  it('403s anyone but a master', async () => {
    getCurrentUser.mockResolvedValue({ id: 'o1', profileRole: 'owner' })
    expect((await GET_PERSON(...personReq(P_AOIFE))).status).toBe(403)
  })

  it('404s an unknown person and a person outside the chosen tenant', async () => {
    createServerClient.mockReturnValue(makeDb())
    expect((await GET_PERSON(...personReq('0c000000-0000-4000-8000-0000000000ff'))).status).toBe(404)
    expect((await GET_PERSON(...personReq(P_AOIFE, `?organization_id=${ORG_C}`))).status).toBe(404)
    expect((await GET_PERSON(...personReq('not-a-uuid'))).status).toBe(404)
  })

  it('answers features and today\'s timeline', async () => {
    const tables = {
      ...TABLES,
      app_usage_sessions: [{ id: 's1', platform: 'phone', location_id: LOC_S, started_at: '2026-10-26T07:05:00Z', ended_at: '2026-10-26T07:20:00Z' }],
      app_usage_visits: [{ session_id: 's1', feature: 'schedule', started_at: '2026-10-26T07:05:00Z', ended_at: '2026-10-26T07:20:00Z' }],
    }
    createServerClient.mockReturnValue(makeDb({ tables }))
    const body = await (await GET_PERSON(...personReq(P_AOIFE))).json()
    expect(body.data.timelineAvailable).toBe(true)
    expect(body.data.timeline[0].trail).toEqual([{ feature: 'schedule', label: 'Rota', seconds: 900 }])
    expect(body.data.person).toMatchObject({ profileId: P_AOIFE, name: 'Aoife' })
  })

  it('has no timeline for a day older than the 90-day detail window', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await GET_PERSON(...personReq(P_AOIFE, '?day=2020-01-01'))).json()
    expect(body.data).toMatchObject({ timelineAvailable: false, timeline: [] })
    expect(db.calls).not.toContainEqual(['from', 'app_usage_sessions'])
  })
})
