import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => ({
  // SECFIX.3a — the PUT case below needs the REAL per-location role helpers
  // (pure: role-at-location); the GET cases never reach them.
  ...(await vi.importActual('@/lib/role-at-location')),
  getCurrentUser: vi.fn(),
  getUserLocationIds: (u) => (u?.locations || []).map(l => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/staff', () => ({ getStaffForUser: vi.fn() }))
// SECFIX.3a — the PUT's side effects, stubbed as in route.login-access.test.js.
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(async () => ({ configured: false })),
  revokeUnifiUserPolicies: vi.fn(),
  findOrCreateUnifiUser: vi.fn(),
  syncUnifiUserPolicyForRole: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getStaffForUser } from '@/lib/staff'
import { getUnifiConfig } from '@/lib/unifi-access'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { STAFF_MANAGED_SELECT } from '@/lib/staff-fields'

const req = () => new Request('http://localhost/api/staff/p1')
const props = { params: { id: 'p1' } }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/staff/[id]', () => {
  it('401 when not authenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req(), props)
    expect(res.status).toBe(401)
    expect(getStaffForUser).not.toHaveBeenCalled()
  })
  it('404 when the service reports cross-tenant / missing', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: false, status: 404, error: 'Not found' })
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })
  it('200 with the profile when the service returns it', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: true, data: { id: 'p1', full_name: 'Ada' } })
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.full_name).toBe('Ada')
    expect(getStaffForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })
})

// SECFIX.3a — every read in PUT embeds profile_locations(*, locations(*)).
// The RAW embed must still reach the UniFi door revoke (getUnifiConfig falls
// back to the row's settings.unifi token), but the response is redacted: the
// final re-read used to be echoed to the browser whole.
describe('PUT /api/staff/[id] — SECFIX.3a: the echo carries no location credential', () => {
  const ID = '10000000-0000-0000-0000-000000000003'
  const MASTER = { id: 'master-1', isMaster: true, role: 'master', full_name: 'Master One', email: 'master@example.test', rolesByLocation: {} }
  const SECRET_LOC = {
    id: 'loc-1', name: 'Studio One', sensibo_api_key: 'SYNTH-S', thinq_pat: 'SYNTH-T',
    settings: {
      glofox: { branch_id: 'b1', api_key: 'SYNTH-GK', api_token: 'SYNTH-GT', webhook_secret: 'SYNTH-GW' },
      unifi: { host: 'https://unifi.example', api_token: 'SYNTH-UT' },
    },
  }

  it('deactivating: the door revoke reads the raw row, the 200 body carries only the mask', async () => {
    let current = {
      id: ID, email: 'coach@example.test', full_name: 'A Coach', role: 'staff', active: true, deleted_at: null,
      unifi_door_access: true, permissions: {}, employment_type: 'fte',
      pin_hash: 'SYNTH-PIN-HASH', home_screen_path: '/x', annual_salary: 40000,
      profile_locations: [{ location_id: 'loc-1', role: 'staff', unifi_door_access: true, unifi_user_id: 'uu-1', locations: SECRET_LOC }],
    }
    const db = fakeDb((q) => {
      if (q.table === 'profiles' && q.action === 'select') return { data: current, error: null }
      if (q.table === 'profiles' && q.action === 'update') { current = { ...current, ...q.payload }; return { data: null, error: null } }
      if (q.table === 'location_role_permissions') return { data: [], error: null }
      return { data: null, error: null }
    })
    db.auth = { admin: { updateUserById: vi.fn(async () => ({ data: {}, error: null })), getUserById: vi.fn(async () => ({ data: { user: { id: ID, banned_until: null } }, error: null })) } }
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(MASTER)

    const res = await PUT(new Request(`http://localhost/api/staff/${ID}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: false }),
    }), { params: Promise.resolve({ id: ID }) })

    expect(res.status).toBe(200)
    // The server-side consumer still gets the value it needs.
    expect(getUnifiConfig).toHaveBeenCalledWith(db, SECRET_LOC)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/SYNTH-/)
    // STAFFPROFILEPICK.1 — the echo is the named managed shape: no settings
    // at all (the mask only proved presence), no PIN hash, no UniFi id.
    expect(body.data.profile_locations[0].locations).not.toHaveProperty('settings')
    expect(body.data.profile_locations[0]).not.toHaveProperty('unifi_user_id')
    expect(body.data).not.toHaveProperty('pin_hash')
    expect(body.data).not.toHaveProperty('home_screen_path')
    expect(body.data.annual_salary).toBe(40000)
    const selects = db.queries.filter((q) => q.table === 'profiles' && q.action === 'select').map((q) => q.columns)
    expect(selects.at(-1)).toBe(STAFF_MANAGED_SELECT)
    // The server-side reads stay whole: the door revoke still gets the raw row.
    expect(selects[0]).toMatch(/^\*, profile_locations\(\*, locations\(\*\)\)$/)
    expect(body.data.profile_locations[0].locations.name).toBe('Studio One')
  })
})
