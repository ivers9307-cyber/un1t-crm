// WAORGNUMBER.2 (R5) — a studio picks the templates its automatic messages use.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {}
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      let rows = state[table]
      let patch = null
      const q = {
        update(p) { patch = p; return q },
        eq(col, val) { rows = rows.filter((r) => r[col] === val); return q },
        select() { return q },
        single() { return q.maybeSingle().then((r) => (r.data || r.error ? r : { data: null, error: { code: 'PGRST116', message: 'no rows' } })) },
        maybeSingle() {
          if (state.fail === table) return Promise.resolve({ data: null, error: { message: 'boom' } })
          if (patch) {
            state.writes.push({ table, patch })
            if (rows[0]) Object.assign(rows[0], patch)
          }
          return Promise.resolve({ data: rows[0] || null, error: null })
        },
      }
      return q
    },
  }),
}))

import { GET, PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const STILL = 'a0000000-0000-4000-8000-000000000001'
const T_UTIL = 'c0000000-0000-4000-8000-000000000001'
const T_MKT = 'c0000000-0000-4000-8000-000000000002'
const T_PENDING = 'c0000000-0000-4000-8000-000000000003'
const T_STILL = 'c0000000-0000-4000-8000-000000000004'

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const put = (loc, body) => PUT(
  new Request(`http://x/api/locations/${loc}/whatsapp/purpose-templates`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  ctx(loc),
)
const user = (role, loc = HATCH) => ({ id: 'u1', role, profileRole: role === 'master' ? 'master' : 'staff', rolesByLocation: { [loc]: role } })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  getCurrentUser.mockResolvedValue(user('manager'))
  state.fail = null
  state.writes = []
  state.locations = [
    { id: HATCH, settings: { glofox: { branch: 'x' }, whatsapp_purpose_templates: { event_waitlist_offer: T_UTIL } } },
    { id: STILL, settings: {} },
  ]
  state.whatsapp_templates = [
    { id: T_UTIL, location_id: HATCH, status: 'APPROVED', category: 'UTILITY' },
    { id: T_MKT, location_id: HATCH, status: 'APPROVED', category: 'MARKETING' },
    { id: T_PENDING, location_id: HATCH, status: 'PENDING', category: 'UTILITY' },
    { id: T_STILL, location_id: STILL, status: 'APPROVED', category: 'UTILITY' },
  ]
})

describe('PUT /api/locations/[id]/whatsapp/purpose-templates', () => {
  it('head_coach 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(user('head_coach'))
    const res = await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })
    expect(res.status).toBe(403)
    expect(state.writes).toEqual([])
  })

  it('an owner at another studio is 403 here (role judged at the path id)', async () => {
    getCurrentUser.mockResolvedValue(user('owner', STILL))
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })).status).toBe(403)
  })

  it('a caller without access to the studio gets the access guard', async () => {
    assertLocationAccess.mockReturnValue(new Response(JSON.stringify({ success: false }), { status: 403 }))
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })).status).toBe(403)
    expect(state.writes).toEqual([])
  })

  it('signed out is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })).status).toBe(401)
  })

  it('MARKETING template refused for class_confirmed', async () => {
    const res = await put(HATCH, { purpose: 'class_confirmed', templateId: T_MKT })
    expect(res.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('MARKETING is allowed for the ad welcome', async () => {
    expect((await put(HATCH, { purpose: 'meta_ad_welcome', templateId: T_MKT })).status).toBe(200)
  })

  it('a template that is not APPROVED, or is another studio\'s, or unknown is refused', async () => {
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_PENDING })).status).toBe(400)
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_STILL })).status).toBe(400)
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: 'c0000000-0000-4000-8000-0000000000ff' })).status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('an unknown purpose or a malformed id is a 400', async () => {
    expect((await put(HATCH, { purpose: 'nope', templateId: T_UTIL })).status).toBe(400)
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: 'not-an-id' })).status).toBe(400)
    expect((await put(HATCH, { purpose: 'class_confirmed' })).status).toBe(400)
  })

  it('saves the setting and keeps sibling settings and the other purposes', async () => {
    const res = await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(state.locations[0].settings).toEqual({
      glofox: { branch: 'x' },
      whatsapp_purpose_templates: { event_waitlist_offer: T_UTIL, class_confirmed: T_UTIL },
    })
    expect(body.data.selected).toEqual({ class_confirmed: T_UTIL, consult_confirmed: null, event_waitlist_offer: T_UTIL, meta_ad_welcome: null })
  })

  it('null clears the pick without checking a template', async () => {
    const res = await put(HATCH, { purpose: 'event_waitlist_offer', templateId: null })
    expect(res.status).toBe(200)
    expect(state.locations[0].settings.whatsapp_purpose_templates).toEqual({ event_waitlist_offer: null })
    expect(state.locations[0].settings.glofox).toEqual({ branch: 'x' })
    expect((await res.json()).data.selected.event_waitlist_offer).toBeNull()
  })

  it('a failed settings write is reported, not hidden', async () => {
    state.fail = 'locations'
    expect((await put(HATCH, { purpose: 'class_confirmed', templateId: T_UTIL })).status).toBe(500)
  })
})

describe('GET /api/locations/[id]/whatsapp/purpose-templates', () => {
  it('returns the picks and whether the caller can edit', async () => {
    const res = await GET(new Request('http://x'), ctx(HATCH))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      selected: { class_confirmed: null, consult_confirmed: null, event_waitlist_offer: T_UTIL, meta_ad_welcome: null },
      can_edit: true,
    })
  })

  it('a head coach can read but not edit', async () => {
    getCurrentUser.mockResolvedValue(user('head_coach'))
    expect((await (await GET(new Request('http://x'), ctx(HATCH))).json()).data.can_edit).toBe(false)
  })

  it('a studio with no settings reads as all null', async () => {
    getCurrentUser.mockResolvedValue(user('manager', STILL))
    const res = await GET(new Request('http://x'), ctx(STILL))
    expect(Object.values((await res.json()).data.selected).every((v) => v === null)).toBe(true)
  })
})
