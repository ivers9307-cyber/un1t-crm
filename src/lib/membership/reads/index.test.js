// UN1TREAD.1 — the membership read seam: which adapter serves a location.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/membership/state-for-page', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, membershipStateForPage: vi.fn() }
})
// Stub the four Glofox modules glofox.js imports, so the seam test loads no real Glofox/Supabase code.
vi.mock('@/lib/membership-snapshot', () => ({ computeMembershipCounts: vi.fn() }))
vi.mock('@/lib/membership-flows', () => ({ fetchMembershipFlows: vi.fn() }))
vi.mock('@shared/studio-kpis', () => ({ fetchMrr: vi.fn(), fetchGrowth: vi.fn(), fetchEngagement: vi.fn() }))
vi.mock('@shared/dashboard-data', () => ({ fetchRevenueMTD: vi.fn(), fetchArrearsSummary: vi.fn() }))

import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { READ_KEYS, READS_BY_SOURCE, membershipReadsFor, supportsRead, radarReadsFor } from './index'
import { glofoxReads } from './glofox'
import { noneReads } from './none'
import { un1tOnlineReads } from './un1t-online'

const db = {}
const GLOFOX_KEYS = ['membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd', 'arrears']
const NEW_KEYS = ['pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility']
const LOC = 'a0000000-0000-4000-8000-00000000000a'

beforeEach(() => vi.clearAllMocks())

describe('membershipReadsFor', () => {
  it('exposes the fifteen read keys', () => {
    expect(READ_KEYS).toEqual([
      'membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd', 'arrears',
      'pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility',
      'radarMembers', 'winbackContacts', 'leadContacts', 'radarPastDue',
    ])
    expect(Object.isFrozen(READ_KEYS)).toBe(true)
  })

  it('configured glofox → reads is the glofox adapter', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: {} })
    const r = await membershipReadsFor(db, LOC)
    expect(membershipStateForPage).toHaveBeenCalledWith(db, LOC)
    expect(r).toMatchObject({ source: 'glofox', label: 'Glofox', state: 'configured', error: null })
    expect(r.reads).toBe(glofoxReads)
    for (const k of GLOFOX_KEYS) expect(supportsRead(r, k)).toBe(true)
    for (const k of NEW_KEYS) expect(supportsRead(r, k)).toBe(false)
  })

  for (const [source, state] of [['none', 'none'], ['glofox', 'unconfigured'], [null, 'unknown'], [null, 'no_location']]) {
    it(`${state} → reads null, nothing supported`, async () => {
      membershipStateForPage.mockResolvedValue({ source, state, label: 'X', readError: state === 'unknown' ? 'E' : undefined })
      const r = await membershipReadsFor(db, LOC)
      expect(r.reads).toBeNull()
      expect(r.state).toBe(state)
      expect(r.source).toBe(source)
      for (const k of READ_KEYS) expect(supportsRead(r, k)).toBe(false)
    })
  }

  it('carries the state read error through', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', label: 'No membership source', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    const r = await membershipReadsFor(db, LOC)
    expect(r.error).toBe('MEMBERSHIP_SOURCE_UNREADABLE')
  })

  it('carries the state capabilities and missing names through (one state read serves a gate and radar flags)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'unconfigured', label: 'Glofox', capabilities: { memberships: true }, missing: ['api_key'] })
    const r = await membershipReadsFor(db, LOC)
    expect(r.capabilities).toEqual({ memberships: true })
    expect(r.missing).toEqual(['api_key'])
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'X' })
    expect(await membershipReadsFor(db, LOC)).toMatchObject({ capabilities: {}, missing: undefined })
  })

  it('an unregistered source key → noneReads (supportsRead false)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'mystery', state: 'configured', label: 'mystery' })
    const r = await membershipReadsFor(db, LOC)
    expect(r.reads).toBe(noneReads)
    for (const k of READ_KEYS) expect(supportsRead(r, k)).toBe(false)
  })

  it('configured un1t_online → reads is the un1t adapter (arrears since UN1TRADAR.2; pastDue and paymentsFor yes)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: {} })
    const r = await membershipReadsFor(db, LOC)
    expect(r).toMatchObject({ source: 'un1t_online', state: 'configured', error: null })
    expect(r.reads).toBe(un1tOnlineReads)
    for (const k of GLOFOX_KEYS) expect(supportsRead(r, k)).toBe(true)
    expect(supportsRead(r, 'pastDue')).toBe(true)
    expect(supportsRead(r, 'paymentsFor')).toBe(true)
  })

  it('an inherited key (e.g. "constructor") is not a registered source', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'constructor', state: 'configured', label: 'x' })
    const r = await membershipReadsFor(db, LOC)
    expect(r.reads).toBe(noneReads)
  })

  it('registry maps glofox, none and un1t_online, and is frozen', () => {
    expect(READS_BY_SOURCE.glofox).toBe(glofoxReads)
    expect(READS_BY_SOURCE.none).toBe(noneReads)
    expect(READS_BY_SOURCE.un1t_online).toBe(un1tOnlineReads)
    expect(Object.isFrozen(READS_BY_SOURCE)).toBe(true)
  })
})

describe('supportsRead', () => {
  it('is false for a key the adapter lacks', () => {
    expect(supportsRead({ reads: { mrr: () => {} } }, 'mrr')).toBe(true)
    expect(supportsRead({ reads: { mrr: () => {} } }, 'growth')).toBe(false)
    expect(supportsRead({ reads: { mrr: 'nope' } }, 'mrr')).toBe(false)
    expect(supportsRead(null, 'mrr')).toBe(false)
    expect(supportsRead({ reads: null }, 'mrr')).toBe(false)
  })
})

// UN1TRADAR.1 — the radar reads resolve by SOURCE KEY in any state, so
// Stillorgan's radar survives a Glofox credential glitch.
describe('radarReadsFor', () => {
  it('READ_KEYS lists the four radar keys', () => {
    expect(READ_KEYS).toEqual(expect.arrayContaining(['radarMembers', 'winbackContacts', 'leadContacts', 'radarPastDue']))
  })

  for (const state of ['configured', 'unconfigured', 'unknown']) {
    it(`resolves glofox by source key while ${state}`, async () => {
      membershipStateForPage.mockResolvedValue({ source: 'glofox', state, label: 'Glofox', capabilities: { memberships: true } })
      const r = await radarReadsFor(db, LOC)
      expect(membershipStateForPage).toHaveBeenCalledWith(db, LOC)
      expect(r.source).toBe('glofox')
      expect(r.reads).toBe(READS_BY_SOURCE.glofox)
      expect(r.providesMemberships).toBe(true)
      expect(r.pinArrears).toBe(false)
    })
  }

  it('resolves un1t_online with providesMemberships false today (the static table, not the state)', async () => {
    // even a state claiming memberships cannot widen what the provider declares
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: { memberships: true } })
    const r = await radarReadsFor(db, LOC)
    expect(r.source).toBe('un1t_online')
    expect(r.reads).toBe(un1tOnlineReads)
    expect(r.providesMemberships).toBe(false)
  })

  it('none and an unregistered source resolve to noneReads, providing nothing', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'none', state: 'none', label: 'x' })
    expect(await radarReadsFor(db, LOC)).toMatchObject({ source: 'none', reads: noneReads, providesMemberships: false, pinArrears: false })
    membershipStateForPage.mockResolvedValue({ source: 'un1t', state: 'unconfigured', label: 'un1t', missing: ['provider'] })
    expect(await radarReadsFor(db, LOC)).toMatchObject({ source: 'un1t', reads: noneReads, providesMemberships: false })
    membershipStateForPage.mockResolvedValue({ source: 'constructor', state: 'unconfigured', label: 'x' })
    expect(await radarReadsFor(db, LOC)).toMatchObject({ reads: noneReads, providesMemberships: false })
  })

  it('throws MEMBERSHIP_SOURCE_UNREADABLE when the source key is unreadable', async () => {
    membershipStateForPage.mockResolvedValue({ source: null, state: 'unknown', label: 'x', readError: 'MEMBERSHIP_SOURCE_UNREADABLE' })
    await expect(radarReadsFor(db, LOC)).rejects.toMatchObject({ code: 'MEMBERSHIP_SOURCE_UNREADABLE' })
  })

  it('pinArrears is true for un1t_online and false for glofox', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online' })
    expect((await radarReadsFor(db, LOC)).pinArrears).toBe(true)
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox' })
    expect((await radarReadsFor(db, LOC)).pinArrears).toBe(false)
  })
})
