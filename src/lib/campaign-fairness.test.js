import { describe, it, expect } from 'vitest'
import { pickFairCampaigns } from './campaign-fairness.js'

const c = (id, loc) => ({ id, location_id: loc })

describe('pickFairCampaigns (SAAS4-O3 — tenant fairness in run-campaigns)', () => {
  it('gives each location one slot before any location gets a second', () => {
    // Location A has flooded the queue with the 5 oldest campaigns;
    // B and C each have one, younger. The old global FIFO would pick
    // a1,a2,a3 and starve B/C — fairness picks a1,b1,c1.
    const rows = [c('a1', 'A'), c('a2', 'A'), c('a3', 'A'), c('a4', 'A'), c('a5', 'A'), c('b1', 'B'), c('c1', 'C')]
    expect(pickFairCampaigns(rows, 3).map((x) => x.id)).toEqual(['a1', 'b1', 'c1'])
  })

  it('fills remaining slots by age once every location has one', () => {
    const rows = [c('a1', 'A'), c('a2', 'A'), c('a3', 'A'), c('b1', 'B')]
    expect(pickFairCampaigns(rows, 3).map((x) => x.id)).toEqual(['a1', 'b1', 'a2'])
  })

  it('a single location still gets full throughput (no artificial starvation)', () => {
    const rows = [c('a1', 'A'), c('a2', 'A'), c('a3', 'A'), c('a4', 'A')]
    expect(pickFairCampaigns(rows, 3).map((x) => x.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('orders round-one slots by each location`s oldest campaign (input order = age order)', () => {
    const rows = [c('b1', 'B'), c('a1', 'A'), c('a2', 'A')]
    expect(pickFairCampaigns(rows, 2).map((x) => x.id)).toEqual(['b1', 'a1'])
  })

  it('handles fewer rows than slots and empty/absent input', () => {
    expect(pickFairCampaigns([c('a1', 'A')], 3).map((x) => x.id)).toEqual(['a1'])
    expect(pickFairCampaigns([], 3)).toEqual([])
    expect(pickFairCampaigns(null, 3)).toEqual([])
  })
})
