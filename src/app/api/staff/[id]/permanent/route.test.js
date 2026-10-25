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

function makeDb({ profile = PROFILE, rpcData = SUMMARY, rpcError = null, contact = null, hostUser = null, identityError = null, authError = null, recordError = null } = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'profiles' && q.action === 'select') return { data: profile, error: profile ? null : { message: 'no rows' } }
    // The ONLY profiles write this route makes: recording the finished login step.
    if (q.table === 'profiles' && q.action === 'update') return { data: recordError ? null : [{ id: ID }], error: recordError }
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
  it('400 while still active; 404 for an id that never existed', async () => {
    let db = makeDb({ profile: { ...PROFILE, active: true } }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(400)
    db = makeDb({ profile: null }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(404)
    expect(db.rpc).not.toHaveBeenCalled()
  })
  it('GET still 404s an existing tombstone — there is nothing left to preview', async () => {
    const db = makeDb({ profile: { ...PROFILE, deleted_at: '2026-09-01T00:00:00Z' } }); createServerClient.mockReturnValue(db)
    expect((await GET(req(), props)).status).toBe(404)
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
    // The hand-written FK null-out list is gone: no attribution column is
    // touched. The one UPDATE is the login step being recorded on the tombstone.
    const updates = db.queries.filter((q) => q.action === 'update')
    expect(updates.map((q) => q.table)).toEqual(['profiles'])
    expect(updates[0].payload).toEqual({ auth_disposition: 'ban', auth_completed_at: expect.any(String) })
    expect(updates[0].eq).toEqual({ id: ID })
    expect(updates[0].calls).toContainEqual(['is', 'auth_completed_at', null])
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

// The ban runs AFTER the tombstone commits, so it can fail, or the process can
// die before it. Every retry used to 404 (a tombstone is "not found"), leaving
// the ban to be finished by hand. DELETE on an EXISTING tombstone now re-runs
// ONLY the login step.
describe('DELETE /api/staff/[id]/permanent — the login step is retryable', () => {
  const TOMB = { ...PROFILE, deleted_at: '2026-09-19T10:00:00Z', profile_locations: [], auth_disposition: null, auth_completed_at: null }

  it('ban fails → warned and NOT recorded; the retry bans, records, and re-runs nothing else', async () => {
    let db = makeDb({ authError: { message: 'gotrue down' } }); createServerClient.mockReturnValue(db)
    const first = await (await DELETE(req(), props)).json()
    expect(first).toMatchObject({ success: true, data: { auth: 'ban', auth_completed: false } })
    expect(first.warning).toContain('gotrue down')
    expect(queriesOf(db, 'profiles', 'update')).toEqual([])   // half-finished stays VISIBLE: auth_completed_at NULL

    vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER)
    db = makeDb({ profile: TOMB }); createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    const retry = await res.json()
    expect(retry).toMatchObject({ success: true, data: { profile_id: ID, already_deleted: true, auth: 'ban', auth_completed: true } })
    expect(retry.warning).toBeUndefined()
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.auth.admin.updateUserById).toHaveBeenCalledTimes(1)
    expect(db.auth.admin.updateUserById.mock.calls[0][1]).toMatchObject({ email: `deleted+${ID}@deleted.invalid`, ban_duration: '876000h' })
    expect(queriesOf(db, 'profiles', 'update')[0].payload).toEqual({ auth_disposition: 'ban', auth_completed_at: expect.any(String) })
    // Nothing else is repeated: no second change-log row, no notifications, no storage sweep.
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('a retry follows the SAME disposition rules: a member login is kept, and that is final', async () => {
    const db = makeDb({ profile: TOMB, contact: { id: 'c1' } }); createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(body.data).toMatchObject({ already_deleted: true, auth: 'kept_member_login', auth_completed: true })
    expect(queriesOf(db, 'profiles', 'update')[0].payload.auth_disposition).toBe('kept_member_login')
  })

  it('"could not tell" is NOT final: nothing is recorded, so a later retry can still resolve it', async () => {
    const db = makeDb({ profile: TOMB, identityError: { message: 'boom' } }); createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(body.data).toMatchObject({ auth: 'kept_unverified', auth_completed: false })
    expect(body.warning).toBeTruthy()
    expect(queriesOf(db, 'profiles', 'update')).toEqual([])
  })

  it('a retry on a COMPLETED tombstone is a no-op, and says so truthfully', async () => {
    const db = makeDb({ profile: { ...TOMB, auth_disposition: 'ban', auth_completed_at: '2026-09-19T10:00:05Z' } }); createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { profile_id: ID, full_name: 'Former Coach', already_deleted: true, auth: 'ban', auth_completed: true, auth_completed_at: '2026-09-19T10:00:05Z', changed: false },
    })
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(db.queries.filter((q) => q.action !== 'select')).toEqual([])
  })

  it('the ban landed but RECORDING it failed → warned, and still retryable', async () => {
    const db = makeDb({ profile: TOMB, recordError: { message: 'write failed' } }); createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.auth_completed).toBe(false)
    expect(body.warning).toContain('write failed')
  })

  it('two masters at once: the function answers already_tombstoned → only the login step runs', async () => {
    const db = makeDb({ rpcData: { profile_id: ID, full_name: 'Former Coach', already_tombstoned: true, removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [] } })
    createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(body.data).toMatchObject({ already_deleted: true, auth: 'ban', auth_completed: true })
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
    expect(notifyUsersAtRolesOnce).not.toHaveBeenCalled()
  })
})

describe('GET /api/staff/[id]/permanent — impact preview', () => {
  it('previews a KEPT login truthfully', async () => {
    for (const [opts, expected] of [[{ contact: { id: 'c1' } }, 'kept_member_login'], [{ hostUser: { host_id: 'h1' } }, 'kept_host_login'], [{ identityError: { message: 'boom' } }, 'kept_unverified']]) {
      const db = makeDb({ ...opts, rpcData: { ...SUMMARY, dry_run: true } }); createServerClient.mockReturnValue(db)
      expect((await (await GET(req(), props)).json()).data.auth).toBe(expected)
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    }
  })

  it('master only; runs the SAME function as a dry run and changes nothing', async () => {
    const db = makeDb({ rpcData: { ...SUMMARY, dry_run: true } }); createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith('tombstone_staff_profile', expect.objectContaining({ p_dry_run: true }))
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
    const preview = (await res.json()).data
    expect(preview.removed_shifts).toHaveLength(2)
    // What will happen to their LOGIN is part of the preview (read-only: no ban, nothing recorded).
    expect(preview.auth).toBe('ban')
    expect(queriesOf(db, 'profiles', 'update')).toEqual([])
    // Today's already-started shifts and the demotion ride through untouched.
    expect(preview.kept_today_shifts).toHaveLength(1)
    expect(preview.role).toEqual({ from: 'manager', to: 'staff' })

    getCurrentUser.mockResolvedValue({ id: 'o', isMaster: false })
    expect((await GET(req(), props)).status).toBe(403)
  })
})
