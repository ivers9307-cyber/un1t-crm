// TPLCLONE.1 — POST /api/schedule/templates/clone.
//
// The fake database HONOURS the location and id filters, so a dropped
// .eq('location_id', …) is a wrong answer here, not a silently green test
// (same posture as ORGSCOPE.1's fakes). The auth helpers are the REAL ones:
// membership, role-at-studio and the master bypass are all under test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: real.assertLocationAccess,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/roster', async (importOriginal) => ({
  ...(await importOriginal()),
  generateBlocksForTemplate: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { generateBlocksForTemplate } = await import('@/lib/roster')
const { POST } = await import('./route.js')

const ORG_1 = 'e0000000-0000-4000-8000-000000000001'
const ORG_2 = 'e0000000-0000-4000-8000-000000000002'
const STUDIO_A = 'a0000000-0000-4000-8000-000000000001' // source, org 1
const STUDIO_B = 'b0000000-0000-4000-8000-000000000002' // target, org 1
const STUDIO_X = 'f0000000-0000-4000-8000-000000000003' // another organisation
const T1 = 'c0000000-0000-4000-8000-000000000001'
const T2 = 'c0000000-0000-4000-8000-000000000002'
const T3 = 'c0000000-0000-4000-8000-000000000003'
const T9 = 'c0000000-0000-4000-8000-000000000009'
const T_FOREIGN = 'c0000000-0000-4000-8000-00000000000f'
const T_UNKNOWN = 'c0000000-0000-4000-8000-0000000000ff'

const LOCATIONS = [
  { id: STUDIO_A, organization_id: ORG_1, name: 'Studio A' },
  { id: STUDIO_B, organization_id: ORG_1, name: 'Studio B' },
  { id: STUDIO_X, organization_id: ORG_2, name: 'Studio X' },
]

const tpl = (over = {}) => ({
  id: T1, location_id: STUDIO_A, name: 'Early', start_time: '06:00:00', end_time: '09:00:00',
  color: '#10B981', role_label: 'Floor', active: true, display_order: 0,
  days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  ...over,
})
const EARLY = tpl()
const LATE = tpl({ id: T2, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [], min_coaches: 1, max_coaches: 3 })
const OLD = tpl({ id: T3, name: 'Old', active: false })
const FOREIGN = tpl({ id: T_FOREIGN, location_id: STUDIO_X, name: 'Their shift' })

function fakeDb({ locations = LOCATIONS, templates = [EARLY, LATE], fail = {}, takenMeanwhile = [] } = {}) {
  const calls = { reads: [], upserts: [] }
  function from(table) {
    if (table !== 'locations' && table !== 'shift_templates') throw new Error(`unexpected table ${table}`)
    const filters = []
    const b = {
      select() { return b },
      eq(col, v) { filters.push((r) => r[col] === v); return b },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return b },
      order() { return b },
      upsert(rows, opts) {
        calls.upserts.push({ rows, opts })
        return {
          select: async () => {
            if (fail.upsert) return { data: null, error: { message: 'insert failed' } }
            // ON CONFLICT (location_id, name) DO NOTHING: exact-name clashes are
            // not returned, including one another request added meanwhile.
            const clash = (r) => takenMeanwhile.includes(r.name)
              || templates.some((t) => t.location_id === r.location_id && t.name === r.name)
            return { data: rows.filter((r) => !clash(r)).map((r, i) => ({ id: `new-${i + 1}`, ...r })), error: null }
          },
        }
      },
      then(resolve, reject) {
        calls.reads.push(table)
        const rows = (table === 'locations' ? locations : templates).filter((r) => filters.every((f) => f(r)))
        const result = fail[table]
          ? { data: null, error: { message: `${table} read failed` } }
          : { data: rows.map((r) => ({ ...r })), error: null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return b
  }
  return { db: { from }, calls }
}

const studio = (id) => ({ ...LOCATIONS.find((l) => l.id === id) })
const member = (rolesByLocation) => ({
  id: 'u-1', role: 'manager', profileRole: 'staff',
  locations: Object.keys(rolesByLocation).map(studio),
  rolesByLocation,
})
const BOTH = member({ [STUDIO_A]: 'manager', [STUDIO_B]: 'manager' })
const MASTER = { id: 'u-master', role: 'master', profileRole: 'master', locations: LOCATIONS.map((l) => studio(l.id)), rolesByLocation: {} }

const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
const COPY_A_TO_B = { from_location_id: STUDIO_A, to_location_id: STUDIO_B }

async function run(user, body, dbOpts) {
  getCurrentUser.mockResolvedValue(user)
  const fake = fakeDb(dbOpts)
  createServerClient.mockReturnValue(fake.db)
  const res = await POST(req(body))
  return { status: res.status, json: await res.json(), calls: fake.calls }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  generateBlocksForTemplate.mockReset()
  generateBlocksForTemplate.mockResolvedValue({ inserted: 8, skipped: 0, removed: 0 })
})

describe('POST /api/schedule/templates/clone — who may copy (TPLCLONE.1)', () => {
  it('a master cannot copy between organisations, and no template is read', async () => {
    const { status, json, calls } = await run(MASTER, { from_location_id: STUDIO_X, to_location_id: STUDIO_B }, { templates: [FOREIGN] })
    expect(status).toBe(403)
    expect(json.error).toMatch(/same organisation/)
    expect(calls.reads).toEqual(['locations'])
    expect(calls.upserts).toEqual([])
  })

  it('a manager at studios in two organisations cannot copy between them either', async () => {
    const twoOrgs = member({ [STUDIO_X]: 'owner', [STUDIO_B]: 'manager' })
    const { status, calls } = await run(twoOrgs, { from_location_id: STUDIO_X, to_location_id: STUDIO_B }, { templates: [FOREIGN] })
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('an organisation that cannot be read is never "the same"', async () => {
    const locations = [studio(STUDIO_A), { ...studio(STUDIO_B), organization_id: null }]
    const { status, calls } = await run(MASTER, COPY_A_TO_B, { locations })
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('a studio row that is gone answers 404', async () => {
    const { status } = await run(MASTER, COPY_A_TO_B, { locations: [studio(STUDIO_A)] })
    expect(status).toBe(404)
  })

  it('refuses a caller who is only staff at the TARGET, and writes nothing', async () => {
    const { status, json, calls } = await run(member({ [STUDIO_A]: 'manager', [STUDIO_B]: 'staff' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(json.error).toMatch(/manager at both studios/)
    expect(calls.reads).toEqual([])
    expect(calls.upserts).toEqual([])
  })

  it('refuses a caller who is only staff at the SOURCE', async () => {
    const { status, calls } = await run(member({ [STUDIO_A]: 'staff', [STUDIO_B]: 'manager' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(calls.upserts).toEqual([])
  })

  it('refuses a target the caller does not belong to (membership before role)', async () => {
    const { status, json, calls } = await run(member({ [STUDIO_A]: 'manager' }), COPY_A_TO_B)
    expect(status).toBe(403)
    expect(json.error).toBe('Forbidden — location not in your assignments')
    expect(calls.reads).toEqual([])
  })

  it('refuses a caller who manages nowhere, and a signed-out caller', async () => {
    expect((await run(member({ [STUDIO_A]: 'staff', [STUDIO_B]: 'staff' }), COPY_A_TO_B)).status).toBe(403)
    expect((await run(null, COPY_A_TO_B)).status).toBe(403)
  })

  it('refuses copying a studio onto itself, and an empty template_ids list', async () => {
    expect((await run(BOTH, { from_location_id: STUDIO_A, to_location_id: STUDIO_A })).status).toBe(400)
    expect((await run(BOTH, { ...COPY_A_TO_B, template_ids: [] })).status).toBe(400)
  })

  it('a failed studio read stops it before any template is read', async () => {
    const { status, calls } = await run(BOTH, COPY_A_TO_B, { fail: { locations: true } })
    expect(status).toBe(500)
    expect(calls.reads).toEqual(['locations'])
  })
})
