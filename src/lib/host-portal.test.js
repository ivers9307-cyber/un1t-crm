import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/location-time', () => ({ getLocationZone: vi.fn(), DEFAULT_TZ: 'Default/Zone' }))
vi.mock('@shared/events', () => ({ todayIsoIn: vi.fn((z) => `today-in-${z}`) }))

import { getLocationZone } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import {
  groupHostEvents, eventLandingHref, loadHostEvent, moneyLabel, eventMoneyCents,
  loadPublicRatingAverages, loadHostToday, HOST_STATUS_CHIP, formatHostMoney, hostEventDetail, attendeeCounts,
} from './host-portal'

// Chainable, thenable supabase stub. `results` is consumed one per awaited query.
function stub(results) {
  const calls = []
  const q = {}
  for (const m of ['select', 'eq', 'in', 'order', 'range']) q[m] = (...a) => { calls.push([m, a]); return q }
  q.maybeSingle = () => Promise.resolve(results.shift())
  q.then = (res, rej) => Promise.resolve(results.shift()).then(res, rej)
  return { db: { from: vi.fn(() => q) }, calls }
}

beforeEach(() => { vi.clearAllMocks() })

describe('groupHostEvents', () => {
  const ev = (id, status, race_date) => ({ id, status, race_date })
  it('puts today in upcoming and yesterday in past', () => {
    const g = groupHostEvents([ev('a', 'published', '2026-11-09'), ev('b', 'published', '2026-11-08')], '2026-11-09')
    expect(g.upcoming.map((e) => e.id)).toEqual(['a'])
    expect(g.past.map((e) => e.id)).toEqual(['b'])
  })
  it('files a future draft and a future rejected event under needsAction', () => {
    const g = groupHostEvents([ev('d', 'draft', '2026-12-01'), ev('r', 'rejected', '2026-12-02'), ev('p', 'pending_review', '2026-12-03')], '2026-11-09')
    expect(g.needsAction.map((e) => e.id).sort()).toEqual(['d', 'r'])
    expect(g.upcoming.map((e) => e.id)).toEqual(['p'])
  })
  it('files a past-dated draft under past, not needsAction', () => {
    const g = groupHostEvents([ev('old', 'draft', '2026-10-01')], '2026-11-09')
    expect(g.needsAction).toEqual([])
    expect(g.past.map((e) => e.id)).toEqual(['old'])
  })
  it('orders upcoming soonest first and past newest first', () => {
    const g = groupHostEvents([
      ev('u2', 'published', '2026-12-05'), ev('u1', 'published', '2026-11-20'), ev('u3', 'published', '2027-01-01'),
      ev('p1', 'published', '2026-09-01'), ev('p3', 'published', '2026-11-01'), ev('p2', 'published', '2026-10-01'),
    ], '2026-11-09')
    expect(g.upcoming.map((e) => e.id)).toEqual(['u1', 'u2', 'u3'])
    expect(g.past.map((e) => e.id)).toEqual(['p3', 'p2', 'p1'])
  })
  it('files a null race_date by status: draft/rejected to needsAction, others to upcoming', () => {
    const g = groupHostEvents([ev('d', 'draft', null), ev('r', 'rejected', null), ev('p', 'published', null)], '2026-11-09')
    expect(g.needsAction.map((e) => e.id).sort()).toEqual(['d', 'r'])
    expect(g.upcoming.map((e) => e.id)).toEqual(['p'])
    expect(g.past).toEqual([])
  })
  it('returns three empty arrays for no events', () => {
    expect(groupHostEvents([], '2026-11-09')).toEqual({ needsAction: [], upcoming: [], past: [] })
  })
})

describe('eventLandingHref', () => {
  it('opens a draft and a rejected event on the Set up tab', () => {
    expect(eventLandingHref({ id: 'e1', status: 'draft' })).toBe('/host/events/e1/setup')
    expect(eventLandingHref({ id: 'e1', status: 'rejected' })).toBe('/host/events/e1/setup')
  })
  it('opens every other status on the event page', () => {
    expect(eventLandingHref({ id: 'e1', status: 'published' })).toBe('/host/events/e1')
    expect(eventLandingHref({ id: 'e1', status: 'pending_review' })).toBe('/host/events/e1')
  })
})

describe('loadHostEvent', () => {
  it("returns null for another host's event", async () => {
    const { db } = stub([{ data: { id: 'e1', host_id: 'h2' }, error: null }])
    expect(await loadHostEvent(db, 'h1', 'e1', 'id, host_id')).toBeNull()
  })
  it('returns null on a read error and on no row', async () => {
    const a = stub([{ data: null, error: { message: 'boom' } }])
    expect(await loadHostEvent(a.db, 'h1', 'e1', 'id, host_id')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
    const b = stub([{ data: null, error: null }])
    expect(await loadHostEvent(b.db, 'h1', 'e1', 'id, host_id')).toBeNull()
  })
  it('returns the row for its own host, reading by id with the named columns', async () => {
    const row = { id: 'e1', host_id: 'h1', name: 'X' }
    const { db, calls } = stub([{ data: row, error: null }])
    expect(await loadHostEvent(db, 'h1', 'e1', 'id, host_id, name')).toEqual(row)
    expect(db.from).toHaveBeenCalledWith('race_events')
    expect(calls).toContainEqual(['select', ['id, host_id, name']])
    expect(calls).toContainEqual(['eq', ['id', 'e1']])
  })
})

describe('moneyLabel / eventMoneyCents', () => {
  it('is net for stripe_connect and gross for anything else', () => {
    expect(moneyLabel({ payment_provider: 'stripe_connect' })).toBe('net')
    expect(moneyLabel({ payment_provider: 'revolut' })).toBe('gross')
    expect(eventMoneyCents({ payment_provider: 'revolut' }, { net_to_host_cents: 0, gross_cents: 5000 })).toBe(5000)
    expect(eventMoneyCents({ payment_provider: 'stripe_connect' }, { net_to_host_cents: 4200, gross_cents: 5000 })).toBe(4200)
  })
})

describe('formatHostMoney / HOST_STATUS_CHIP', () => {
  it('formats cents as euros by default and carries four status chips', () => {
    expect(formatHostMoney(12345)).toContain('123.45')
    expect(formatHostMoney(undefined, 'EUR')).toContain('0.00')
    expect(Object.keys(HOST_STATUS_CHIP).sort()).toEqual(['draft', 'pending_review', 'published', 'rejected'])
  })
})

describe('loadHostToday', () => {
  it("uses the anchor studio's zone", async () => {
    const { db } = stub([{ data: { anchor_location_id: 'loc1' }, error: null }])
    getLocationZone.mockResolvedValue('Zone/A')
    expect(await loadHostToday(db, { id: 'h1' })).toEqual({ zone: 'Zone/A', today: 'today-in-Zone/A' })
    expect(getLocationZone).toHaveBeenCalledWith(db, 'loc1')
  })
  it('falls back to the default zone and logs when the zone read throws', async () => {
    const { db } = stub([{ data: { anchor_location_id: 'loc1' }, error: null }])
    getLocationZone.mockRejectedValue(new Error('nope'))
    expect(await loadHostToday(db, { id: 'h1' })).toEqual({ zone: 'Default/Zone', today: 'today-in-Default/Zone' })
    expect(logWarn).toHaveBeenCalled()
  })
  it('falls back to the default zone when the host row read errors', async () => {
    const { db } = stub([{ data: null, error: { message: 'x' } }])
    expect((await loadHostToday(db, { id: 'h1' })).zone).toBe('Default/Zone')
  })
})

describe('loadPublicRatingAverages', () => {
  it('averages public ratings per event to one decimal', async () => {
    const { db, calls } = stub([{ data: [
      { race_event_id: 'e1', rating: 5 }, { race_event_id: 'e1', rating: 4 }, { race_event_id: 'e1', rating: 4 },
      { race_event_id: 'e2', rating: 3 },
    ], error: null }])
    const m = await loadPublicRatingAverages(db, ['e1', 'e2', 'e3'])
    expect(m.get('e1')).toEqual({ average: 4.3, count: 3 })
    expect(m.get('e2')).toEqual({ average: 3, count: 1 })
    expect(m.has('e3')).toBe(false)
    expect(db.from).toHaveBeenCalledWith('event_ratings')
    expect(calls).toContainEqual(['eq', ['is_public', true]])
  })
  it('pages past 1,000 rows', async () => {
    const page1 = Array.from({ length: 1000 }, () => ({ race_event_id: 'e1', rating: 5 }))
    const { db, calls } = stub([{ data: page1, error: null }, { data: [{ race_event_id: 'e1', rating: 1 }], error: null }])
    const m = await loadPublicRatingAverages(db, ['e1'])
    expect(m.get('e1').count).toBe(1001)
    expect(calls.filter(([n]) => n === 'range').map(([, a]) => a)).toEqual([[0, 999], [1000, 1999]])
  })
  it('returns null when the read fails, and an empty map for no ids', async () => {
    const { db } = stub([{ data: null, error: { message: 'x' } }])
    expect(await loadPublicRatingAverages(db, ['e1'])).toBeNull()
    const none = stub([])
    const m = await loadPublicRatingAverages(none.db, [])
    expect(m).toBeInstanceOf(Map)
    expect(m.size).toBe(0)
    expect(none.db.from).not.toHaveBeenCalled()
  })
})

describe('hostEventDetail', () => {
  const stripe = { payment_provider: 'stripe_connect' }
  const direct = { payment_provider: 'revolut' }
  const event = { race_date: '2026-12-05', kind: 'run', active: true }
  const row = { paidCount: 3, gross_cents: 9000, net_to_host_cents: 8000 }

  it('is the date and kind only with no revenue row', () => {
    expect(hostEventDetail(stripe, event, null, 'EUR')).toBe('2026-12-05 · run')
    expect(hostEventDetail(stripe, { ...event, race_date: null, active: false }, undefined, 'EUR')).toBe('— · run · inactive')
  })
  it('shows sold and net for a Stripe host', () => {
    expect(hostEventDetail(stripe, event, row, 'EUR')).toBe('2026-12-05 · run · 3 sold · €80.00 net')
  })
  it('shows gross, never net, for a non-Stripe host', () => {
    const d = hostEventDetail(direct, event, row, 'EUR')
    expect(d).toBe('2026-12-05 · run · 3 sold · €90.00 gross')
    expect(d).not.toContain('net')
  })
  it('appends the rating suffix only when a rating is given', () => {
    expect(hostEventDetail(stripe, event, row, 'EUR', { rating: { average: 4.8, count: 19 } })).toBe('2026-12-05 · run · 3 sold · €80.00 net · ★ 4.8 (19)')
    expect(hostEventDetail(stripe, event, row, 'EUR', { rating: null })).not.toContain('★')
  })
})

describe('attendeeCounts', () => {
  const reg = (status, members) => ({ status, teams: members == null ? null : { team_members: Array.from({ length: members }, () => ({ name: 'x' })) } })
  it('counts bookings, confirmed and people; a member-less entry is one person', () => {
    expect(attendeeCounts([reg('confirmed', 3), reg('confirmed', null), reg('pending_payment', 0), reg('cancelled', 2)]))
      .toEqual({ bookings: 4, confirmed: 2, people: 3 + 1 + 1 + 2 })
  })
  it('is all zero for no registrations', () => {
    expect(attendeeCounts([])).toEqual({ bookings: 0, confirmed: 0, people: 0 })
  })
  it('tolerates a non-array team_members', () => {
    expect(attendeeCounts([{ status: 'confirmed', teams: { team_members: null } }])).toEqual({ bookings: 1, confirmed: 1, people: 1 })
  })
})
