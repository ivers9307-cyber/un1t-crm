// WAORGNUMBER.3 (R6) — a studio edits the reply customers get for STOP / START.

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
import { DEFAULT_CONSENT_COPY } from '@/lib/whatsapp-consent-copy'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const STILL = 'a0000000-0000-4000-8000-000000000001'

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const put = (loc, body) => PUT(
  new Request(`http://x/api/locations/${loc}/whatsapp/consent-copy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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
    { id: HATCH, name: 'UN1T Hatch Street', settings: { glofox: { branch: 'x' }, whatsapp_purpose_templates: { class_confirmed: 't1' } } },
    { id: STILL, name: 'UN1T Stillorgan', settings: {} },
  ]
})

describe('GET /api/locations/[id]/whatsapp/consent-copy', () => {
  it('returns nulls (defaults in use), the defaults, the studio name and can_edit', async () => {
    const j = await (await GET(new Request('http://x'), ctx(HATCH))).json()
    expect(j.data).toEqual({
      copy: { stop_ack: null, start_ack: null },
      defaults: DEFAULT_CONSENT_COPY,
      studio_name: 'UN1T Hatch Street',
      can_edit: true,
    })
  })

  it('a staff member sees it read-only', async () => {
    getCurrentUser.mockResolvedValue(user('staff'))
    const j = await (await GET(new Request('http://x'), ctx(HATCH))).json()
    expect(j.data.can_edit).toBe(false)
  })

  it('a failed read is a 500, not the defaults', async () => {
    state.fail = 'locations'
    expect((await GET(new Request('http://x'), ctx(HATCH))).status).toBe(500)
  })
})

describe('PUT /api/locations/[id]/whatsapp/consent-copy', () => {
  it('head_coach 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(user('head_coach'))
    expect((await put(HATCH, { stop_ack: 'x', start_ack: null })).status).toBe(403)
    expect(state.writes).toEqual([])
  })

  it('an owner at another studio is 403 here (role judged at the path id)', async () => {
    getCurrentUser.mockResolvedValue(user('owner', STILL))
    expect((await put(HATCH, { stop_ack: 'x', start_ack: null })).status).toBe(403)
    expect(state.writes).toEqual([])
  })

  it('a caller without access to the studio gets the access guard', async () => {
    assertLocationAccess.mockReturnValue(new Response(JSON.stringify({ success: false }), { status: 403 }))
    expect((await put(HATCH, { stop_ack: 'x', start_ack: null })).status).toBe(403)
    expect(state.writes).toEqual([])
  })

  it('saves the copy, merged, leaving sibling settings keys alone', async () => {
    const res = await put(HATCH, { stop_ack: '  Done. {studio} will not message you.  ', start_ack: '' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.copy).toEqual({ stop_ack: 'Done. {studio} will not message you.', start_ack: null })
    expect(j.data.studio_name).toBe('UN1T Hatch Street')
    const written = state.writes.at(-1).patch.settings
    expect(written.glofox).toEqual({ branch: 'x' })
    expect(written.whatsapp_purpose_templates).toEqual({ class_confirmed: 't1' })
    expect(written.whatsapp_consent_copy).toEqual({ stop_ack: 'Done. {studio} will not message you.', start_ack: null })
  })

  it('refuses a reply over 500 characters, nothing written', async () => {
    expect((await put(HATCH, { stop_ack: 'x'.repeat(501), start_ack: null })).status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('a failed settings read writes nothing', async () => {
    state.fail = 'locations'
    const res = await put(HATCH, { stop_ack: 'x', start_ack: null })
    expect(res.ok).toBe(false)
    expect(state.writes).toEqual([])
  })
})
