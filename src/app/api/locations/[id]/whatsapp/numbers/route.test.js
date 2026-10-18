// WAORGNUMBER.1 (Task 6, R8) — a studio switches the organisation's WhatsApp
// numbers on and off and picks its default. The POST stays retired (410,
// pointing at the organisation page; a signed-out caller still gets 401).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {}
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', async () => {
  const { fakeOrgNumbersDb } = await import('@/lib/org-whatsapp-numbers-fake-db.test-helpers.js')
  return { createServerClient: () => fakeOrgNumbersDb(state) }
})
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET, POST, PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const OTHER_ORG_LOC = 'a0000000-0000-4000-8000-000000000003'
const NUM_A = 'b0000000-0000-4000-8000-00000000000a'
const NUM_B = 'b0000000-0000-4000-8000-00000000000b'
const NUM_C = 'b0000000-0000-4000-8000-00000000000c'
const NUM_FOREIGN = 'b0000000-0000-4000-8000-0000000000ff'

const num = (id, label, extra = {}) => ({
  id, organization_id: 'ORG-1', location_id: STILL, label, display_phone: `+353 1 ${label}`,
  is_active: true, access_token: `secret-${id}`, created_at: '2026-09-01T00:00:00Z', ...extra,
})
const lnk = (loc, id, extra = {}) => ({ location_id: loc, whatsapp_number_id: id, is_default: false, created_at: '2026-09-01T00:00:00Z', created_by: null, ...extra })

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const put = (loc, body) => PUT(
  new Request(`http://x/api/locations/${loc}/whatsapp/numbers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  ctx(loc),
)
const post = () => POST(
  new Request(`http://x/api/locations/${STILL}/whatsapp/numbers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  ctx(STILL),
)
const user = (role, loc = HATCH) => ({ id: 'u1', role, profileRole: role === 'master' ? 'master' : 'staff', rolesByLocation: { [loc]: role } })
const linksAt = (loc) => state.links.filter((l) => l.location_id === loc)
const defaultAt = (loc) => linksAt(loc).filter((l) => l.is_default).map((l) => l.whatsapp_number_id)

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  getCurrentUser.mockResolvedValue(user('manager'))
  state.locations = [
    { id: STILL, organization_id: 'ORG-1' },
    { id: HATCH, organization_id: 'ORG-1' },
    { id: OTHER_ORG_LOC, organization_id: 'ORG-2' },
  ]
  state.numbers = [num(NUM_A, 'A'), num(NUM_B, 'B', { created_at: '2026-09-02T00:00:00Z' }), num(NUM_C, 'C', { created_at: '2026-09-03T00:00:00Z' }),
    num(NUM_FOREIGN, 'F', { organization_id: 'ORG-2', location_id: OTHER_ORG_LOC })]
  state.links = [lnk(STILL, NUM_A, { is_default: true })]
  state.ops = []
  state.faults = {}
})

describe('GET /api/locations/[id]/whatsapp/numbers', () => {
  it('lists the organisation numbers with on and is_default for this studio, no credentials', async () => {
    const res = await GET(new Request('http://x'), ctx(STILL))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.numbers).toEqual([
      { id: NUM_A, label: 'A', display_phone: '+353 1 A', is_active: true, on: true, is_default: true },
      { id: NUM_B, label: 'B', display_phone: '+353 1 B', is_active: true, on: false, is_default: false },
      { id: NUM_C, label: 'C', display_phone: '+353 1 C', is_active: true, on: false, is_default: false },
    ])
    expect(JSON.stringify(body)).not.toContain('secret-')
  })

  it('a signed-out caller is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(new Request('http://x'), ctx(STILL))).status).toBe(401)
  })
})

describe('PUT /api/locations/[id]/whatsapp/numbers', () => {
  it('head_coach gets 403', async () => {
    getCurrentUser.mockResolvedValue(user('head_coach'))
    const res = await put(HATCH, { numberId: NUM_A, on: true })
    expect(res.status).toBe(403)
    expect(state.ops).toEqual([])
  })

  it('a manager at another studio gets 403 (the role is judged at THIS studio)', async () => {
    getCurrentUser.mockResolvedValue(user('manager', STILL))
    expect((await put(HATCH, { numberId: NUM_A, on: true })).status).toBe(403)
    expect(state.ops).toEqual([])
  })

  it('a signed-out caller is 401, an invalid body is 400', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await put(HATCH, { numberId: NUM_A, on: true })).status).toBe(401)
    getCurrentUser.mockResolvedValue(user('manager'))
    expect((await put(HATCH, { numberId: 'nope', on: true })).status).toBe(400)
    expect((await put(HATCH, { numberId: NUM_A })).status).toBe(400)
  })

  it('manager switches the org number on at Hatch', async () => {
    const res = await put(HATCH, { numberId: NUM_A, on: true })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(linksAt(HATCH)).toEqual([expect.objectContaining({ whatsapp_number_id: NUM_A, is_default: true, created_by: 'u1' })])
    expect(body.data.numbers.find((n) => n.id === NUM_A)).toMatchObject({ on: true, is_default: true })
    // Stillorgan's link is untouched.
    expect(linksAt(STILL)).toHaveLength(1)
  })

  it('a second number switched on is not the default unless asked', async () => {
    await put(HATCH, { numberId: NUM_A, on: true })
    await put(HATCH, { numberId: NUM_B, on: true })
    expect(defaultAt(HATCH)).toEqual([NUM_A])
    expect(linksAt(HATCH)).toHaveLength(2)
  })

  it('isDefault:true clears the other default first, then sets this one', async () => {
    await put(HATCH, { numberId: NUM_A, on: true })
    state.ops = []
    const res = await put(HATCH, { numberId: NUM_B, on: true, isDefault: true })
    expect(res.status).toBe(200)
    expect(defaultAt(HATCH)).toEqual([NUM_B])
    const writes = state.ops.map((o) => `${o.op}:${o.payload?.is_default}`)
    expect(writes[0]).toBe('update:false')           // the clear comes first
    expect(writes.indexOf('insert:true')).toBeGreaterThan(0)
  })

  it('isDefault:true on an already-switched-on number moves the default', async () => {
    await put(HATCH, { numberId: NUM_A, on: true })
    await put(HATCH, { numberId: NUM_B, on: true })
    await put(HATCH, { numberId: NUM_B, on: true, isDefault: true })
    expect(defaultAt(HATCH)).toEqual([NUM_B])
  })

  it('number from another organisation is 404', async () => {
    const res = await put(HATCH, { numberId: NUM_FOREIGN, on: true })
    expect(res.status).toBe(404)
    expect(linksAt(HATCH)).toEqual([])
    // and a number that does not exist at all
    expect((await put(HATCH, { numberId: 'b0000000-0000-4000-8000-0000000000aa', on: true })).status).toBe(404)
  })

  it('the database same-organisation trigger refusing the link is a 404, not a 500', async () => {
    state.faults['location_whatsapp_numbers:insert'] = { message: 'WhatsApp number belongs to another organisation' }
    expect((await put(HATCH, { numberId: NUM_A, on: true })).status).toBe(404)
  })

  it('switching off the default promotes the newest remaining', async () => {
    state.links = [
      lnk(HATCH, NUM_A, { is_default: true, created_at: '2026-09-01T00:00:00Z' }),
      lnk(HATCH, NUM_B, { created_at: '2026-09-05T00:00:00Z' }),
      lnk(HATCH, NUM_C, { created_at: '2026-09-09T00:00:00Z' }),
    ]
    const res = await put(HATCH, { numberId: NUM_A, on: false })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(linksAt(HATCH).map((l) => l.whatsapp_number_id).sort()).toEqual([NUM_B, NUM_C])
    expect(defaultAt(HATCH)).toEqual([NUM_C])
    expect(body.data.numbers.find((n) => n.id === NUM_A)).toMatchObject({ on: false, is_default: false })
  })

  it('switching off a non-default leaves the default alone', async () => {
    state.links = [lnk(HATCH, NUM_A, { is_default: true }), lnk(HATCH, NUM_B)]
    await put(HATCH, { numberId: NUM_B, on: false })
    expect(defaultAt(HATCH)).toEqual([NUM_A])
    expect(linksAt(HATCH)).toHaveLength(1)
  })

  it('switching off the last one leaves none (no error)', async () => {
    state.links = [lnk(HATCH, NUM_A, { is_default: true })]
    const res = await put(HATCH, { numberId: NUM_A, on: false })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(linksAt(HATCH)).toEqual([])
    expect(body.data.numbers.every((n) => n.on === false && n.is_default === false)).toBe(true)
  })

  it('switching off a number that was never on is a no-op', async () => {
    const res = await put(HATCH, { numberId: NUM_B, on: false })
    expect(res.status).toBe(200)
    expect(state.ops).toEqual([])
  })

  it('a failed write is a 500 with the message, never a silent success', async () => {
    state.faults['location_whatsapp_numbers:insert'] = { message: 'boom' }
    const res = await put(HATCH, { numberId: NUM_A, on: true })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })

  it('a failed promote after a switch-off is a 500', async () => {
    state.links = [lnk(HATCH, NUM_A, { is_default: true }), lnk(HATCH, NUM_B)]
    state.faults['location_whatsapp_numbers:update'] = { message: 'nope' }
    expect((await put(HATCH, { numberId: NUM_A, on: false })).status).toBe(500)
  })

  it('a failed insert after the old default was cleared puts the old default back', async () => {
    await put(HATCH, { numberId: NUM_A, on: true })
    state.faults['location_whatsapp_numbers:insert'] = { message: 'boom' }
    const res = await put(HATCH, { numberId: NUM_B, on: true, isDefault: true })
    expect(res.status).toBe(500)
    expect(defaultAt(HATCH)).toEqual([NUM_A])
  })
})

describe('POST /api/locations/[id]/whatsapp/numbers (retired)', () => {
  it('old location POST answers 410 with moved_to', async () => {
    const res = await post()
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      success: false,
      error: 'WhatsApp numbers are managed at the organisation now.',
      moved_to: '/settings/whatsapp-numbers',
    })
  })

  it('a signed-out caller still gets 401, not the pointer', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })
})
