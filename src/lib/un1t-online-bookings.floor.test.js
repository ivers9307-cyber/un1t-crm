// UN1TBOOK.5 — Review Focus 5, end to end through the real scorecard math.
//
// The two un1t.online projections (events → class_occurrences, bookings →
// class_bookings) are fed, in the shape fetchFloor reads them
// (shared/studio-kpis.js), into the real computeFloor
// (shared/studio-kpi-math.js). This pins what no mocked page test can:
//   - a past un1t class nobody marked stays booked → BOOKED/attended=false and
//     counts as a no-show, exactly as an unmarked Glofox booking does;
//   - a no_show counts as a no-show and an attended as an attended visit;
//   - a cancelled booking (CANCELLED) is outside the denominator;
//   - a booking on a cancelled class is excluded (its occurrence is dropped by
//     fetchFloor's .is('cancelled_at', null));
//   - both projections share the un1t: event id, so a booking joins its
//     class at all. A drift in either prefix would empty the join and the
//     no-show rate would read null, not a number.
// Fictional ids only: the repo is public.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { computeFloor } from '@shared/studio-kpi-math'
import { mapUn1tEventToOccurrence } from './un1t-online-occurrences.js'
import { mapUn1tBookingToClassBooking } from './un1t-online-bookings.js'

const LOC = 'loc-hatch'
const NOW = '2026-10-17T10:00:00.000Z'

const PAST_EVENT = {
  un1t_id: 'evt-past',
  title: 'HYROX Tuesday',
  status: 'scheduled',
  starts_at: '2026-10-14T17:30:00.000Z',
  ends_at: '2026-10-14T18:30:00.000Z',
  capacity: 10,
  bookings_count: 4,
}
const CANCELLED_EVENT = {
  un1t_id: 'evt-cancelled',
  title: 'Strength Wednesday',
  status: 'cancelled',
  starts_at: '2026-10-15T07:00:00.000Z',
  ends_at: '2026-10-15T08:00:00.000Z',
  capacity: 10,
  bookings_count: 1,
}

const booking = (un1tId, event, status) => ({
  un1t_id: un1tId,
  event_id: event.un1t_id,
  status,
  source: 'app',
  credit_charged: true,
  contact_id: `contact-${un1tId}`,
})

const BOOKINGS = [
  [booking('bk-unmarked', PAST_EVENT, 'booked'), PAST_EVENT],
  [booking('bk-no-show', PAST_EVENT, 'no_show'), PAST_EVENT],
  [booking('bk-attended', PAST_EVENT, 'attended'), PAST_EVENT],
  [booking('bk-cancelled', PAST_EVENT, 'cancelled'), PAST_EVENT],
  [booking('bk-on-cancelled-class', CANCELLED_EVENT, 'booked'), CANCELLED_EVENT],
]

/** The occurrences exactly as fetchFloor reads and shapes them (shared/studio-kpis.js). */
function floorOccurrences() {
  return [PAST_EVENT, CANCELLED_EVENT]
    .map((e) => mapUn1tEventToOccurrence(e, { locationId: LOC, nowIso: NOW }))
    .filter((o) => o.cancelled_at == null) // .is('cancelled_at', null)
    .map((o) => ({
      glofox_event_id: o.glofox_event_id,
      name: o.name,
      instructor: o.instructor,
      capacity: o.capacity,
      starts_at: o.starts_at,
      booked: Number(o.raw?.booked) || 0,
    }))
}

/** The bookings exactly as fetchFloor selects them (glofox_event_id, contact_id, status, attended, starts_at). */
function floorBookings() {
  return BOOKINGS
    .map(([b, e]) => mapUn1tBookingToClassBooking(b, { locationId: LOC, event: e, nowIso: NOW }))
    .map(({ glofox_event_id, contact_id, status, attended, starts_at }) => ({ glofox_event_id, contact_id, status, attended, starts_at }))
}

describe('un1t.online projections through computeFloor (Review Focus 5)', () => {
  it('both projections key the same class by the same un1t: event id', () => {
    const occ = [PAST_EVENT, CANCELLED_EVENT].map((e) => mapUn1tEventToOccurrence(e, { locationId: LOC, nowIso: NOW }))
    const byUn1tId = new Map(occ.map((o, i) => [[PAST_EVENT, CANCELLED_EVENT][i].un1t_id, o.glofox_event_id]))
    for (const [b, e] of BOOKINGS) {
      const row = mapUn1tBookingToClassBooking(b, { locationId: LOC, event: e, nowIso: NOW })
      expect(row.glofox_event_id).toBe(byUn1tId.get(e.un1t_id))
      expect(row.glofox_event_id).toBe(`un1t:${e.un1t_id}`)
    }
    // The cancelled class is the one fetchFloor drops.
    expect(occ.map((o) => o.cancelled_at == null)).toEqual([true, false])
  })

  it('an unmarked past booking and a no_show are no-shows, attended is a visit, cancelled is outside the denominator', () => {
    const bookings = floorBookings()
    expect(bookings.map((b) => [b.status, b.attended])).toEqual([
      ['BOOKED', false], // booked, nobody marked it
      ['BOOKED', false], // no_show
      ['BOOKED', true], // attended
      ['CANCELLED', false], // cancelled
      ['BOOKED', false], // booked, on the cancelled class
    ])

    const floor = computeFloor(floorOccurrences(), bookings)
    // 2 no-shows (unmarked + no_show) of 3 BOOKED on a surviving class.
    // The cancelled booking is not in the denominator (else 2/4 = 50), and the
    // booking on the cancelled class is excluded (else 3/4 = 75).
    expect(floor.noShowPct).toBe(67)
    expect(floor.attendedVisits).toBe(1)
    expect(floor.classes).toBe(1)
    expect(floor.fillPct).toBe(40)
    expect(floor.groupedBy).toBe('class')
    expect(floor.groupTable).toEqual([{ label: 'HYROX Tuesday', classes: 1, fillPct: 40, noShowPct: 67 }])
  })
})
