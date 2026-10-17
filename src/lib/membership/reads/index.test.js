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
import { READ_KEYS, READS_BY_SOURCE, membershipReadsFor, supportsRead } from './index'
import { glofoxReads } from './glofox'
import { noneReads } from './none'
import { un1tOnlineReads } from './un1t-online'

const db = {}
const LOC = 'a0000000-0000-4000-8000-00000000000a'

beforeEach(() => vi.clearAllMocks())

describe('membershipReadsFor', () => {
  it('exposes the seven read keys', () => {
    expect(READ_KEYS).toEqual(['membershipCounts', 'mrr', 'membershipFlows', 'growth', 'engagement', 'revenueMtd', 'arrears'])
    expect(Object.isFrozen(READ_KEYS)).toBe(true)
  })

  it('configured glofox → reads is the glofox adapter', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: {} })
    const r = await membershipReadsFor(db, LOC)
    expect(membershipStateForPage).toHaveBeenCalledWith(db, LOC)
    expect(r).toMatchObject({ source: 'glofox', label: 'Glofox', state: 'configured', error: null })
    expect(r.reads).toBe(glofoxReads)
    for (const k of READ_KEYS) expect(supportsRead(r, k)).toBe(true)
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

  it('an unregistered source key → noneReads (supportsRead false)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'mystery', state: 'configured', label: 'mystery' })
    const r = await membershipReadsFor(db, LOC)
    expect(r.reads).toBe(noneReads)
    for (const k of READ_KEYS) expect(supportsRead(r, k)).toBe(false)
  })

  it('configured un1t_online → reads is the un1t adapter (no arrears)', async () => {
    membershipStateForPage.mockResolvedValue({ source: 'un1t_online', state: 'configured', label: 'un1t.online', capabilities: {} })
    const r = await membershipReadsFor(db, LOC)
    expect(r).toMatchObject({ source: 'un1t_online', state: 'configured', error: null })
    expect(r.reads).toBe(un1tOnlineReads)
    for (const k of READ_KEYS.filter((k) => k !== 'arrears')) expect(supportsRead(r, k)).toBe(true)
    expect(supportsRead(r, 'arrears')).toBe(false)
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
