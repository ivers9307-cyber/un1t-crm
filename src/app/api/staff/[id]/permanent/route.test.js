// src/app/api/staff/[id]/permanent/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(async () => ({ configured: false })),
  revokeUnifiUserPolicies: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({
  notifyUsersOnce: vi.fn(async () => ({})),
  notifyUsersAtRolesOnce: vi.fn(async () => ({})),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET, DELETE } = await import('./route.js')

const ID = '10000000-0000-0000-0000-000000000001'
const MASTER = { id: 'master-1', isMaster: true, full_name: 'Master One', email: 'master@example.test' }
const PROFILE = {
  id: ID, email: 'former.coach@example.test', full_name: 'Former Coach', role: 'staff', active: false, deleted_at: null,
  profile_locations: [{ location_id: 'loc-1', role: 'staff', unifi_door_access: false, locations: { id: 'loc-1', name: 'Studio One' } }],
}
const SUMMARY = {
  profile_id: ID, full_name: 'Former Coach', dry_run: false,
  removed_shifts: [
    { assignment_id: 'a1', block_date: '2026-10-05', location_id: 'loc-1', roster_status: 'published' },
    { assignment_id: 'a2', block_date: '2026-10-06', location_id: 'loc-1', roster_status: 'draft' },
  ],
  cancelled_swaps: [{ id: 's1', requester_id: 'peer-1', target_id: ID, location_id: 'loc-1' }],
  cancelled_time_off: [],
  kept_today_shifts: [{ assignment_id: 'a0', block_date: '2026-09-19', location_id: 'loc-1', roster_status: 'published' }],
  role: { from: 'manager', to: 'staff' },
  deleted: { profile_locations: 1 },
  kept: { past_shifts: 40, time_off_requests: 3, contractor_invoices: 2 },
}

function makeDb({ profile = PROFILE, rpcData = SUMMARY, rpcError = null, contact = null, hostUser = null, identityError = null, authError = null } = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'profiles' && q.action === 'select') return { data: profile, error: profile ? null : { message: 'no rows' } }
    if (q.table === 'contacts') return { data: contact, error: identityError }
    if (q.table === 'host_users') return { data: hostUser, error: identityError }
    if (q.table === 'assignment_change_log' && q.action === 'insert') return { data: null, error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  db.rpc = vi.fn(async () => ({ data: rpcData, error: rpcError }))
  db.auth = { admin: { updateUserById: vi.fn(async () => ({ data: {}, error: authError })), deleteUser: vi.fn() } }
  const remove = vi.fn(async () => ({ error: null }))
  db.storage = { from: vi.fn(() => ({ list: async () => ({ data: [{ name: 'photo.jpg' }], error: null }), remove })) }
  db.__remove = remove
  return db
}

const req = () => new Request(`http://localhost/api/staff/${ID}/permanent`, { method: 'DELETE' })
const props = { params: Promise.resolve({ id: ID }) }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('DELETE /api/staff/[id]/permanent — guards', () => {
  it('401 / 403 / 400-self, and nothing is called', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(null)
    expect((await DELETE(req(), props)).status).toBe(401)
    getCurrentUser.mockResolvedValue({ id: 'o', isMaster: false })
    expect((await DELETE(req(), props)).status).toBe(403)
    getCurrentUser.mockResolvedValue({ ...MASTER, id: ID })
    expect((await DELETE(req(), props)).status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })
  it('400 while still active; 404 for a missing profile AND for one already deleted', async () => {
    let db = makeDb({ profile: { ...PROFILE, active: true } }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(400)
    db = makeDb({ profile: null }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(404)
    db = makeDb({ profile: { ...PROFILE, deleted_at: '2026-09-01T00:00:00Z' } }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(404)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/staff/[id]/permanent — the tombstone', () => {
  it('calls the function (which reads the clock itself — no app-side "today"), and NEVER deletes the profile or the auth user', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    // p_now is NOT passed: mig 622 defaults it to the database's now() and
    // derives the Dublin date AND time of day from that one instant.
    expect(db.rpc).toHaveBeenCalledWith('tombstone_staff_profile', {
      p_profile_id: ID, p_actor_id: 'master-1', p_dry_run: false,
    })
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(db.queries.filter((q) => q.action === 'delete')).toEqual([])
    // The hand-written FK null-out list is gone: no attribution column is touched.
    expect(db.queries.filter((q) => q.action === 'update')).toEqual([])
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { auth: 'ban', removed_shifts: SUMMARY.removed_shifts, kept: SUMMARY.kept } })
  })

  it('bans and scrambles a staff-only login', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    const [id, attrs] = db.auth.admin.updateUserById.mock.calls[0]
    expect(id).toBe(ID)
    expect(attrs).toMatchObject({ email: `deleted+${ID}@deleted.invalid`, email_confirm: true, ban_duration: '876000h', user_metadata: { full_name: null } })
    expect(attrs.password).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves the login alone when the same person is a member, a host, or we could not tell', async () => {
    for (const [opts, expected] of [
      [{ contact: { id: 'c1' } }, 'kept_member_login'],
      [{ hostUser: { host_id: 'h1' } }, 'kept_host_login'],
      [{ identityError: { message: 'boom' } }, 'kept_unverified'],
    ]) {
      const db = makeDb(opts); createServerClient.mockReturnValue(db)
      const body = await (await DELETE(req(), props)).json()
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
      expect(body.data.auth).toBe(expected)
      expect(body.warning).toBeTruthy()
    }
  })

  it('maps the function\'s errors and stops before touching auth, storage or the log', async () => {
    const db = makeDb({ rpcData: null, rpcError: { message: 'staff_still_active: deactivate the profile before deleting it' } })
    createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(400)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
  })

  it('a failed ban is a WARNING, not a failure — the tombstone already exists', async () => {
    const db = makeDb({ authError: { message: 'gotrue down' } }); createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toContain('gotrue down')
  })

  it('records role history WITHOUT the email, after the function succeeded', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    const [log] = queriesOf(db, 'assignment_change_log', 'insert')
    expect(log.payload).toMatchObject({ actor_id: 'master-1', target_profile_id: ID, action: 'permanent_delete' })
    // The role is the one read BEFORE the function demoted it.
    expect(log.payload.before).toEqual({ full_name: 'Former Coach', role: 'staff', assignments: [{ location_id: 'loc-1', location_name: 'Studio One', role: 'staff' }] })
    expect(JSON.stringify(log.payload)).not.toContain('example.test')
  })

  it('tells each studio\'s managers what needs cover (published only) and the other side of each cancelled swap', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [, key, locationId, , payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(key).toBe(`staff_deleted_cover:${ID}:loc-1`)
    expect(locationId).toBe('loc-1')
    expect(payload.body).toBe('Former Coach was removed from 1 upcoming shift (from 2026-10-05). Open the roster to arrange cover.')
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'swap_cancelled_staff_deleted:s1', ['peer-1'], expect.objectContaining({ category: 'swap' }))
  })

  it('removes the public signature photo', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    expect(db.storage.from).toHaveBeenCalledWith('branding')
    expect(db.__remove).toHaveBeenCalledWith([`signatures/${ID}/photo.jpg`])
  })
})

describe('GET /api/staff/[id]/permanent — impact preview', () => {
  it('master only; runs the SAME function as a dry run and changes nothing', async () => {
    const db = makeDb({ rpcData: { ...SUMMARY, dry_run: true } }); createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith('tombstone_staff_profile', expect.objectContaining({ p_dry_run: true }))
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
    const preview = (await res.json()).data
    expect(preview.removed_shifts).toHaveLength(2)
    // Today's already-started shifts and the demotion ride through untouched.
    expect(preview.kept_today_shifts).toHaveLength(1)
    expect(preview.role).toEqual({ from: 'manager', to: 'staff' })

    getCurrentUser.mockResolvedValue({ id: 'o', isMaster: false })
    expect((await GET(req(), props)).status).toBe(403)
  })
})
