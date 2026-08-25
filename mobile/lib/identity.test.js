// PHASE2 stage C — tri-state identity probe tests. The merged app decides
// staff vs member from two probes; the transition rules here are the
// load-bearing safety property: a transient failure (network blip, champ
// host outage, 5xx) must NEVER demote an established mode, and the silent
// link-contact fallback must fire only for a CONFIRMED member-only user
// who has never been staff on this device.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ values: new Map() }))

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k) => (store.values.has(k) ? store.values.get(k) : null)),
  setItemAsync: vi.fn(async (k, v) => { store.values.set(k, v) }),
  deleteItemAsync: vi.fn(async (k) => { store.values.delete(k) }),
}))

import {
  STAFF, NOT_STAFF, UNKNOWN, MEMBER, NO_MEMBER,
  STAFF_HOME, MEMBER_HOME, NOT_SET_UP_ROUTE,
  probeStaff, probeMember, applyReprobe, shouldAttemptLinkContact,
  resolveEntryRoute,
  getHasEverBeenStaff, setHasEverBeenStaff, clearHasEverBeenStaff,
  readCachedMemberContactId, writeCachedMemberContactId, clearCachedMemberContactId,
} from './identity'

beforeEach(() => { store.values.clear() })

// ── probeStaff ─────────────────────────────────────────────────────────

describe('probeStaff', () => {
  const ok = (json = { success: true, data: { profile: { id: 'u1' } } }) =>
    async () => ({ status: 200, json })
  const status = (s) => async () => ({ status: s, json: null })
  const networkFail = async () => { throw new Error('Network request failed') }

  it('200 → staff, payload cached', async () => {
    const r = await probeStaff({ fetchMe: ok(), refreshSession: async () => true })
    expect(r.state).toBe(STAFF)
    expect(r.payload?.data?.profile?.id).toBe('u1')
  })

  it('401 with a just-refreshed token → not_staff WITHOUT another refresh', async () => {
    const refreshSession = vi.fn(async () => true)
    const r = await probeStaff({ fetchMe: status(401), refreshSession, justRefreshed: true })
    expect(r.state).toBe(NOT_STAFF)
    expect(refreshSession).not.toHaveBeenCalled()
  })

  it('401 → refresh succeeds → retry 200 → staff', async () => {
    let calls = 0
    const fetchMe = async () => (++calls === 1 ? { status: 401, json: null } : { status: 200, json: { success: true } })
    const r = await probeStaff({ fetchMe, refreshSession: async () => true })
    expect(r.state).toBe(STAFF)
    expect(calls).toBe(2)
  })

  it('401 → refresh succeeds → retry still 401 → not_staff (confirmed)', async () => {
    const r = await probeStaff({ fetchMe: status(401), refreshSession: async () => true })
    expect(r.state).toBe(NOT_STAFF)
  })

  it('401 → refresh FAILS → unknown (never not_staff on an unproven token)', async () => {
    const r = await probeStaff({ fetchMe: status(401), refreshSession: async () => false })
    expect(r.state).toBe(UNKNOWN)
  })

  it('401 → refresh throws → unknown', async () => {
    const r = await probeStaff({ fetchMe: status(401), refreshSession: async () => { throw new Error('boom') } })
    expect(r.state).toBe(UNKNOWN)
  })

  it('401 → refresh ok → retry network error → unknown', async () => {
    let calls = 0
    const fetchMe = async () => { if (++calls === 1) return { status: 401, json: null }; throw new Error('offline') }
    const r = await probeStaff({ fetchMe, refreshSession: async () => true })
    expect(r.state).toBe(UNKNOWN)
  })

  it('network error → unknown', async () => {
    const r = await probeStaff({ fetchMe: networkFail, refreshSession: async () => true })
    expect(r.state).toBe(UNKNOWN)
  })

  it.each([500, 502, 503, 429, 403])('%s → unknown (only 401 can confirm not_staff)', async (s) => {
    const r = await probeStaff({ fetchMe: status(s), refreshSession: async () => true })
    expect(r.state).toBe(UNKNOWN)
  })
})

// ── probeMember ────────────────────────────────────────────────────────

describe('probeMember', () => {
  it('row → member with contact', async () => {
    const r = await probeMember({ fetchContact: async () => ({ data: { id: 'c1', name: 'Sam' }, error: null }) })
    expect(r.state).toBe(MEMBER)
    expect(r.contact.id).toBe('c1')
  })

  it('no row → no_member (confirmed empty)', async () => {
    const r = await probeMember({ fetchContact: async () => ({ data: null, error: null }) })
    expect(r.state).toBe(NO_MEMBER)
  })

  it('query error → unknown', async () => {
    const r = await probeMember({ fetchContact: async () => ({ data: null, error: { message: 'timeout' } }) })
    expect(r.state).toBe(UNKNOWN)
  })

  it('throw → unknown', async () => {
    const r = await probeMember({ fetchContact: async () => { throw new Error('offline') } })
    expect(r.state).toBe(UNKNOWN)
  })
})

// ── applyReprobe — downgrade-never ─────────────────────────────────────

describe('applyReprobe', () => {
  it('never demotes an active staff mode', () => {
    expect(applyReprobe(STAFF, UNKNOWN)).toBe(STAFF)
    expect(applyReprobe(STAFF, NOT_STAFF)).toBe(STAFF)
    expect(applyReprobe(STAFF, STAFF)).toBe(STAFF)
  })

  it('upgrades unknown → staff / not_staff', () => {
    expect(applyReprobe(UNKNOWN, STAFF)).toBe(STAFF)
    expect(applyReprobe(UNKNOWN, NOT_STAFF)).toBe(NOT_STAFF)
    expect(applyReprobe(UNKNOWN, UNKNOWN)).toBe(UNKNOWN)
  })

  it('not_staff can upgrade to staff, never regress to unknown', () => {
    expect(applyReprobe(NOT_STAFF, STAFF)).toBe(STAFF)
    expect(applyReprobe(NOT_STAFF, UNKNOWN)).toBe(NOT_STAFF)
    expect(applyReprobe(NOT_STAFF, NOT_STAFF)).toBe(NOT_STAFF)
  })
})

// ── link-contact policy ────────────────────────────────────────────────

describe('shouldAttemptLinkContact', () => {
  it('fires ONLY on confirmed not_staff + flag unset + confirmed empty member probe', () => {
    expect(shouldAttemptLinkContact({ staffState: NOT_STAFF, hasEverBeenStaff: false, memberState: NO_MEMBER })).toBe(true)
  })

  it('never fires while staff state is unknown (transient-safe)', () => {
    expect(shouldAttemptLinkContact({ staffState: UNKNOWN, hasEverBeenStaff: false, memberState: NO_MEMBER })).toBe(false)
  })

  it('never fires for staff', () => {
    expect(shouldAttemptLinkContact({ staffState: STAFF, hasEverBeenStaff: false, memberState: NO_MEMBER })).toBe(false)
  })

  it('HARD-DISABLED while has_ever_been_staff is set (staff linking is admin-only)', () => {
    expect(shouldAttemptLinkContact({ staffState: NOT_STAFF, hasEverBeenStaff: true, memberState: NO_MEMBER })).toBe(false)
  })

  it('never fires when the member probe found a row or was inconclusive', () => {
    expect(shouldAttemptLinkContact({ staffState: NOT_STAFF, hasEverBeenStaff: false, memberState: MEMBER })).toBe(false)
    expect(shouldAttemptLinkContact({ staffState: NOT_STAFF, hasEverBeenStaff: false, memberState: UNKNOWN })).toBe(false)
  })
})

// ── resolveEntryRoute ──────────────────────────────────────────────────

describe('resolveEntryRoute', () => {
  const base = { paired: false, impersonating: false, staffState: UNKNOWN, memberState: UNKNOWN, lastSide: null }

  it('kiosk pairing wins over everything — staff shell only', () => {
    expect(resolveEntryRoute({ ...base, paired: true, staffState: NOT_STAFF, memberState: MEMBER, lastSide: 'member' })).toBe(STAFF_HOME)
  })

  it('impersonation suppresses member mode', () => {
    expect(resolveEntryRoute({ ...base, impersonating: true, memberState: MEMBER, lastSide: 'member' })).toBe(STAFF_HOME)
  })

  it('staff-only → staff tabs', () => {
    expect(resolveEntryRoute({ ...base, staffState: STAFF, memberState: NO_MEMBER })).toBe(STAFF_HOME)
    expect(resolveEntryRoute({ ...base, staffState: STAFF, memberState: UNKNOWN })).toBe(STAFF_HOME)
  })

  it('member-only → member home', () => {
    expect(resolveEntryRoute({ ...base, staffState: NOT_STAFF, memberState: MEMBER })).toBe(MEMBER_HOME)
  })

  it('dual → last-used side; first-time default staff', () => {
    const dual = { ...base, staffState: STAFF, memberState: MEMBER }
    expect(resolveEntryRoute({ ...dual, lastSide: 'member' })).toBe(MEMBER_HOME)
    expect(resolveEntryRoute({ ...dual, lastSide: 'staff' })).toBe(STAFF_HOME)
    expect(resolveEntryRoute({ ...dual, lastSide: null })).toBe(STAFF_HOME)
  })

  it('confirmed neither → account-not-set-up', () => {
    expect(resolveEntryRoute({ ...base, staffState: NOT_STAFF, memberState: NO_MEMBER })).toBe(NOT_SET_UP_ROUTE)
  })

  it('not_staff + inconclusive member probe → member home (degrade member-side, never dead-end)', () => {
    expect(resolveEntryRoute({ ...base, staffState: NOT_STAFF, memberState: UNKNOWN })).toBe(MEMBER_HOME)
  })

  it('staff unknown → last side wins when set (never dead-end on a blip)', () => {
    expect(resolveEntryRoute({ ...base, lastSide: 'member' })).toBe(MEMBER_HOME)
    expect(resolveEntryRoute({ ...base, lastSide: 'staff' })).toBe(STAFF_HOME)
  })

  it('staff unknown, no last side → confirmed member wins, else staff (today\'s default)', () => {
    expect(resolveEntryRoute({ ...base, memberState: MEMBER })).toBe(MEMBER_HOME)
    expect(resolveEntryRoute(base)).toBe(STAFF_HOME)
  })
})

// ── SecureStore-backed flags ───────────────────────────────────────────

describe('has_ever_been_staff flag', () => {
  it('unset by default, sticky once set, clearable', async () => {
    expect(await getHasEverBeenStaff()).toBe(false)
    await setHasEverBeenStaff()
    expect(await getHasEverBeenStaff()).toBe(true)
    await clearHasEverBeenStaff()
    expect(await getHasEverBeenStaff()).toBe(false)
  })
})

describe('cached member contact id', () => {
  it('round-trips and clears', async () => {
    expect(await readCachedMemberContactId()).toBe(null)
    await writeCachedMemberContactId('c-123')
    expect(await readCachedMemberContactId()).toBe('c-123')
    await clearCachedMemberContactId()
    expect(await readCachedMemberContactId()).toBe(null)
  })

  it('ignores a falsy write', async () => {
    await writeCachedMemberContactId(null)
    expect(await readCachedMemberContactId()).toBe(null)
  })
})
