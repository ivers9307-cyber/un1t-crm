// BOOKINGOUTCOME.1 — which consultation bookings still need an outcome, and
// the per-booking-type outcomes summary. booking_date + end_time is a wall
// clock in the booking's studio zone, so the "has it ended" call is tested in
// Europe/Dublin AND America/New_York, on both sides of each zone's DST change.
import { describe, it, expect } from 'vitest'
import {
  bookingEndMs,
  needsOutcome,
  judgeOutcomeTarget,
  summarizeBookingOutcomes,
  listNeedsOutcome,
  NEEDS_OUTCOME_CAP,
} from './booking-outcomes.js'

const DUBLIN = 'Europe/Dublin'
const NY = 'America/New_York'
const at = (iso) => Date.parse(iso)
const bk = (booking_date, start_time, end_time, status = 'confirmed', extra = {}) =>
  ({ id: `${booking_date}-${start_time}`, booking_date, start_time, end_time, status, ...extra })

describe('bookingEndMs: the end is a wall clock in the studio zone', () => {
  it('Dublin, the day before the clocks go back (IST, UTC+1): 10:00 is 09:00Z', () => {
    expect(bookingEndMs(bk('2026-10-24', '09:00:00', '10:00:00'), DUBLIN)).toBe(at('2026-10-24T09:00:00Z'))
  })
  it('Dublin, the day the clocks go back (GMT): 10:00 is 10:00Z', () => {
    expect(bookingEndMs(bk('2026-10-25', '09:00:00', '10:00:00'), DUBLIN)).toBe(at('2026-10-25T10:00:00Z'))
  })
  it('Dublin, spring forward (29 Mar 2026): before is GMT, after is IST', () => {
    expect(bookingEndMs(bk('2026-03-28', '09:00', '10:00'), DUBLIN)).toBe(at('2026-03-28T10:00:00Z'))
    expect(bookingEndMs(bk('2026-03-29', '09:00', '10:00'), DUBLIN)).toBe(at('2026-03-29T09:00:00Z'))
  })
  it('New York, the day before fall back (EDT, UTC-4): 10:00 is 14:00Z', () => {
    expect(bookingEndMs(bk('2026-10-31', '09:00', '10:00'), NY)).toBe(at('2026-10-31T14:00:00Z'))
  })
  it('New York, fall back day (EST, UTC-5): 10:00 is 15:00Z', () => {
    expect(bookingEndMs(bk('2026-11-01', '09:00', '10:00'), NY)).toBe(at('2026-11-01T15:00:00Z'))
  })
  it('New York, spring forward (8 Mar 2026)', () => {
    expect(bookingEndMs(bk('2026-03-07', '09:00', '10:00'), NY)).toBe(at('2026-03-07T15:00:00Z'))
    expect(bookingEndMs(bk('2026-03-08', '09:00', '10:00'), NY)).toBe(at('2026-03-08T14:00:00Z'))
  })
  it('an end earlier than the start runs past midnight into the next day', () => {
    // 23:30 to 00:30 on 24 Oct, Dublin: ends 00:30 IST on the 25th = 23:30Z on the 24th.
    expect(bookingEndMs(bk('2026-10-24', '23:30', '00:30'), DUBLIN)).toBe(at('2026-10-24T23:30:00Z'))
  })
  it('an unreadable date or time is null, never a guess', () => {
    expect(bookingEndMs(bk('2026-02-30', '09:00', '10:00'), DUBLIN)).toBeNull()
    expect(bookingEndMs(bk('2026-10-24', '09:00', null), DUBLIN)).toBeNull()
    expect(bookingEndMs(null, DUBLIN)).toBeNull()
  })
})

describe('needsOutcome: confirmed AND ended', () => {
  // 09:30Z on 25 Oct: the IST booking of the 24th ended at 09:00Z the day
  // before; a naive `${d}T${t}Z` read would still say so, so the sharper case
  // is the same instant one day earlier.
  it('Dublin: 09:30Z on 24 Oct, a 10:00 IST end (09:00Z) has passed', () => {
    expect(needsOutcome(bk('2026-10-24', '09:00', '10:00'), DUBLIN, at('2026-10-24T09:30:00Z'))).toBe(true)
  })
  it('Dublin: 09:30Z on 25 Oct, a 10:00 GMT end (10:00Z) has not', () => {
    expect(needsOutcome(bk('2026-10-25', '09:00', '10:00'), DUBLIN, at('2026-10-25T09:30:00Z'))).toBe(false)
  })
  it('New York: 14:30Z, the EDT booking has ended, the EST one has not', () => {
    expect(needsOutcome(bk('2026-10-31', '09:00', '10:00'), NY, at('2026-10-31T14:30:00Z'))).toBe(true)
    expect(needsOutcome(bk('2026-11-01', '09:00', '10:00'), NY, at('2026-11-01T14:30:00Z'))).toBe(false)
  })
  it('the same wall clock is a different instant in each zone', () => {
    const b = bk('2026-11-01', '09:00', '10:00')
    const now = at('2026-11-01T12:00:00Z')
    expect(needsOutcome(b, DUBLIN, now)).toBe(true) // 10:00 GMT has passed
    expect(needsOutcome(b, NY, now)).toBe(false) // 10:00 EST is 15:00Z
  })
  it('the end instant itself counts as ended', () => {
    expect(needsOutcome(bk('2026-10-25', '09:00', '10:00'), DUBLIN, at('2026-10-25T10:00:00Z'))).toBe(true)
  })
  it.each(['completed', 'no_show', 'cancelled'])('a %s booking never needs one', (status) => {
    expect(needsOutcome(bk('2026-01-01', '09:00', '10:00', status), DUBLIN, at('2026-10-01T00:00:00Z'))).toBe(false)
  })
  it('an unreadable end is not "ended"', () => {
    expect(needsOutcome(bk('2026-01-01', '09:00', 'soon'), DUBLIN, at('2026-10-01T00:00:00Z'))).toBe(false)
  })
})

describe('judgeOutcomeTarget: the reason a booking cannot take an outcome', () => {
  const now = at('2026-10-24T12:00:00Z')
  it('ok for a confirmed booking that has ended', () => {
    expect(judgeOutcomeTarget(bk('2026-10-24', '09:00', '10:00'), DUBLIN, now)).toBeNull()
  })
  it('not_confirmed for anything already decided', () => {
    expect(judgeOutcomeTarget(bk('2026-10-24', '09:00', '10:00', 'completed'), DUBLIN, now)).toBe('not_confirmed')
  })
  it('not_ended for one still to come', () => {
    expect(judgeOutcomeTarget(bk('2026-10-24', '15:00', '16:00'), DUBLIN, now)).toBe('not_ended')
  })
  it('bad_time when the end cannot be read', () => {
    expect(judgeOutcomeTarget(bk('2026-10-24', '09:00', 'x'), DUBLIN, now)).toBe('bad_time')
  })
})

describe('summarizeBookingOutcomes', () => {
  const now = at('2026-10-24T12:00:00Z')
  const rows = [
    bk('2026-10-01', '09:00', '10:00', 'completed', { id: 'a', contacts: { id: 'c1', pipeline_stage_slug: 'member' } }),
    bk('2026-10-02', '09:00', '10:00', 'completed', { id: 'b', contacts: { id: 'c2', pipeline_stage_slug: 'trial' } }),
    bk('2026-10-03', '09:00', '10:00', 'no_show', { id: 'c', contacts: { id: 'c3', pipeline_stage_slug: 'pack_member' } }),
    bk('2026-10-04', '09:00', '10:00', 'cancelled', { id: 'd', contacts: null }),
    bk('2026-10-05', '09:00', '10:00', 'confirmed', { id: 'e', contacts: { id: 'c1', pipeline_stage_slug: 'member' } }),
    bk('2026-10-30', '09:00', '10:00', 'confirmed', { id: 'f', contacts: { id: 'c4', pipeline_stage_slug: 'lead' } }),
  ]
  it('counts each outcome, awaiting = confirmed and ended, members once per contact', () => {
    expect(summarizeBookingOutcomes(rows, DUBLIN, now)).toEqual({
      total: 6,
      showed: 2,
      noShow: 1,
      cancelled: 1,
      awaiting: 1,
      upcoming: 1,
      nowMembers: 2, // c1 (twice) and c3
      showRate: 67, // 2 of the 3 with an outcome
    })
  })
  it('no outcome yet: show rate is null, not 0', () => {
    expect(summarizeBookingOutcomes([], DUBLIN, now)).toMatchObject({ total: 0, showRate: null, nowMembers: 0 })
  })
})

// A recording fake for the paged read: every call to the builder is logged.
function pagedDb(rows) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: [], orders: [] }
      calls.push(q)
      const b = {
        select: (cols) => { q.select = cols; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        lte: (c, v) => { q.filters.push(['lte', c, v]); return b },
        order: (c, o) => { q.orders.push([c, o?.ascending]); return b },
        range: (lo, hi) => { q.range = [lo, hi]; return b },
        then: (res, rej) => Promise.resolve({ data: rows.slice(q.range[0], q.range[1] + 1), error: null }).then(res, rej),
      }
      return b
    },
  }
}

describe('listNeedsOutcome: one studio, paged under the 1,000-row cap', () => {
  const LOC = 'loc-1'
  it('filters to the studio, confirmed, on or before its today, with a stable order, then drops the not-yet-ended', async () => {
    const now = at('2026-10-24T09:30:00Z') // 10:30 IST
    const rows = [
      bk('2026-10-24', '10:00', '11:00', 'confirmed', { id: 'later-today' }),
      bk('2026-10-24', '09:00', '10:00', 'confirmed', { id: 'ended-today' }),
      bk('2026-10-20', '09:00', '10:00', 'confirmed', { id: 'last-week' }),
    ]
    const db = pagedDb(rows)
    const out = await listNeedsOutcome(db, LOC, DUBLIN, { nowMs: now })
    expect(out.bookings.map((b) => b.id)).toEqual(['ended-today', 'last-week'])
    expect(out.truncated).toBe(false)
    const q = db.calls[0]
    expect(q.table).toBe('bookings')
    expect(q.filters).toEqual([['eq', 'location_id', LOC], ['eq', 'status', 'confirmed'], ['lte', 'booking_date', '2026-10-24']])
    expect(q.orders).toEqual([['booking_date', false], ['start_time', false], ['id', true]])
    expect(q.range).toEqual([0, 999])
    expect(q.select).not.toContain('*')
  })

  it("the studio's today is its own: 03:30Z on 1 Nov is still 31 Oct in New York", async () => {
    const db = pagedDb([])
    await listNeedsOutcome(db, LOC, NY, { nowMs: at('2026-11-01T03:30:00Z') })
    expect(db.calls[0].filters).toContainEqual(['lte', 'booking_date', '2026-10-31'])
  })

  it('reads every page past 1,000 rows', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => bk('2026-01-01', '09:00', '10:00', 'confirmed', { id: `r${i}` }))
    const db = pagedDb(rows)
    const out = await listNeedsOutcome(db, LOC, DUBLIN, { nowMs: at('2026-10-24T12:00:00Z') })
    expect(out.bookings).toHaveLength(1500)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
    expect(out.truncated).toBe(false)
  })

  it('stops at the cap and says so', async () => {
    const rows = Array.from({ length: NEEDS_OUTCOME_CAP + 5 }, (_, i) => bk('2026-01-01', '09:00', '10:00', 'confirmed', { id: `r${i}` }))
    const out = await listNeedsOutcome(pagedDb(rows), LOC, DUBLIN, { nowMs: at('2026-10-24T12:00:00Z') })
    expect(out.bookings).toHaveLength(NEEDS_OUTCOME_CAP)
    expect(out.truncated).toBe(true)
  })

  it('a failed read throws, never an empty list', async () => {
    const db = { from: () => {
      const b = { select: () => b, eq: () => b, lte: () => b, order: () => b, range: () => b,
        then: (res, rej) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res, rej) }
      return b
    } }
    await expect(listNeedsOutcome(db, LOC, DUBLIN, { nowMs: Date.now() })).rejects.toThrow(/timeout/)
  })

  it('no studio: nothing read, nothing listed', async () => {
    const db = pagedDb([])
    expect(await listNeedsOutcome(db, null, DUBLIN)).toEqual({ bookings: [], truncated: false })
    expect(db.calls).toHaveLength(0)
  })
})
