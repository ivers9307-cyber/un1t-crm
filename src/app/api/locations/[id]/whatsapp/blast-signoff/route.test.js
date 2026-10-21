// ORGCONTACTS.0 (spec §3.3, decision 6) — the blast sign-off date gets a UI.
// Master or an org admin of the studio's organisation sets or clears
// locations.settings.whatsapp_blast_signoff_until; a manager may read it but
// not change it (the window exists to bind managers).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {}
vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server')
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // The real rule (src/lib/auth.js): master passes, an org_admin grant on that org passes.
    assertOrganizationAdmin: (user, orgId) => {
      if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      if (user.isMaster) return null
      if (orgId && (user.orgAdminOrgIds || []).includes(orgId)) return null
      return NextResponse.json({ success: false, error: 'Master or organization admin role required.' }, { status: 403 })
    },
  }
})
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
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const ORG = 'f0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'f0000000-0000-4000-8000-000000000002'

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const get = (loc) => GET(new Request(`http://x/api/locations/${loc}/whatsapp/blast-signoff`), ctx(loc))
const put = (loc, body) => PUT(
  new Request(`http://x/api/locations/${loc}/whatsapp/blast-signoff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  ctx(loc),
)
const manager = () => ({ id: 'u1', role: 'manager', profileRole: 'staff', rolesByLocation: { [HATCH]: 'manager' }, orgAdminOrgIds: [] })
const orgAdmin = (orgId = ORG) => ({ id: 'u2', role: 'owner', profileRole: 'staff', rolesByLocation: { [HATCH]: 'owner' }, orgAdminOrgIds: [orgId] })
const master = () => ({ id: 'u3', role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {}, orgAdminOrgIds: [] })

beforeEach(() => {
  vi.clearAllMocks()
  assertLocationAccess.mockReturnValue(null)
  getCurrentUser.mockResolvedValue(manager())
  state.fail = null
  state.writes = []
  state.locations = [
    { id: HATCH, organization_id: ORG, settings: { glofox: { branch: 'x' }, whatsapp_blast_signoff_until: '2026-11-16' } },
  ]
})

describe('GET /api/locations/[id]/whatsapp/blast-signoff', () => {
  it('returns the stored date; a manager may read but not edit', async () => {
    const res = await get(HATCH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { until: '2026-11-16', can_edit: false } })
  })
  it('returns null when unset or not a plain date; an org admin may edit', async () => {
    state.locations[0].settings = { glofox: { branch: 'x' } }
    getCurrentUser.mockResolvedValue(orgAdmin())
    expect((await (await get(HATCH)).json()).data).toEqual({ until: null, can_edit: true })
    state.locations[0].settings = { whatsapp_blast_signoff_until: 'soon' }
    expect((await (await get(HATCH)).json()).data.until).toBeNull()
  })
  it('a signed-out caller is 401; the access guard answers for a studio outside the caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(HATCH)).status).toBe(401)
    getCurrentUser.mockResolvedValue(manager())
    assertLocationAccess.mockReturnValue(new Response(JSON.stringify({ success: false }), { status: 403 }))
    expect((await get(HATCH)).status).toBe(403)
  })
})

describe('PUT /api/locations/[id]/whatsapp/blast-signoff', () => {
  it('an org admin stores the date and keeps the other settings keys', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    const res = await put(HATCH, { until: '2026-12-01' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { until: '2026-12-01', can_edit: true } })
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0].patch.settings).toEqual({ glofox: { branch: 'x' }, whatsapp_blast_signoff_until: '2026-12-01' })
  })
  it('a master stores it too', async () => {
    getCurrentUser.mockResolvedValue(master())
    expect((await put(HATCH, { until: '2026-12-01' })).status).toBe(200)
  })
  it('null clears it (the key is removed, siblings kept)', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    const res = await put(HATCH, { until: null })
    expect((await res.json()).data.until).toBeNull()
    expect(state.writes[0].patch.settings).toEqual({ glofox: { branch: 'x' } })
  })
  it('a manager gets 403 and nothing is written', async () => {
    expect((await put(HATCH, { until: '2026-12-01' })).status).toBe(403)
    expect(state.writes).toEqual([])
  })
  it("an org admin of another organisation gets 403", async () => {
    getCurrentUser.mockResolvedValue(orgAdmin(OTHER_ORG))
    expect((await put(HATCH, { until: '2026-12-01' })).status).toBe(403)
    expect(state.writes).toEqual([])
  })
  it('a bad date is 400', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    expect((await put(HATCH, { until: '16/11/2026' })).status).toBe(400)
    expect((await put(HATCH, { until: '2026-02-30' })).status).toBe(400)
    expect(state.writes).toEqual([])
  })
  it('a studio that cannot be read is 404 for an org admin (never 500 with a hint)', async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    state.locations = []
    expect((await put(HATCH, { until: '2026-12-01' })).status).toBe(404)
  })
})
