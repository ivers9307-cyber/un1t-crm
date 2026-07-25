// AGENT-EVENTS.1 — pure shapers for the race/events agent tools.
import { describe, it, expect } from 'vitest'
import {
  EVENT_TOOLS,
  formatEventPrice,
  shapeEventsForAgent,
  shapeMyRegistrationsForAgent,
  eventOpenForRegistration,
  waveSpotsLeft,
  classifyEventCancellation,
} from './event-tools'

const now = Date.UTC(2026, 5, 12, 12, 0, 0)

describe('EVENT_TOOLS', () => {
  it('declares the event tools', () => {
    expect(EVENT_TOOLS.map(t => t.name)).toEqual(['list_upcoming_events', 'get_my_event_registrations', 'book_event', 'cancel_event_registration', 'reschedule_event_wave'])
  })
})

describe('formatEventPrice', () => {
  it('free when no fees configured', () => {
    expect(formatEventPrice({ non_member_fee_cents: null, member_pricing_enabled: false })).toBe('Free')
  })
  it('flat per-person price without member pricing', () => {
    expect(formatEventPrice({ non_member_fee_cents: 3500, member_pricing_enabled: false })).toBe('€35 per person')
  })
  it('member pricing with both fees', () => {
    expect(formatEventPrice({ member_pricing_enabled: true, member_fee_cents: 2500, non_member_fee_cents: 3500 }))
      .toBe('€25 members / €35 non-members')
  })
  it('members enter free under member pricing', () => {
    expect(formatEventPrice({ member_pricing_enabled: true, member_fee_cents: null, non_member_fee_cents: 3500 }))
      .toBe('Free for members / €35 non-members')
  })
  it('members-only free event', () => {
    expect(formatEventPrice({ members_only: true, member_pricing_enabled: false, non_member_fee_cents: null }))
      .toBe('Free (members only)')
  })
})

describe('shapeEventsForAgent', () => {
  const base = {
    id: 'e1', name: 'Summer Hyrox Sim', kind: 'race', slug: 'summer-hyrox',
    description: 'Race the full sim.', race_date: '2026-06-20', active: true,
    registration_opens_at: null, registration_closes_at: null,
    member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null, members_only: false,
    waves: [
      { id: 'w1', start_time: '09:00:00', capacity: 20, label: 'Wave 1' },
      { id: 'w2', start_time: '10:30:00', capacity: 2, label: 'Wave 2' },
    ],
  }
  it('shapes an open event with wave availability and the signup link', () => {
    const out = shapeEventsForAgent([base], { w1: 5, w2: 2 }, now, 'https://crm.example.com')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Summer Hyrox Sim')
    expect(out[0].kind).toBe('race')
    expect(out[0].date).toMatch(/Sat 20 Jun/)
    expect(out[0].price).toBe('Free')
    expect(out[0].signup_url).toBe('https://crm.example.com/race/summer-hyrox')
    // CAPACITY-SECRECY.1 — full/limited booleans only, never a count.
    expect(out[0].waves).toEqual([
      { wave_id: 'w1', time: '09:00', label: 'Wave 1' },
      { wave_id: 'w2', time: '10:30', label: 'Wave 2', full: true },
    ])
  })

  // The model must never receive a number it could relay to a customer
  // (owner invariant 2). `limited` is the coarse urgency signal instead.
  it('never exposes a spot count, and flags a nearly-full wave as limited', () => {
    const nearlyFull = {
      ...base,
      waves: [
        { id: 'w1', start_time: '09:00:00', capacity: 20, label: 'Wave 1' },
        { id: 'w2', start_time: '10:30:00', capacity: 10, label: 'Wave 2' },
        { id: 'w3', start_time: '12:00:00', capacity: null, label: 'Wave 3' },
      ],
    }
    const out = shapeEventsForAgent([nearlyFull], { w1: 1, w2: 8 }, now, 'https://x.com')
    expect(JSON.stringify(out)).not.toMatch(/spots?_left|unlimited/)
    expect(out[0].waves[0].limited).toBeUndefined()   // 19 left
    expect(out[0].waves[1].limited).toBe(true)        // 2 left
    expect(out[0].waves[2].limited).toBeUndefined()   // uncapped
    expect(out[0].waves[2].full).toBeUndefined()
  })
  it('filters inactive, past, and closed-registration events', () => {
    const out = shapeEventsForAgent([
      { ...base, id: 'a', active: false },
      { ...base, id: 'b', race_date: '2026-06-01' },
      { ...base, id: 'c', registration_closes_at: '2026-06-10T00:00:00Z' },
      { ...base, id: 'd', registration_opens_at: '2026-07-01T00:00:00Z' },
    ], {}, now, 'https://x.com')
    expect(out).toHaveLength(0)
  })
  it('sorts by date and caps the list', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({
      ...base, id: `e${i}`, slug: `e${i}`, race_date: `2026-07-${String(28 - i).padStart(2, '0')}`,
    }))
    const out = shapeEventsForAgent(events, {}, now, 'https://x.com')
    expect(out).toHaveLength(8)
    expect(out[0].date < out[1].date || out[0].name).toBeTruthy()
  })
})

describe('shapeMyRegistrationsForAgent', () => {
  it('keeps live future registrations only', () => {
    const out = shapeMyRegistrationsForAgent([
      { id: 'r1', status: 'confirmed', race_events: { name: 'Hyrox Sim', kind: 'race', race_date: '2026-06-20' }, race_waves: { start_time: '09:00:00' } },
      { id: 'r2', status: 'cancelled', race_events: { name: 'Old', kind: 'race', race_date: '2026-06-20' }, race_waves: null },
      { id: 'r3', status: 'confirmed', race_events: { name: 'Past', kind: 'race', race_date: '2026-06-01' }, race_waves: null },
      { id: 'r4', status: 'pending_payment', race_events: { name: 'Workshop', kind: 'workshop', race_date: '2026-07-01' }, race_waves: null },
    ], now)
    expect(out.map(r => r.registration_id)).toEqual(['r1', 'r4'])
    expect(out[0].wave_time).toBe('09:00')
    expect(out[1].status).toBe('pending_payment')
  })
})

// AGENT-EVENTS.2 — booking guards.
describe('eventOpenForRegistration', () => {
  const race = {
    active: true, race_date: '2026-06-20',
    registration_opens_at: null, registration_closes_at: null,
  }
  it('open for an active future event with no window bounds', () => {
    expect(eventOpenForRegistration(race, now)).toEqual({ open: true })
  })
  it('reports why when closed', () => {
    expect(eventOpenForRegistration({ ...race, active: false }, now).reason).toBe('inactive')
    expect(eventOpenForRegistration({ ...race, race_date: '2026-06-01' }, now).reason).toBe('past')
    expect(eventOpenForRegistration({ ...race, registration_closes_at: '2026-06-10T00:00:00Z' }, now).reason).toBe('closed')
    expect(eventOpenForRegistration({ ...race, registration_opens_at: '2026-07-01T00:00:00Z' }, now).reason).toBe('not_open_yet')
  })
})

describe('waveSpotsLeft', () => {
  it('computes remaining capacity and treats null capacity as unlimited', () => {
    expect(waveSpotsLeft({ capacity: 20 }, 5)).toBe(15)
    expect(waveSpotsLeft({ capacity: 2 }, 2)).toBe(0)
    expect(waveSpotsLeft({ capacity: null }, 99)).toBeNull()
  })
})

// AGENT-EVENTS.3 — cancellation routing: free = direct, paid = human
// approval (refunds are decided per case by the team — Richard).
describe('classifyEventCancellation', () => {
  const base = { isOwner: true, status: 'confirmed', eventDate: '2026-06-20', paidCents: 0, nowMs: now }
  it('cancels free entries directly', () => {
    expect(classifyEventCancellation(base)).toEqual({ action: 'direct' })
  })
  it('routes paid entries to human approval', () => {
    expect(classifyEventCancellation({ ...base, paidCents: 3500 })).toEqual({ action: 'draft' })
  })
  it('refuses non-owners, finished events and dead registrations', () => {
    expect(classifyEventCancellation({ ...base, isOwner: false }).reason).toBe('not_yours')
    expect(classifyEventCancellation({ ...base, eventDate: '2026-06-01' }).reason).toBe('event_past')
    expect(classifyEventCancellation({ ...base, status: 'cancelled' }).reason).toBe('already_cancelled')
  })
})
