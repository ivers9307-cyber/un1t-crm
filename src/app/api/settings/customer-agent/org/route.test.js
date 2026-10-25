// MIAORG.1 Task 4 — GET/PUT /api/settings/customer-agent/org: Mia's
// organisation defaults. Masters and org admins only (resolveAdminOrgId),
// everyone else 404; studio-only keys refused; an upsert that writes only
// customer_agent; "Start from a studio's settings". Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { scriptedDb, chainsFor, argsOf } from '@/lib/scripted-db.test-helpers'

const ORG_A = 'a0000000-0000-0000-0000-00000000a0a1'
const ORG_B = 'a0000000-0000-0000-0000-00000000a0b2'
const NORTH = 'a0000000-0000-0000-0000-0000000000c1'
const SOUTH = 'a0000000-0000-0000-0000-0000000000c2'
const FOREIGN = 'a0000000-0000-0000-0000-0000000000c9'

const MASTER = { id: 'u-master', role: 'master', isMaster: true, activeLocation: { id: NORTH, organization_id: ORG_A }, activeOrganization: { id: ORG_A }, orgAdminOrgIds: [] }
const ORG_ADMIN = { id: 'u-admin', role: 'owner', activeLocation: { id: NORTH, organization_id: ORG_A }, activeOrganization: { id: ORG_A }, orgAdminOrgIds: [ORG_A], rolesByLocation: { [NORTH]: 'owner' } }
// An owner at every studio of the org, but no org_admin grant: not an org admin.
const OWNER = { id: 'u-owner', role: 'owner', activeLocation: { id: NORTH, organization_id: ORG_A }, activeOrganization: { id: ORG_A }, orgAdminOrgIds: [], rolesByLocation: { [NORTH]: 'owner', [SOUTH]: 'owner' } }

const ok = (data) => ({ data, error: null })
const BOOM = { data: null, error: { message: 'connection reset' } }

const NORTH_BLOB = { enabled: true, test_mode: false, tone: 'North tone', booking_url: 'https://book.example/north', quiet_hours: { off: true }, followups: { daily_cap: 30 } }
const STUDIO_ROWS = [
  { id: NORTH, name: 'North Studio', customer_agent: NORTH_BLOB },
  { id: SOUTH, name: 'South Studio', customer_agent: null },
]

// The three reads every answer is built from (organization, org layer, studios).
const stateAnswers = ({ layer = null, org = { id: ORG_A, name: 'Org A' }, studios = STUDIO_ROWS } = {}) => ({
  organizations: [ok(org)],
  org_settings: [ok(layer === undefined ? null : { customer_agent: layer })],
  locations: [ok(studios)],
})

const getReq = (orgId) => new Request(`http://x/api/settings/customer-agent/org${orgId ? `?organization_id=${orgId}` : ''}`)
const putReq = (body) => new Request('http://x/api/settings/customer-agent/org', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

function serveDb(script) {
  const db = scriptedDb(script)
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => vi.clearAllMocks())

describe('GET — who may read', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq(ORG_A))).status).toBe(401)
  })

  it('a master reads any organisation', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = serveDb(stateAnswers({ org: { id: ORG_B, name: 'Org B' }, studios: [] }))
    const res = await GET(getReq(ORG_B))
    expect(res.status).toBe(200)
    expect(argsOf(chainsFor(db, 'org_settings')[0], 'eq')).toEqual(['organization_id', ORG_B])
  })

  it('a master with no organisation named gets the active one', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = serveDb(stateAnswers())
    expect((await GET(getReq())).status).toBe(200)
    expect(argsOf(chainsFor(db, 'org_settings')[0], 'eq')).toEqual(['organization_id', ORG_A])
  })

  it('an org admin reads their organisation', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb(stateAnswers())
    expect((await GET(getReq(ORG_A))).status).toBe(200)
  })

  it('an owner without an org admin grant is a 404, named org or not, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const db = serveDb({})
    expect((await GET(getReq(ORG_A))).status).toBe(404)
    expect((await GET(getReq())).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('an org admin asking for another organisation is a 404', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = serveDb({})
    expect((await GET(getReq(ORG_B))).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('a malformed organisation id is a 404 before any read, never a database error', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = serveDb({})
    expect((await GET(getReq('not-a-uuid'))).status).toBe(404)
    expect((await GET(getReq("x' or 1=1"))).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('PUT: a malformed organisation id is refused by the body schema (400) before any read', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = serveDb({})
    expect((await PUT(putReq({ organization_id: 'not-a-uuid', settings: { tone: 'x' } }))).status).toBe(400)
    expect((await PUT(putReq({ copy_from_location_id: 'not-a-uuid' }))).status).toBe(400)
    expect(db.calls).toEqual([])
  })

  it('a master naming an organisation that does not exist is a 404', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    serveDb(stateAnswers({ org: null, studios: [] }))
    expect((await GET(getReq(ORG_B))).status).toBe(404)
  })
})

describe('GET — what it answers', () => {
  it('the layer over the defaults without studio-only keys, the raw layer, and each studio\'s own paths', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const raw = { tone: 'Org tone', enabled: true, quiet_hours: { start: '22:00', end: '07:00' } }
    const db = serveDb(stateAnswers({ layer: raw }))
    const { data } = await (await GET(getReq(ORG_A))).json()
    expect(data.raw).toEqual(raw)
    expect(data.settings.tone).toBe('Org tone')
    expect(data.settings.agent_name).toBe('Mia')
    expect(data.settings).not.toHaveProperty('enabled')
    expect(data.settings).not.toHaveProperty('booking_url')
    expect(data.defaults).not.toHaveProperty('test_mode')
    expect(data.studios).toEqual([
      { id: NORTH, name: 'North Studio', sets: ['followups.daily_cap', 'quiet_hours.off', 'tone'], mia_on: true },
      { id: SOUTH, name: 'South Studio', sets: [], mia_on: false },
    ])
    // only the org's ACTIVE studios, and only the Mia blob of each
    const [studios] = chainsFor(db, 'locations')
    expect(argsOf(studios, 'select')[0]).toBe('id, name, customer_agent:settings->customer_agent')
    expect(studios.filter(([m]) => m === 'eq')).toEqual([['eq', 'organization_id', ORG_A], ['eq', 'active', true]])
  })

  it('no row yet: raw null and the plain defaults', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb(stateAnswers({ layer: undefined }))
    const { data } = await (await GET(getReq(ORG_A))).json()
    expect(data.raw).toBe(null)
    expect(data.settings.quiet_hours).toBe(null)
  })

  it('a failed read is a 500, never "no defaults"', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb({ organizations: [ok({ id: ORG_A, name: 'Org A' })], org_settings: [BOOM], locations: [ok([])] })
    const res = await GET(getReq(ORG_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('org_settings_unreadable')
    expect(logError).toHaveBeenCalled()
  })
})

describe('PUT settings — who may write, what is refused', () => {
  it('an owner without an org admin grant is a 404 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const db = serveDb({})
    expect((await PUT(putReq({ organization_id: ORG_A, settings: { tone: 'x' } }))).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('another organisation is a 404', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = serveDb({})
    expect((await PUT(putReq({ organization_id: ORG_B, settings: { tone: 'x' } }))).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('studio-only keys are a 400 naming each, and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [ok(null)] })
    const res = await PUT(putReq({ organization_id: ORG_A, settings: { tone: 'Warm', enabled: true, test_mode: true, booking_url: 'https://book.example' } }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues.map((i) => i.path)).toEqual(['settings.enabled', 'settings.test_mode', 'settings.booking_url'])
    expect(chainsFor(db, 'org_settings').some((c) => argsOf(c, 'upsert'))).toBe(false)
  })

  it('monthly_points_target is studio-only (final review): a 400 at the organisation', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [ok(null)] })
    const res = await PUT(putReq({ organization_id: ORG_A, settings: { monthly_points_target: 3000 }, overridden: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues.map((i) => i.path)).toEqual(['settings.monthly_points_target'])
    expect(chainsFor(db, 'org_settings').some((c) => argsOf(c, 'upsert'))).toBe(false)
  })

  it('quiet_hours.off (a studio\'s opt-out) is a 400', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [ok(null)] })
    const res = await PUT(putReq({ organization_id: ORG_A, settings: { quiet_hours: { off: true } } }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues[0].path).toBe('settings.quiet_hours.off')
  })

  it('an invalid value is a 400 with the settings path', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [ok(null)] })
    const res = await PUT(putReq({ organization_id: ORG_A, settings: { effort: 'turbo' }, overridden: ['effort'] }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues[0].path).toBe('settings.effort')
  })

  it('settings and a copy together, or neither, is a 400', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb({})
    expect((await PUT(putReq({ organization_id: ORG_A, settings: {}, copy_from_location_id: NORTH }))).status).toBe(400)
    expect((await PUT(putReq({ organization_id: ORG_A }))).status).toBe(400)
  })
})

describe('PUT settings — the write', () => {
  it('no row yet: upserts on organization_id with ONLY customer_agent, the fields the org sets, no zone', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const state = stateAnswers({ layer: { tone: 'Warm', quiet_hours: { start: '22:00', end: '07:00' } } })
    const db = serveDb({
      organizations: [ok({ id: ORG_A }), ...state.organizations],
      org_settings: [ok(null), ok({ organization_id: ORG_A }), ...state.org_settings],
      locations: state.locations,
    })
    const res = await PUT(putReq({
      organization_id: ORG_A,
      settings: { tone: 'Warm', extra_rules: 'Not set', quiet_hours: { start: '22:00', end: '07:00', tz: 'America/New_York' }, followups: { enabled: false } },
      overridden: ['tone', 'quiet_hours.start', 'quiet_hours.end', 'quiet_hours.tz'],
    }))
    expect(res.status).toBe(200)
    const upsert = chainsFor(db, 'org_settings').map((c) => argsOf(c, 'upsert')).find(Boolean)
    expect(upsert).toEqual([
      { organization_id: ORG_A, customer_agent: { tone: 'Warm', quiet_hours: { start: '22:00', end: '07:00' } }, updated_by: ORG_ADMIN.id },
      { onConflict: 'organization_id' },
    ])
    const { data } = await res.json()
    expect(data.raw.tone).toBe('Warm')
    expect(data.studios).toHaveLength(2)
  })

  it('without `overridden`, every non-null value sent is the organisation\'s', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const state = stateAnswers()
    const db = serveDb({
      organizations: [ok({ id: ORG_A }), ...state.organizations],
      org_settings: [ok({ customer_agent: { tone: 'Old' } }), ok({ organization_id: ORG_A }), ...state.org_settings],
      locations: state.locations,
    })
    expect((await PUT(putReq({ settings: { agent_name: 'Ava', tone: null } }))).status).toBe(200)
    const upsert = chainsFor(db, 'org_settings').map((c) => argsOf(c, 'upsert')).find(Boolean)
    expect(upsert[0]).toEqual({ organization_id: ORG_A, customer_agent: { agent_name: 'Ava' }, updated_by: MASTER.id })
  })

  it('clearing everything stores NULL (the organisation sets nothing)', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const state = stateAnswers()
    const db = serveDb({
      organizations: [ok({ id: ORG_A }), ...state.organizations],
      org_settings: [ok({ customer_agent: { tone: 'Old' } }), ok({ organization_id: ORG_A }), ...state.org_settings],
      locations: state.locations,
    })
    expect((await PUT(putReq({ organization_id: ORG_A, settings: { tone: null }, overridden: [] }))).status).toBe(200)
    const upsert = chainsFor(db, 'org_settings').map((c) => argsOf(c, 'upsert')).find(Boolean)
    expect(upsert[0]).toEqual({ organization_id: ORG_A, customer_agent: null, updated_by: ORG_ADMIN.id })
  })

  it('a failed write is a 500, logged', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [ok(null), BOOM] })
    const res = await PUT(putReq({ organization_id: ORG_A, settings: { tone: 'Warm' } }))
    expect(res.status).toBe(500)
    expect(logError).toHaveBeenCalledWith('settings-customer-agent-org', 'write failed', expect.any(Object))
  })

  it('a failed read before the write is a 500 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = serveDb({ organizations: [ok({ id: ORG_A })], org_settings: [BOOM] })
    expect((await PUT(putReq({ organization_id: ORG_A, settings: { tone: 'Warm' } }))).status).toBe(500)
    expect(chainsFor(db, 'org_settings')).toHaveLength(1)
  })
})

describe('PUT copy_from_location_id — Start from a studio\'s settings (T4-C)', () => {
  function copyDb({ current = { extra_rules: 'Org rule', tone: 'Org tone' }, source } = {}) {
    const state = stateAnswers()
    return serveDb({
      organizations: [ok({ id: ORG_A }), ...state.organizations],
      org_settings: [ok(current ? { customer_agent: current } : null), ok({ organization_id: ORG_A }), ...state.org_settings],
      // the source read honours the org filter: a studio of another org is not found
      locations: [(chain) => {
        const orgEq = chain.find(([m, col]) => m === 'eq' && col === 'organization_id')
        const idEq = chain.find(([m, col]) => m === 'eq' && col === 'id')
        const activeOnly = chain.some(([m, col, v]) => m === 'eq' && col === 'active' && v === true)
        const row = (source || []).find((r) => r.id === idEq?.[2] && r.organization_id === orgEq?.[2] && (!activeOnly || r.active !== false))
        return ok(row || null)
      }, ...state.locations],
    })
  }

  it('copies the studio\'s inheritable values over the org layer, keeps the other org fields, never touches the studio', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = copyDb({ source: [{ id: NORTH, organization_id: ORG_A, customer_agent: NORTH_BLOB }] })
    const res = await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: NORTH }))
    expect(res.status).toBe(200)
    const upsert = chainsFor(db, 'org_settings').map((c) => argsOf(c, 'upsert')).find(Boolean)
    expect(upsert[0]).toEqual({
      organization_id: ORG_A,
      // tone overwritten; extra_rules kept; never enabled/test_mode/booking_url
      // or the studio's quiet-hours opt-out
      customer_agent: { extra_rules: 'Org rule', tone: 'North tone', followups: { daily_cap: 30 } },
      // final review: who saved it (org_settings.updated_by -> profiles.id, mig 317)
      updated_by: ORG_ADMIN.id,
    })
    for (const c of chainsFor(db, 'locations')) {
      expect(c.some(([m]) => ['update', 'upsert', 'insert', 'delete'].includes(m))).toBe(false)
    }
    const source = chainsFor(db, 'locations')[0]
    expect(source.filter(([m]) => m === 'eq')).toEqual([['eq', 'id', NORTH], ['eq', 'organization_id', ORG_A], ['eq', 'active', true]])
  })

  it('a studio of another organisation is a 404 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = copyDb({ source: [{ id: FOREIGN, organization_id: ORG_B, customer_agent: NORTH_BLOB }] })
    expect((await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: FOREIGN }))).status).toBe(404)
    expect(chainsFor(db, 'org_settings').some((c) => argsOf(c, 'upsert'))).toBe(false)
  })

  it('an inactive studio of the organisation is a 404 (the picker never offers one)', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = copyDb({ source: [{ id: SOUTH, organization_id: ORG_A, active: false, customer_agent: { agent_name: 'Ava' } }] })
    expect((await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: SOUTH }))).status).toBe(404)
    expect(chainsFor(db, 'org_settings').some((c) => argsOf(c, 'upsert'))).toBe(false)
  })

  it('an owner without an org admin grant cannot copy (404)', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const db = serveDb({})
    expect((await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: NORTH }))).status).toBe(404)
    expect(db.calls).toEqual([])
  })

  it('no org row yet: the copy is inserted', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const db = copyDb({ current: null, source: [{ id: SOUTH, organization_id: ORG_A, customer_agent: { enabled: false, agent_name: 'Ava' } }] })
    expect((await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: SOUTH }))).status).toBe(200)
    const upsert = chainsFor(db, 'org_settings').map((c) => argsOf(c, 'upsert')).find(Boolean)
    expect(upsert).toEqual([{ organization_id: ORG_A, customer_agent: { agent_name: 'Ava' }, updated_by: MASTER.id }, { onConflict: 'organization_id' }])
  })

  it('a studio value the org layer cannot take is a 422 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const db = copyDb({ source: [{ id: NORTH, organization_id: ORG_A, customer_agent: { effort: 'turbo' } }] })
    expect((await PUT(putReq({ organization_id: ORG_A, copy_from_location_id: NORTH }))).status).toBe(422)
    expect(chainsFor(db, 'org_settings').some((c) => argsOf(c, 'upsert'))).toBe(false)
  })
})
