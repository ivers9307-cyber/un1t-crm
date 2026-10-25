// UN1TRADAR.1 — the lead radar loaders read their rows through the seam
// (radarReadsFor → leadContacts); a Glofox studio's output is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fakeReads = vi.hoisted(() => ({ leadContacts: vi.fn(async () => []) }))
// Only the resolver is needed here, so the factory builds it outright.
vi.mock('@/lib/membership/state-for-page', () => ({
  membershipStateForPage: vi.fn(async () => ({ source: 'glofox', state: 'configured', label: 'Glofox', capabilities: { memberships: true } })),
}))
// The un1t adapter is replaced by spies.
vi.mock('@/lib/membership/reads/un1t-online', () => ({ un1tOnlineReads: fakeReads, freshCutoff: vi.fn() }))

import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { loadFunnel, loadCleanup, loadClassPass } from './lead-radar-data'
import { glofoxFixtureDb, NOW, LOC } from './radar-glofox-fixture.test-helpers'
import EXPECTED from './radar-glofox-fixture.expected.json'

const asJson = (v) => JSON.parse(JSON.stringify(v))

beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); fakeReads.leadContacts.mockClear() })
afterEach(() => vi.useRealTimers())

describe('lead radar loaders through the seam', () => {
  it("Glofox: funnel, cleanup and classpass deep-equal today's output", async () => {
    const db = glofoxFixtureDb()
    expect(asJson(await loadFunnel(db, LOC, NOW))).toEqual(EXPECTED.funnel)
    expect(asJson(await loadCleanup(db, LOC, NOW))).toEqual(EXPECTED.cleanup)
    expect(asJson(await loadClassPass(db, LOC, NOW))).toEqual(EXPECTED.classpass)
  })

  it('loadFunnel reads leadContacts from the resolved adapter', async () => {
    membershipStateForPage.mockResolvedValueOnce({ source: 'un1t_online', state: 'unconfigured', label: 'x' })
    const db = glofoxFixtureDb()
    await loadFunnel(db, LOC, NOW)
    expect(fakeReads.leadContacts).toHaveBeenCalledWith(db, LOC, { nowMs: NOW })
  })

  it('loadClassPass and loadCleanup use the same read', async () => {
    const db = glofoxFixtureDb()
    membershipStateForPage.mockResolvedValueOnce({ source: 'un1t_online', state: 'configured', label: 'x' })
    await loadClassPass(db, LOC, NOW)
    membershipStateForPage.mockResolvedValueOnce({ source: 'un1t_online', state: 'configured', label: 'x' })
    await loadCleanup(db, LOC, NOW)
    expect(fakeReads.leadContacts).toHaveBeenCalledTimes(2)
  })

  it('an unreadable source throws', async () => {
    membershipStateForPage.mockResolvedValueOnce({ source: null, state: 'unknown', label: 'x' })
    await expect(loadFunnel(glofoxFixtureDb(), LOC, NOW)).rejects.toMatchObject({ code: 'MEMBERSHIP_SOURCE_UNREADABLE' })
  })
})
