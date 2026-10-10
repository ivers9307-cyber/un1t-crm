// W1.M3a — membershipStateForPage: the ONE server helper every gated web
// surface calls. A 60 s per-location cache (pages call it once; the Studio
// board calls it once per column), an 'unknown' answer is NEVER cached (a
// reload must be a real retry), and a thrown resolver is 'unknown', never
// 'none'. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./source', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, membershipSourceState: vi.fn() }
})

import { membershipSourceState } from './source'
import {
  membershipStateForPage, resetMembershipStateCache, membershipSettingsHref, canManageMembershipSource, membershipStatePayload,
  MEMBERSHIP_STATE_TTL_MS,
} from './state-for-page'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const OTHER = 'a0000000-0000-4000-8000-00000000000b'
const db = {}

beforeEach(() => {
  vi.clearAllMocks()
  resetMembershipStateCache()
})

describe('membershipStateForPage (W1.M3a)', () => {
  it('a configured glofox location carries the provider label + capabilities, and is read once per minute', async () => {
    membershipSourceState.mockResolvedValue({ source: 'glofox', state: 'configured' })
    let t = 1_000_000
    const now = () => t
    const first = await membershipStateForPage(db, LOC, { now })
    expect(first).toEqual({
      source: 'glofox', state: 'configured', label: 'Glofox',
      capabilities: { memberships: true, bookings: true, credits: true, invoices: true, schedule: true },
    })
    t += MEMBERSHIP_STATE_TTL_MS - 1
    expect(await membershipStateForPage(db, LOC, { now })).toBe(first)
    expect(membershipSourceState).toHaveBeenCalledTimes(1)
    t += 2
    await membershipStateForPage(db, LOC, { now })
    expect(membershipSourceState).toHaveBeenCalledTimes(2)
  })

  it('the cache is per location', async () => {
    membershipSourceState.mockResolvedValueOnce({ source: 'glofox', state: 'configured' })
    membershipSourceState.mockResolvedValueOnce({ source: 'none', state: 'none' })
    expect((await membershipStateForPage(db, LOC)).state).toBe('configured')
    expect((await membershipStateForPage(db, OTHER)).state).toBe('none')
    expect(membershipSourceState).toHaveBeenCalledTimes(2)
    expect(membershipSourceState).toHaveBeenNthCalledWith(1, db, LOC)
    expect(membershipSourceState).toHaveBeenNthCalledWith(2, db, OTHER)
  })

  it('none carries the none provider (every capability false)', async () => {
    membershipSourceState.mockResolvedValue({ source: 'none', state: 'none' })
    expect(await membershipStateForPage(db, LOC)).toEqual({
      source: 'none', state: 'none', label: 'No membership source',
      capabilities: { memberships: false, bookings: false, credits: false, invoices: false, schedule: false },
    })
  })

  it('unconfigured keeps `missing`; a value with no provider yet keeps its own name as the label', async () => {
    membershipSourceState.mockResolvedValueOnce({ source: 'glofox', state: 'unconfigured', missing: ['API Key'] })
    expect(await membershipStateForPage(db, LOC)).toMatchObject({ source: 'glofox', state: 'unconfigured', missing: ['API Key'], label: 'Glofox' })
    membershipSourceState.mockResolvedValueOnce({ source: 'un1t', state: 'unconfigured', missing: ['provider'] })
    expect(await membershipStateForPage(db, OTHER)).toMatchObject({ source: 'un1t', state: 'unconfigured', label: 'un1t' })
  })

  it('unknown is never cached: the next call reads again', async () => {
    membershipSourceState.mockResolvedValueOnce({ source: null, state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    membershipSourceState.mockResolvedValueOnce({ source: 'glofox', state: 'configured' })
    expect(await membershipStateForPage(db, LOC)).toMatchObject({ state: 'unknown', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    expect(await membershipStateForPage(db, LOC)).toMatchObject({ state: 'configured' })
    expect(membershipSourceState).toHaveBeenCalledTimes(2)
  })

  it('a resolver that THROWS is unknown (logged), never none', async () => {
    membershipSourceState.mockRejectedValueOnce(new Error('boom'))
    const r = await membershipStateForPage(db, LOC)
    expect(r.state).toBe('unknown')
    expect(r.source).toBeNull()
    expect(r.readError).toBe('MEMBERSHIP_STATE_THREW')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('no location id → no_location without a read (not "none": a user with no active studio is told to pick one)', async () => {
    const r = await membershipStateForPage(db, null)
    expect(r.state).toBe('no_location')
    expect(r.source).toBeNull()
    expect(membershipSourceState).not.toHaveBeenCalled()
  })

  it('resetMembershipStateCache(locationId) drops one location; no arg drops all', async () => {
    membershipSourceState.mockResolvedValue({ source: 'glofox', state: 'configured' })
    await membershipStateForPage(db, LOC)
    await membershipStateForPage(db, OTHER)
    resetMembershipStateCache(LOC)
    await membershipStateForPage(db, LOC)
    await membershipStateForPage(db, OTHER)
    expect(membershipSourceState).toHaveBeenCalledTimes(3)
  })
})

describe('membershipSettingsHref / canManageMembershipSource', () => {
  it('links to the location\'s Integrations tab (where W1.M2 puts the Membership source card)', () => {
    expect(membershipSettingsHref(LOC)).toBe(`/settings/locations/${LOC}?section=integrations&tab=glofox`)
  })

  it('mirrors guardMasterOrOwner: master anywhere, owner AT the location, nobody else', () => {
    expect(canManageMembershipSource({ profileRole: 'master' }, LOC)).toBe(true)
    expect(canManageMembershipSource({ profileRole: 'staff', rolesByLocation: { [LOC]: 'owner' } }, LOC)).toBe(true)
    expect(canManageMembershipSource({ profileRole: 'staff', rolesByLocation: { [OTHER]: 'owner' } }, LOC)).toBe(false)
    expect(canManageMembershipSource({ profileRole: 'staff', rolesByLocation: { [LOC]: 'manager' } }, LOC)).toBe(false)
    expect(canManageMembershipSource(null, LOC)).toBe(false)
    expect(canManageMembershipSource({ profileRole: 'master' }, null)).toBe(false)
  })
})

describe('membershipStatePayload (W1.M3c: what the phone routes carry)', () => {
  const GLOFOX_CAPS = { memberships: true, bookings: true, credits: true, invoices: true, schedule: true }

  it('configured glofox: state, label, provides memberships, the caller\'s manage bit; no missing key', () => {
    expect(membershipStatePayload({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: GLOFOX_CAPS }, { canManage: true }))
      .toEqual({ source: 'glofox', state: 'configured', label: 'Glofox', provides_memberships: true, can_manage: true })
  })

  it('none: the none provider provides no memberships; canManage defaults to false', () => {
    expect(membershipStatePayload({ source: 'none', state: 'none', label: 'No membership source', capabilities: { memberships: false } }))
      .toEqual({ source: 'none', state: 'none', label: 'No membership source', provides_memberships: false, can_manage: false })
  })

  it('unconfigured carries the missing credential NAMES', () => {
    const p = membershipStatePayload({ source: 'glofox', state: 'unconfigured', missing: ['Branch ID', 'API Key'], label: 'Glofox', capabilities: GLOFOX_CAPS })
    expect(p.state).toBe('unconfigured')
    expect(p.missing).toEqual(['Branch ID', 'API Key'])
  })

  it('unknown keeps no read-error detail (it stays in the server log)', () => {
    const p = membershipStatePayload({ source: null, state: 'unknown', readError: 'MEMBERSHIP_STATE_THREW', label: 'No membership source', capabilities: {} })
    expect(p).toEqual({ source: null, state: 'unknown', label: 'No membership source', provides_memberships: true, can_manage: false })
    expect(p).not.toHaveProperty('readError')
  })

  it('a missing or malformed state is unknown, never none', () => {
    expect(membershipStatePayload(null).state).toBe('unknown')
    expect(membershipStatePayload(undefined).state).toBe('unknown')
    expect(membershipStatePayload({ source: 'none' }).state).toBe('unknown')
  })
})
