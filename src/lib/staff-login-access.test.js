// src/lib/staff-login-access.test.js
// ACTIVEUSER.1 — the LOGIN side of deactivate / reactivate.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { logError } = await import('./log.js')
const { fakeDb } = await import('./time-off.test-helpers')
const { AUTH_BAN_DURATION } = await import('./staff-tombstone.js')
const {
  readLoginDisposition, suspendStaffLogin, restoreStaffLogin, isBanned, LOGIN_UNBAN,
} = await import('./staff-login-access.js')

const ID = '10000000-0000-0000-0000-000000000002'
const NOW = Date.parse('2026-09-21T12:00:00Z')

function makeDb({ contact = null, hostUser = null, identityError = null, updateError = null, authUser = { id: ID, banned_until: null }, readError = null } = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'contacts') return { data: contact, error: identityError }
    if (q.table === 'host_users') return { data: hostUser, error: identityError }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  db.auth = {
    admin: {
      updateUserById: vi.fn(async () => ({ data: {}, error: updateError })),
      getUserById: vi.fn(async () => ({ data: { user: readError ? null : authUser }, error: readError })),
      deleteUser: vi.fn(),
    },
  }
  return db
}

beforeEach(() => vi.clearAllMocks())

describe('readLoginDisposition — the same rule permanent delete uses', () => {
  it('ban for a staff-only login; kept for a member or a host; kept_unverified when either read fails', async () => {
    expect(await readLoginDisposition(makeDb(), ID)).toBe('ban')
    expect(await readLoginDisposition(makeDb({ contact: { id: 'c1' } }), ID)).toBe('kept_member_login')
    expect(await readLoginDisposition(makeDb({ hostUser: { host_id: 'h1' } }), ID)).toBe('kept_host_login')
    expect(await readLoginDisposition(makeDb({ identityError: { message: 'boom' } }), ID)).toBe('kept_unverified')
  })
  it('keys the member read on contacts.user_id and the host read on host_users.auth_user_id', async () => {
    const db = makeDb()
    await readLoginDisposition(db, ID)
    expect(db.queries.find((q) => q.table === 'contacts').eq).toEqual({ user_id: ID })
    expect(db.queries.find((q) => q.table === 'host_users').eq).toEqual({ auth_user_id: ID })
  })
})

describe('suspendStaffLogin — deactivate', () => {
  it('bans a staff-only login, and ONLY bans it: no email scramble, no password reset, never a delete', async () => {
    const db = makeDb()
    const res = await suspendStaffLogin(db, ID)
    expect(res).toEqual({ outcome: 'banned', ok: true, warning: null })
    expect(db.auth.admin.updateUserById).toHaveBeenCalledTimes(1)
    // A deactivation is REVERSIBLE: the tombstone's email/password/metadata
    // rewrite would make reactivation impossible.
    expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(ID, { ban_duration: AUTH_BAN_DURATION })
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled()
  })

  it.each([
    ['kept_member_login', { contact: { id: 'c1' } }, /also a gym member/],
    ['kept_host_login', { hostUser: { host_id: 'h1' } }, /also an event host/],
    ['kept_unverified', { identityError: { message: 'boom' } }, /could not check/],
  ])('%s: the login is left alone and the operator is told why', async (outcome, dbOpts, copy) => {
    const db = makeDb(dbOpts)
    const res = await suspendStaffLogin(db, ID)
    expect(res.outcome).toBe(outcome)
    expect(res.ok).toBe(true)
    expect(res.warning).toMatch(copy)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('a FAILED ban is a warning, never a failure: logged structurally, and it never throws', async () => {
    const db = makeDb({ updateError: { message: 'gotrue 500', status: 500 } })
    const res = await suspendStaffLogin(db, ID)
    expect(res.outcome).toBe('ban_failed')
    expect(res.ok).toBe(false)
    expect(res.warning).toMatch(/Staff access is off/)
    expect(res.warning).toMatch(/gotrue 500/)
    expect(logError).toHaveBeenCalledWith('staff-login-access', expect.any(String), expect.objectContaining({ profileId: ID }))
  })

  it('a THROWING auth client is the same warning, not an exception', async () => {
    const db = makeDb()
    db.auth.admin.updateUserById = vi.fn(async () => { throw new Error('socket hang up') })
    const res = await suspendStaffLogin(db, ID)
    expect(res.outcome).toBe('ban_failed')
    expect(res.warning).toMatch(/socket hang up/)
  })

  it('is idempotent: deactivating again simply bans again', async () => {
    const db = makeDb({ authUser: { id: ID, banned_until: '2126-01-01T00:00:00Z' } })
    expect((await suspendStaffLogin(db, ID)).outcome).toBe('banned')
    expect((await suspendStaffLogin(db, ID)).outcome).toBe('banned')
  })

  it('operator-facing copy carries no em-dash', async () => {
    for (const opts of [{ contact: { id: 'c' } }, { hostUser: { host_id: 'h' } }, { identityError: { message: 'x' } }, { updateError: { message: 'x' } }]) {
      expect((await suspendStaffLogin(makeDb(opts), ID)).warning).not.toMatch(/[—–]/)
    }
  })
})

describe('restoreStaffLogin — reactivate', () => {
  it('a real false→true transition lifts the ban without reading first', async () => {
    const db = makeDb()
    const res = await restoreStaffLogin(db, ID, { transition: true })
    expect(res).toEqual({ outcome: 'restored', ok: true, error: null })
    expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(ID, { ban_duration: LOGIN_UNBAN })
    expect(LOGIN_UNBAN).toBe('none')
    expect(db.auth.admin.getUserById).not.toHaveBeenCalled()
    // Whether the login is also a member's is irrelevant here: lifting a ban
    // that was never placed is harmless, and skipping one that WAS is a lockout.
    expect(db.queries).toEqual([])
  })

  it('a FAILED unban is an ERROR the operator must see (the person cannot sign in), with the retry spelled out', async () => {
    const db = makeDb({ updateError: { message: 'gotrue 500' } })
    const res = await restoreStaffLogin(db, ID, { transition: true })
    expect(res.outcome).toBe('restore_failed')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot sign in/)
    expect(res.error).toMatch(/again to retry/)
    expect(res.error).toMatch(/gotrue 500/)
    expect(res.error).not.toMatch(/[—–]/)
    expect(logError).toHaveBeenCalledWith('staff-login-access', expect.any(String), expect.objectContaining({ profileId: ID }))
  })

  describe('the RETRY — saving an already-active profile (no transition)', () => {
    it('still banned from a failed unban → lifts it', async () => {
      const db = makeDb({ authUser: { id: ID, banned_until: '2126-01-01T00:00:00Z' } })
      const res = await restoreStaffLogin(db, ID, { transition: false, now: NOW })
      expect(res.outcome).toBe('restored')
      expect(db.auth.admin.updateUserById).toHaveBeenCalledWith(ID, { ban_duration: 'none' })
    })
    it('not banned → nothing is written (an ordinary staff save must not touch the login)', async () => {
      const db = makeDb()
      const res = await restoreStaffLogin(db, ID, { transition: false, now: NOW })
      expect(res).toEqual({ outcome: 'not_banned', ok: true, error: null })
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    })
    it('the ban state cannot be READ → logged, and an ordinary save is NOT failed for it', async () => {
      const db = makeDb({ readError: { message: 'gotrue down' } })
      const res = await restoreStaffLogin(db, ID, { transition: false, now: NOW })
      expect(res).toEqual({ outcome: 'unknown', ok: true, error: null })
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalled()
    })
    it('still banned AND the unban fails again → the same operator error', async () => {
      const db = makeDb({ authUser: { id: ID, banned_until: '2126-01-01T00:00:00Z' }, updateError: { message: 'nope' } })
      expect((await restoreStaffLogin(db, ID, { transition: false, now: NOW })).outcome).toBe('restore_failed')
    })
  })
})

describe('isBanned', () => {
  it('reads GoTrue banned_until against the clock', () => {
    expect(isBanned({ banned_until: '2126-01-01T00:00:00Z' }, NOW)).toBe(true)
    expect(isBanned({ banned_until: '2020-01-01T00:00:00Z' }, NOW)).toBe(false)
    expect(isBanned({ banned_until: null }, NOW)).toBe(false)
    expect(isBanned({}, NOW)).toBe(false)
    expect(isBanned(null, NOW)).toBe(false)
    expect(isBanned({ banned_until: 'not a date' }, NOW)).toBe(false)
  })
})
