// src/app/api/staff/[id]/route.login-access.test.js
// ACTIVEUSER.1 — deactivating must actually END the person's sessions, and
// reactivating must restore them. The rules live in @/lib/staff-login-access
// (real here, against a fake auth admin); this file pins how the two routes
// that flip `profiles.active` drive it:
//   DELETE /api/staff/[id]            the Deactivate button
//   PUT    /api/staff/[id] {active}   the form's Active toggle + Reactivate
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(async () => ({ configured: false })),
  revokeUnifiUserPolicies: vi.fn(),
  findOrCreateUnifiUser: vi.fn(),
  syncUnifiUserPolicyForRole: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { getUnifiConfig, revokeUnifiUserPolicies } = await import('@/lib/unifi-access')
const { logAuditEvent } = await import('@/lib/audit')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { AUTH_BAN_DURATION } = await import('@/lib/staff-tombstone')
const { PUT, DELETE } = await import('./route.js')

const ID = '10000000-0000-0000-0000-000000000003'
const MASTER = { id: 'master-1', isMaster: true, role: 'master', full_name: 'Master One', email: 'master@example.test', rolesByLocation: {} }
const PROFILE = {
  id: ID, email: 'coach@example.test', full_name: 'A Coach', role: 'staff', active: true, deleted_at: null,
  unifi_door_access: false, permissions: {}, employment_type: 'fte',
  profile_locations: [{ location_id: 'loc-1', role: 'staff', unifi_door_access: false, locations: { id: 'loc-1', name: 'Studio One' } }],
}

// `events` records profiles writes and auth-admin calls in ONE list, so a test
// can assert the ORDER: the ban must come after the deactivation has landed.
function makeDb({ profile = PROFILE, writeError = null, contact = null, hostUser = null, banError = null, authUser = null } = {}) {
  const events = []
  let current = profile
  const db = fakeDb((q) => {
    if (q.table === 'profiles' && q.action === 'select') return { data: current, error: current ? null : { message: 'no rows' } }
    if (q.table === 'profiles' && q.action === 'update') {
      events.push(['profiles.update', q.payload])
      if (writeError) return { data: null, error: writeError }
      current = { ...current, ...q.payload }
      return { data: null, error: null }
    }
    if (q.table === 'profile_locations' && q.action === 'update') return { data: null, error: null }
    if (q.table === 'contacts') return { data: contact, error: null }
    if (q.table === 'host_users') return { data: hostUser, error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  db.auth = {
    admin: {
      updateUserById: vi.fn(async (id, patch) => { events.push(['auth.update', patch]); return { data: {}, error: banError } }),
      getUserById: vi.fn(async () => { events.push(['auth.read']); return { data: { user: authUser || { id: ID, banned_until: null } }, error: null } }),
      deleteUser: vi.fn(),
    },
  }
  db.events = events
  return db
}

const del = () => new Request(`http://localhost/api/staff/${ID}`, { method: 'DELETE' })
const put = (body) => new Request(`http://localhost/api/staff/${ID}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: ID }) }
const use = (db) => { createServerClient.mockReturnValue(db); return db }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('DELETE /api/staff/[id] — deactivate ends the sessions', () => {
  it('writes active=false FIRST, then bans the login — and only bans it', async () => {
    const db = use(makeDb())
    const res = await DELETE(del(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { login: 'banned' } })
    expect(db.events).toEqual([
      ['profiles.update', { active: false, unifi_door_access: false }],
      ['auth.update', { ban_duration: AUTH_BAN_DURATION }],
    ])
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it('a REFUSED deactivation (mig 080: the last active master) bans nobody', async () => {
    const db = use(makeDb({ writeError: { message: 'Cannot deactivate the last active master' } }))
    const res = await DELETE(del(), props)
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('a FAILED ban does not fail or undo the deactivation: success + a warning the UI can show', async () => {
    const db = use(makeDb({ banError: { message: 'gotrue 500' } }))
    const res = await DELETE(del(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({ login: 'ban_failed' })
    expect(body.warning).toMatch(/Staff access is off/)
    // Nothing flips `active` back.
    expect(queriesOf(db, 'profiles', 'update').map((q) => q.payload)).toEqual([{ active: false, unifi_door_access: false }])
    // The audit row records what really happened to the login.
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'profile.deactivated', details: { via: 'staff_delete', login: 'ban_failed' },
    }))
  })

  it('a login that is ALSO a gym member is left alone, and the operator is told', async () => {
    const db = use(makeDb({ contact: { id: 'c1' } }))
    const body = await (await DELETE(del(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({ login: 'kept_member_login' })
    expect(body.warning).toMatch(/also a gym member/)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('deactivating an ALREADY inactive profile is the retry: it bans again, idempotently', async () => {
    const db = use(makeDb({ profile: { ...PROFILE, active: false } }))
    expect((await DELETE(del(), props)).status).toBe(200)
    expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(ID, { ban_duration: AUTH_BAN_DURATION })
  })

  it('a tombstone is 404: never re-deactivated, never banned or unbanned from here', async () => {
    const db = use(makeDb({ profile: { ...PROFILE, active: false, deleted_at: '2026-09-19T10:00:00Z' } }))
    expect((await DELETE(del(), props)).status).toBe(404)
    expect(db.events).toEqual([])
  })

  it('an id that does not exist is 404 (it used to answer success having changed nothing)', async () => {
    const db = use(makeDb({ profile: null }))
    expect((await DELETE(del(), props)).status).toBe(404)
    expect(db.events).toEqual([])
  })

  it('a UniFi revoke failure still aborts BEFORE anything is written or banned', async () => {
    getUnifiConfig.mockResolvedValueOnce({ configured: true })
    revokeUnifiUserPolicies.mockRejectedValueOnce(new Error('controller offline'))
    const db = use(makeDb({
      profile: { ...PROFILE, profile_locations: [{ ...PROFILE.profile_locations[0], unifi_door_access: true, unifi_user_id: 'u-1' }] },
    }))
    expect((await DELETE(del(), props)).status).toBe(502)
    expect(db.events).toEqual([])
  })

  it('guards are unchanged: 401, 403 for a non-owner, 400 for yourself', async () => {
    const db = use(makeDb())
    getCurrentUser.mockResolvedValue(null)
    expect((await DELETE(del(), props)).status).toBe(401)
    getCurrentUser.mockResolvedValue({ id: 'm', isMaster: false, role: 'manager' })
    expect((await DELETE(del(), props)).status).toBe(403)
    getCurrentUser.mockResolvedValue({ ...MASTER, id: ID })
    expect((await DELETE(del(), props)).status).toBe(400)
    expect(db.events).toEqual([])
  })
})

describe('PUT /api/staff/[id] — the Active toggle and the Reactivate button', () => {
  it('active:false bans after the profile write', async () => {
    const db = use(makeDb())
    const res = await PUT(put({ active: false }), props)
    expect(res.status).toBe(200)
    expect(db.events).toEqual([
      ['profiles.update', { active: false }],
      ['auth.update', { ban_duration: AUTH_BAN_DURATION }],
    ])
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning).toBeUndefined()
  })

  it('active:false whose write is REFUSED bans nobody', async () => {
    const db = use(makeDb({ writeError: { message: 'Cannot deactivate the last active master' } }))
    expect((await PUT(put({ active: false }), props)).status).toBe(400)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('active:false with a failed ban still succeeds, with the warning', async () => {
    use(makeDb({ banError: { message: 'gotrue 500' } }))
    const res = await PUT(put({ active: false }), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.active).toBe(false)
    expect(body.warning).toMatch(/disabling their login failed/)
  })

  it('active:true on an INACTIVE profile lifts the ban (no read first)', async () => {
    const db = use(makeDb({ profile: { ...PROFILE, active: false } }))
    const res = await PUT(put({ active: true }), props)
    expect(res.status).toBe(200)
    expect(db.events).toEqual([
      ['profiles.update', { active: true }],
      ['auth.update', { ban_duration: 'none' }],
    ])
  })

  it('a FAILED unban is an ERROR (502, login_restore_failed) — the person cannot sign in — and the profile stays reactivated', async () => {
    const db = use(makeDb({ profile: { ...PROFILE, active: false }, banError: { message: 'gotrue 500' } }))
    const res = await PUT(put({ active: true }), props)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.login_restore_failed).toBe(true)
    expect(body.error).toMatch(/cannot sign in/)
    expect(queriesOf(db, 'profiles', 'update').map((q) => q.payload)).toEqual([{ active: true }])
  })

  it('THE RETRY: active:true on an already-active profile that is STILL banned lifts the ban', async () => {
    const db = use(makeDb({ authUser: { id: ID, banned_until: '2126-01-01T00:00:00Z' } }))
    expect((await PUT(put({ active: true }), props)).status).toBe(200)
    expect(db.events).toContainEqual(['auth.read'])
    expect(db.events).toContainEqual(['auth.update', { ban_duration: 'none' }])
  })

  it('an ordinary save of an active, unbanned profile reads the ban state and writes NOTHING to the login', async () => {
    const db = use(makeDb())
    expect((await PUT(put({ active: true, full_name: 'A Coach' }), props)).status).toBe(200)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('a save that does not mention `active` (mobile) never touches the auth admin API', async () => {
    const db = use(makeDb())
    expect((await PUT(put({ full_name: 'Renamed Coach' }), props)).status).toBe(200)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(db.auth.admin.getUserById).not.toHaveBeenCalled()
  })

  it('a tombstone is still 404 and its login is never touched', async () => {
    const db = use(makeDb({ profile: { ...PROFILE, active: false, deleted_at: '2026-09-19T10:00:00Z' } }))
    expect((await PUT(put({ active: true }), props)).status).toBe(404)
    expect(db.events).toEqual([])
  })
})
