import { describe, it, expect } from 'vitest'
import {
  findAttributionBreaks,
  assessFreezeGate,
  MIN_VISIT_SAMPLES,
} from './hr-attribution-health'

// A realistic day, times in UTC. The 18:00 class at Stillorgan.
const LOC = 'a0000000-0000-0000-0000-000000000001'
const visit = (over = {}) => ({
  device_key: 'ant:12511',
  location_id: LOC,
  started_at: '2026-08-14T18:05:00Z',
  last_sample_at: '2026-08-14T18:50:00Z',
  sample_count: 2400,
  class_name: 'UN1T Class',
  glofox_event_id: 'ev-1',
  ...over,
})
const reg = (over = {}) => ({ identifier: 'ant:12511', contact_id: 'c-richard', ...over })
const session = (over = {}) => ({
  contact_id: 'c-richard',
  device_identifier: 'ant:12511',
  started_at: '2026-08-14T18:05:30Z',
  ended_at: '2026-08-14T19:00:00Z',
  location_id: LOC,
  ...over,
})

describe('findAttributionBreaks', () => {
  it('a registered strap worn in class with an owned session is NOT a break', () => {
    expect(findAttributionBreaks({
      visits: [visit()], registrations: [reg()], sessions: [session()],
    })).toEqual([])
  })

  it('flags no_session when the owner got nothing', () => {
    const out = findAttributionBreaks({
      visits: [visit()], registrations: [reg()], sessions: [],
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      device_key: 'ant:12511', contact_id: 'c-richard', reason: 'no_session',
    })
  })

  it('flags anon_session when the strap spawned a contact-less session — the router ignored an active registration', () => {
    const out = findAttributionBreaks({
      visits: [visit()], registrations: [reg()],
      sessions: [session({ contact_id: null })],
    })
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('anon_session')
  })

  // Base-rate discipline: the three ordinary situations that must NEVER fire.
  it('an unregistered strap is never a break (the ordinary 80% case)', () => {
    expect(findAttributionBreaks({
      visits: [visit({ device_key: 'ant:99999' })], registrations: [reg()], sessions: [],
    })).toEqual([])
  })

  it('no registrations at all short-circuits to no breaks', () => {
    expect(findAttributionBreaks({ visits: [visit()], registrations: [], sessions: [] })).toEqual([])
  })

  it('a visit outside any class (no class stamp) is never a break — HR-ROUTE design', () => {
    expect(findAttributionBreaks({
      visits: [visit({ class_name: null, glofox_event_id: null })],
      registrations: [reg()], sessions: [],
    })).toEqual([])
  })

  it('a drive-by blip below the sample floor is never a break', () => {
    expect(findAttributionBreaks({
      visits: [visit({ sample_count: MIN_VISIT_SAMPLES - 1 })],
      registrations: [reg()], sessions: [],
    })).toEqual([])
  })

  it('a session opened within the slack window before the visit still counts as owned', () => {
    expect(findAttributionBreaks({
      visits: [visit()], registrations: [reg()],
      sessions: [session({ started_at: '2026-08-14T17:40:00Z', ended_at: '2026-08-14T18:06:00Z' })],
    })).toEqual([])
  })

  it("someone ELSE's session on the same strap does not clear the owner's break", () => {
    const out = findAttributionBreaks({
      visits: [visit()], registrations: [reg()],
      sessions: [session({ contact_id: 'c-somebody-else' })],
    })
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('no_session')
  })

  it('a still-open session (ended_at null) counts as owned', () => {
    expect(findAttributionBreaks({
      visits: [visit()], registrations: [reg()],
      sessions: [session({ ended_at: null })],
    })).toEqual([])
  })

  it('sessions at a DIFFERENT location never clear a break (cross-location strap)', () => {
    const out = findAttributionBreaks({
      visits: [visit()], registrations: [reg()],
      sessions: [session({ location_id: 'loc-hatch' })],
    })
    expect(out).toHaveLength(1)
  })

  it('orders anon_session breaks before no_session', () => {
    const out = findAttributionBreaks({
      visits: [
        visit({ device_key: 'ant:1' }),
        visit({ device_key: 'ant:2' }),
      ],
      registrations: [
        reg({ identifier: 'ant:1', contact_id: 'c-1' }),
        reg({ identifier: 'ant:2', contact_id: 'c-2' }),
      ],
      sessions: [session({ contact_id: null, device_identifier: 'ant:2' })],
    })
    expect(out.map((b) => b.reason)).toEqual(['anon_session', 'no_session'])
  })
})

describe('assessFreezeGate', () => {
  it('two consecutive weeks at target lifts the freeze', () => {
    const g = assessFreezeGate({ current: { attributed: 12 }, previous: { attributed: 10 } })
    expect(g).toMatchObject({ freezeLifted: true, weeksAtTarget: 2 })
    expect(g.statusLine).toMatch(/LIFTED/)
  })

  it('first week at target holds the freeze and says one more week is needed', () => {
    const g = assessFreezeGate({ current: { attributed: 11 }, previous: { attributed: 3 } })
    expect(g).toMatchObject({ freezeLifted: false, weeksAtTarget: 1 })
    expect(g.statusLine).toMatch(/one more week/)
  })

  it('below target holds regardless of last week — no lift on a stale streak', () => {
    const g = assessFreezeGate({ current: { attributed: 4 }, previous: { attributed: 15 } })
    expect(g).toMatchObject({ freezeLifted: false, weeksAtTarget: 0 })
  })

  it('handles missing inputs as zero', () => {
    expect(assessFreezeGate({}).weeksAtTarget).toBe(0)
  })
})
