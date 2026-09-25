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

describe('POST /api/schedule/templates/clone — the copy (TPLCLONE.1)', () => {
  const COPY_WITH_DAYS = { ...COPY_A_TO_B, copy_weekdays: true }

  it('copies the source\'s active templates into a same-org studio, after its existing ones, as one-offs by default', async () => {
    const existing = tpl({ id: T9, location_id: STUDIO_B, name: 'Open gym', display_order: 4 })
    const { status, json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, existing] })
    expect(status).toBe(201)
    expect(calls.upserts).toHaveLength(1)
    expect(calls.upserts[0].opts).toEqual({ onConflict: 'location_id,name', ignoreDuplicates: true })
    // No id, no created_at/updated_at, the target's studio, active, ordered
    // after 4, and NO weekdays: `[]` is the schema's "generates nothing".
    expect(calls.upserts[0].rows).toEqual([
      { location_id: STUDIO_B, name: 'Early', start_time: '06:00:00', end_time: '09:00:00', color: '#10B981', role_label: 'Floor', days_of_week: [], min_coaches: 2, max_coaches: 4, active: true, display_order: 5 },
      { location_id: STUDIO_B, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', color: '#10B981', role_label: 'Floor', days_of_week: [], min_coaches: 1, max_coaches: 3, active: true, display_order: 6 },
    ])
    expect(json.data.dry_run).toBe(false)
    expect(json.data.created).toEqual([
      { id: 'new-1', source_id: T1, name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: [], source_days_of_week: ['mon', 'wed'] },
      { id: 'new-2', source_id: T2, name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [], source_days_of_week: [] },
    ])
    expect(json.data.skipped).toEqual([])
  })

  it('by default puts nothing on the calendar', async () => {
    const { json } = await run(BOTH, COPY_A_TO_B)
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
    expect(json.data.generated_blocks).toBe(0)
  })

  it('copy_weekdays: true carries the weekly pattern across', async () => {
    const { json, calls } = await run(BOTH, COPY_WITH_DAYS)
    expect(calls.upserts[0].rows.map((r) => r.days_of_week)).toEqual([['mon', 'wed'], []])
    expect(json.data.created.map((c) => c.days_of_week)).toEqual([['mon', 'wed'], []])
  })

  it('a master and a head coach at both studios may copy too', async () => {
    expect((await run(MASTER, COPY_A_TO_B)).status).toBe(201)
    expect((await run(member({ [STUDIO_A]: 'head_coach', [STUDIO_B]: 'owner' }), COPY_A_TO_B)).status).toBe(201)
  })

  it('skips a name the target already has, whatever its case', async () => {
    const existing = tpl({ id: T9, location_id: STUDIO_B, name: 'early ', display_order: 0 })
    const { json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, existing] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Late'])
    expect(json.data.created.map((c) => c.name)).toEqual(['Late'])
    expect(json.data.skipped).toEqual([{ source_id: T1, name: 'Early', reason: 'name_exists' }])
  })

  it('a name the target gained while the copy ran is skipped, not an error', async () => {
    const { status, json } = await run(BOTH, COPY_A_TO_B, { takenMeanwhile: ['Late'] })
    expect(status).toBe(201)
    expect(json.data.created.map((c) => c.name)).toEqual(['Early'])
    expect(json.data.skipped).toEqual([{ source_id: T2, name: 'Late', reason: 'name_exists' }])
  })

  it('leaves inactive templates out by default, without reporting them', async () => {
    const { json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, OLD] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Early', 'Late'])
    expect(json.data.skipped).toEqual([])
  })

  it('template_ids copies only those; an inactive one, another studio\'s and an unknown one come back skipped, nameless where not the source\'s', async () => {
    const { json, calls } = await run(BOTH, { ...COPY_A_TO_B, template_ids: [T2, T3, T_FOREIGN, T_UNKNOWN] }, { templates: [EARLY, LATE, OLD, FOREIGN] })
    expect(calls.upserts[0].rows.map((r) => r.name)).toEqual(['Late'])
    expect(json.data.skipped).toEqual([
      { source_id: T3, name: 'Old', reason: 'inactive' },
      // The source read is pinned to from_location_id, so another studio's
      // template is simply not there: no name comes back for it.
      { source_id: T_FOREIGN, name: null, reason: 'not_found' },
      { source_id: T_UNKNOWN, name: null, reason: 'not_found' },
    ])
  })

  it('dry_run answers the same lists, with each source\'s weekdays, and writes nothing', async () => {
    const { status, json, calls } = await run(BOTH, { ...COPY_A_TO_B, dry_run: true })
    expect(status).toBe(200)
    expect(json.data.dry_run).toBe(true)
    expect(json.data.created.map((c) => c.name)).toEqual(['Early', 'Late'])
    expect(json.data.created[0]).not.toHaveProperty('id')
    expect(json.data.created[0].source_days_of_week).toEqual(['mon', 'wed'])
    expect(calls.upserts).toEqual([])
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })

  it('nothing left to create writes nothing and answers 200', async () => {
    const taken = [tpl({ id: T9, location_id: STUDIO_B, name: 'Early' }), tpl({ id: T3, location_id: STUDIO_B, name: 'Late' })]
    const { status, json, calls } = await run(BOTH, COPY_A_TO_B, { templates: [EARLY, LATE, ...taken] })
    expect(status).toBe(200)
    expect(json.data.created).toEqual([])
    expect(json.data.skipped.map((s) => s.reason)).toEqual(['name_exists', 'name_exists'])
    expect(calls.upserts).toEqual([])
  })

  it('with copy_weekdays, fills the next 8 weeks for copied templates that run on weekdays, and only those', async () => {
    const { json } = await run(BOTH, COPY_WITH_DAYS)
    expect(generateBlocksForTemplate).toHaveBeenCalledTimes(1)
    expect(generateBlocksForTemplate.mock.calls[0][1]).toMatchObject({
      id: 'new-1', location_id: STUDIO_B, name: 'Early', days_of_week: ['mon', 'wed'], min_coaches: 2, max_coaches: 4,
    })
    expect(json.data.generated_blocks).toBe(8)
    expect(json).not.toHaveProperty('warning')
  })

  it('a calendar fill that fails keeps the copy and says so', async () => {
    generateBlocksForTemplate.mockRejectedValueOnce(new Error('upsert refused'))
    const { status, json } = await run(BOTH, COPY_WITH_DAYS)
    expect(status).toBe(201)
    expect(json.data.created).toHaveLength(2)
    expect(json.data.generated_blocks).toBe(0)
    expect(json.warning).toMatch(/Early/)
    expect(json.warning).toMatch(/nightly/)
  })

  it('refuses a copy_weekdays that is not a boolean', async () => {
    expect((await run(BOTH, { ...COPY_A_TO_B, copy_weekdays: 'yes' })).status).toBe(400)
  })

  it('a failed template read writes nothing', async () => {
    const { status, calls } = await run(BOTH, COPY_A_TO_B, { fail: { shift_templates: true } })
    expect(status).toBe(500)
    expect(calls.upserts).toEqual([])
  })

  it('a failed insert is a 500, and nothing is filled', async () => {
    const { status, json } = await run(BOTH, COPY_WITH_DAYS, { fail: { upsert: true } })
    expect(status).toBe(500)
    expect(json.error).toMatch(/nothing was copied/)
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })
})
