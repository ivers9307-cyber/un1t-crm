// UN1TREAD.1 — the Glofox adapter is a pure pass-through: each read calls the
// existing function with exactly the same arguments and returns its value (or
// rejection) untouched, so Stillorgan's numbers cannot move.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/membership-snapshot', () => ({ computeMembershipCounts: vi.fn() }))
vi.mock('@/lib/membership-flows', () => ({ fetchMembershipFlows: vi.fn() }))
vi.mock('@shared/studio-kpis', () => ({ fetchMrr: vi.fn(), fetchGrowth: vi.fn(), fetchEngagement: vi.fn() }))
vi.mock('@shared/dashboard-data', () => ({ fetchRevenueMTD: vi.fn(), fetchArrearsSummary: vi.fn() }))

import { computeMembershipCounts } from '@/lib/membership-snapshot'
import { fetchMembershipFlows } from '@/lib/membership-flows'
import { fetchMrr, fetchGrowth, fetchEngagement } from '@shared/studio-kpis'
import { fetchRevenueMTD, fetchArrearsSummary } from '@shared/dashboard-data'
import { glofoxReads } from './glofox'
import { READ_KEYS } from './index'

const db = { tag: 'db' }
const LOC = 'a0000000-0000-4000-8000-00000000000a'
const now = new Date('2026-10-17T10:00:00Z')

beforeEach(() => vi.clearAllMocks())

describe('glofoxReads (pass-through)', () => {
  it('implements the original seven READ_KEYS and none of the un1t-only four', () => {
    expect(Object.keys(glofoxReads).sort()).toEqual([...READ_KEYS.slice(0, 7)].sort())
    for (const k of ['pastDue', 'paymentsFor', 'pipelineInputs', 'trialEligibility']) expect(glofoxReads[k]).toBeUndefined()
    expect(Object.isFrozen(glofoxReads)).toBe(true)
  })

  const cases = [
    ['membershipCounts', computeMembershipCounts, [db, LOC]],
    ['mrr', fetchMrr, [db, LOC]],
    ['membershipFlows', fetchMembershipFlows, [db, LOC, 6, 1_700_000_000_000, { zone: 'Europe/Dublin' }]],
    ['growth', fetchGrowth, [db, LOC, now]],
    ['engagement', fetchEngagement, [db, LOC]],
    ['revenueMtd', fetchRevenueMTD, [db, LOC, now, 'Europe/Dublin']],
    ['arrears', fetchArrearsSummary, [db, LOC]],
  ]

  for (const [key, fn, args] of cases) {
    it(`${key} passes its arguments through and returns the value untouched`, async () => {
      const value = { success: true, data: { marker: key } }
      fn.mockResolvedValue(value)
      const out = await glofoxReads[key](...args)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn.mock.calls[0]).toEqual(args)
      expect(out).toBe(value)
    })

    it(`${key} propagates a rejection`, async () => {
      const boom = new Error(`${key} failed`)
      fn.mockRejectedValue(boom)
      await expect(glofoxReads[key](...args)).rejects.toBe(boom)
    })
  }

  it('does not invent arguments when the caller omits optional ones', async () => {
    fetchGrowth.mockResolvedValue({ success: true })
    await glofoxReads.growth(db, LOC)
    expect(fetchGrowth.mock.calls[0]).toEqual([db, LOC])
    fetchRevenueMTD.mockResolvedValue({ success: true })
    await glofoxReads.revenueMtd(db, LOC)
    expect(fetchRevenueMTD.mock.calls[0]).toEqual([db, LOC])
    fetchMembershipFlows.mockResolvedValue({})
    await glofoxReads.membershipFlows(db, LOC)
    expect(fetchMembershipFlows.mock.calls[0]).toEqual([db, LOC])
  })
})
