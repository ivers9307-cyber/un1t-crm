// MIACONSULT.1 — consultation slots carry their own date, and booking takes the
// listed slot.
//
// Live incident (Hatch Street, Mon 19 Oct 2026): the customer said "Friday",
// Mia listed 2026-10-23 and offered "Friday at 9:20, 11am, or 2:30pm". On the
// next turn she said "Friday 24th at 11am" and then called book_consultation
// with 2026-10-24 (a Saturday): the model had recomputed the date from the
// weekday word, because the tool result (and its date) does not survive into
// the next turn's history, and the book tool accepted any free date/time. When
// Saturday was refused she told the customer the 11am "just got taken".
//
// These tests pin the structural fix: every slot carries a studio-zoned label
// (weekday + day + month) and a slot_id; book_consultation only books a slot on
// a date list_consultation_slots returned in this conversation, and a refusal
// names its precise reason (not_a_listed_slot / slot_taken / wrong_date).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/sequences', () => ({
  triggerSequencesForBooking: vi.fn(async () => {}),
  triggerSequencesForFirstBooking: vi.fn(async () => {}),
}))
vi.mock('@/lib/booking-confirmations', () => ({ sendBookingConfirmation: vi.fn(async () => {}) }))

import { executeBookingTool, consultationSlotLabel, consultationSlotId, BOOKING_TOOLS } from './booking-tools'
import { resetLocationZoneCache } from '@/lib/location-time'
import { buildCustomerSystemPromptParts } from './prompt'

const LOC = 'loc-hatch'
const CONV = 'faea7584-18d3-405e-8b1a-95493ac089e2'

// Fri: two windows (09:00-12:00, 14:00-16:00) on a 60-minute grid; Sat and Mon
// one window. The grid is what was offered; bookings take slots out of it.
const EVENT_TYPE = {
  id: 'et-consult',
  name: 'Consultation',
  slug: 'consultation',
  duration_minutes: 60,
  buffer_minutes: 0,
  availability: {
    fri: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '16:00' }],
    sat: [{ start: '09:00', end: '12:00' }],
    mon: [{ start: '09:00', end: '12:00' }],
  },
  max_advance_days: 30,
  location_id: LOC,
}

/**
 * A db double for the consultation paths. `state.booked[date]` is the day's
 * confirmed bookings (mutable: a slot can be taken "meanwhile"),
 * `state.decisions` the agent_decisions rows of earlier turns, `state.inserts`
 * every bookings insert.
 */
function makeDb(state) {
  return {
    from(table) {
      const filters = {}
      let inserted = null
      const b = {
        select: () => b,
        eq: (col, val) => { filters[col] = val; return b },
        neq: () => b,
        in: () => b,
        gte: (col, val) => { filters[`gte:${col}`] = val; return b },
        or: () => b,
        order: () => b,
        limit: () => b,
        insert(row) { inserted = row; return b },
        update: () => b,
        async maybeSingle() {
          if (table === 'locations') return { data: { id: LOC, timezone: state.zone }, error: null }
          if (table === 'contacts') return { data: { first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@example.com', phone: '353870000001' }, error: null }
          if (table === 'event_types') return { data: null, error: null }
          return { data: null, error: null }
        },
        async single() {
          if (table === 'bookings' && inserted) {
            state.inserts.push(inserted)
            return { data: { id: `bk-${state.inserts.length}`, ...inserted }, error: null }
          }
          return { data: { id: 'req-1' }, error: null }
        },
        then(resolve, reject) {
          let out = { data: [], error: null }
          if (table === 'event_types') out = { data: [EVENT_TYPE], error: null }
          else if (table === 'bookings') {
            if (state.bookingsReadError) out = { data: null, error: { message: 'bookings unreadable' } }
            else out = { data: (state.booked[filters.booking_date] || []).map((s) => ({ start_time: `${s}:00`, end_time: `${String(Number(s.slice(0, 2)) + 1).padStart(2, '0')}:00:00` })), error: null }
          } else if (table === 'agent_decisions') {
            state.decisionReads.push({ ...filters })
            out = state.decisionsError ? { data: null, error: { message: 'down' } } : { data: state.decisions, error: null }
          }
          return Promise.resolve(out).then(resolve, reject)
        },
      }
      return b
    },
  }
}

function newState(over = {}) {
  return { zone: 'Europe/Dublin', booked: {}, decisions: [], decisionReads: [], inserts: [], ...over }
}

function ctxFor(db, over = {}) {
  return {
    db,
    locationId: LOC,
    conversationId: CONV,
    channel: 'whatsapp',
    contactId: 'c-lead',
    verifiedContactId: null,
    zone: 'Europe/Dublin',
    settings: {},
    canBook: true,
    consultationDatesListed: new Set(),
    ...over,
  }
}

// An earlier turn's agent_decisions row, as compactDecisionMeta writes it.
const decisionListing = (date) => ({ meta: { tools: [{ name: 'list_consultation_slots', input: JSON.stringify({ date }) }] } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Mon 19 Oct 2026, 10:00 in Dublin (IST, UTC+1).
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 9, 0, 0)))
  resetLocationZoneCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('consultationSlotLabel: weekday + day + month in the studio zone', () => {
  it('labels the incident slots with their own weekday', () => {
    expect(consultationSlotLabel('2026-10-23', '11:00', 'Europe/Dublin')).toBe('Fri 23 Oct, 11:00')
    expect(consultationSlotLabel('2026-10-24', '11:00', 'Europe/Dublin')).toBe('Sat 24 Oct, 11:00')
  })
  it('keeps the wall clock on both sides of the Dublin DST change (Sun 25 Oct 2026)', () => {
    expect(consultationSlotLabel('2026-10-24', '09:00', 'Europe/Dublin')).toBe('Sat 24 Oct, 09:00')
    expect(consultationSlotLabel('2026-10-26', '09:00', 'Europe/Dublin')).toBe('Mon 26 Oct, 09:00')
  })
  it('keeps the wall clock on both sides of the New York DST change (Sun 1 Nov 2026)', () => {
    expect(consultationSlotLabel('2026-10-31', '09:00', 'America/New_York')).toBe('Sat 31 Oct, 09:00')
    expect(consultationSlotLabel('2026-11-02', '09:00', 'America/New_York')).toBe('Mon 2 Nov, 09:00')
  })
  it('slot_id is the exact date + time pair', () => {
    expect(consultationSlotId('2026-10-23', '11:00')).toBe('2026-10-23T11:00')
  })
})

describe('list_consultation_slots', () => {
  it('returns each slot with a slot_id and a studio-zoned label, and the day label', async () => {
    const state = newState()
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('list_consultation_slots', { date: '2026-10-23' }, ctx)
    expect(out.date).toBe('2026-10-23')
    expect(out.day_label).toBe('Fri 23 Oct')
    expect(out.slots[0]).toEqual({ slot_id: '2026-10-23T09:00', label: 'Fri 23 Oct, 09:00', start: '09:00', end: '10:00' })
    expect(out.slots.map((s) => s.label)).toContain('Fri 23 Oct, 11:00')
    expect(ctx.consultationDatesListed.has('2026-10-23')).toBe(true)
  })
  it('labels a slot after the DST change at a New York studio in that zone', async () => {
    const state = newState({ zone: 'America/New_York' })
    const ctx = ctxFor(makeDb(state), { zone: 'America/New_York' })
    const out = await executeBookingTool('list_consultation_slots', { date: '2026-11-02' }, ctx)
    expect(out.day_label).toBe('Mon 2 Nov')
    expect(out.slots[0].label).toBe('Mon 2 Nov, 09:00')
  })
})

describe('book_consultation takes the listed slot', () => {
  it('books with the slot_id the list returned (same turn)', async () => {
    const state = newState()
    const ctx = ctxFor(makeDb(state))
    const list = await executeBookingTool('list_consultation_slots', { date: '2026-10-23' }, ctx)
    const pick = list.slots.find((s) => s.start === '11:00')
    const out = await executeBookingTool('book_consultation', { slot_id: pick.slot_id, confirmed_label: pick.label }, ctx)
    expect(out.booked).toBe(true)
    expect(out.label).toBe('Fri 23 Oct, 11:00')
    expect(out.slot_id).toBe('2026-10-23T11:00')
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0]).toMatchObject({ booking_date: '2026-10-23', start_time: '11:00', end_time: '12:00', source: 'agent' })
  })

  it('books a slot listed in an EARLIER turn (read from agent_decisions for this conversation)', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23')] })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:00' }, ctx)
    expect(out.booked).toBe(true)
    expect(state.decisionReads[0]).toMatchObject({ conversation_id: CONV, channel: 'whatsapp' })
  })

  it('INCIDENT REPLAY: Friday was listed, Saturday 24th is refused as not_a_listed_slot with no insert', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23')] })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { date: '2026-10-24', start_time: '11:00' }, ctx)
    expect(out.booked).toBe(false)
    expect(out.reason).toBe('not_a_listed_slot')
    expect(out.error).toBe('not_a_listed_slot')
    expect(out.requested).toBe('Sat 24 Oct, 11:00')
    expect(out.offered_days).toEqual(['Fri 23 Oct'])
    // The message must not let Mia say the slot was taken.
    expect(out.message).toMatch(/never offered/i)
    expect(out.message).toMatch(/do not say .*taken/i)
    expect(state.inserts).toHaveLength(0)
  })

  it('refuses a time that was never on the listed day\'s grid as not_a_listed_slot', async () => {
    const state = newState()
    const ctx = ctxFor(makeDb(state))
    await executeBookingTool('list_consultation_slots', { date: '2026-10-23' }, ctx)
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:30' }, ctx)
    expect(out.reason).toBe('not_a_listed_slot')
    expect(state.inserts).toHaveLength(0)
  })

  it('a slot taken meanwhile is refused with slot_taken', async () => {
    const state = newState()
    const ctx = ctxFor(makeDb(state))
    const list = await executeBookingTool('list_consultation_slots', { date: '2026-10-23' }, ctx)
    expect(list.slots.map((s) => s.start)).toContain('11:00')
    state.booked['2026-10-23'] = ['11:00']
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:00' }, ctx)
    expect(out.booked).toBe(false)
    expect(out.reason).toBe('slot_taken')
    expect(out.requested).toBe('Fri 23 Oct, 11:00')
    expect(state.inserts).toHaveLength(0)
  })

  it('a confirmed label whose weekday or day disagrees with the slot is refused with wrong_date', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23'), decisionListing('2026-10-24')] })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { date: '2026-10-24', start_time: '11:00', confirmed_label: 'Friday 24th at 11am' }, ctx)
    expect(out.booked).toBe(false)
    expect(out.reason).toBe('wrong_date')
    expect(out.requested).toBe('Sat 24 Oct, 11:00')
    expect(state.inserts).toHaveLength(0)
  })

  it('a slot_id that disagrees with an explicit date is refused with wrong_date', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23')] })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:00', date: '2026-10-24', start_time: '11:00' }, ctx)
    expect(out.reason).toBe('wrong_date')
    expect(state.inserts).toHaveLength(0)
  })

  it('a matching confirmed label books', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23')] })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:00', confirmed_label: 'Friday 23rd at 11am' }, ctx)
    expect(out.booked).toBe(true)
  })

  it('an unreadable bookings table fails closed (no insert, no "taken" claim)', async () => {
    const state = newState({ decisions: [decisionListing('2026-10-23')], bookingsReadError: true })
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { slot_id: '2026-10-23T11:00' }, ctx)
    expect(out.booked).toBe(false)
    expect(out.reason).toBe('availability_unreadable')
    expect(state.inserts).toHaveLength(0)
  })

  it('a malformed slot_id is refused as not_a_listed_slot', async () => {
    const state = newState()
    const ctx = ctxFor(makeDb(state))
    const out = await executeBookingTool('book_consultation', { slot_id: 'friday-11am' }, ctx)
    expect(out.reason).toBe('not_a_listed_slot')
  })
})

describe('tool schema', () => {
  it('book_consultation requires the slot_id and the label confirmed with the customer', () => {
    const t = BOOKING_TOOLS.find((x) => x.name === 'book_consultation')
    expect(t.input_schema.required).toEqual(['slot_id', 'confirmed_label'])
    // date + start_time left the schema (the executor still accepts the pair).
    expect(Object.keys(t.input_schema.properties)).not.toContain('date')
    expect(t.description).toMatch(/never work a date out from a weekday name/i)
  })
})

describe('Context carries today\'s weekday as well as the date', () => {
  it('renders the ISO date first, then the weekday and day', () => {
    const { volatile } = buildCustomerSystemPromptParts({ businessName: 'UN1T', today: '2026-10-19' })
    expect(volatile).toContain("- Today's date: 2026-10-19 (Monday 19 October 2026)")
  })
  it('the weekday follows the date it is given (a zoned today), not the machine clock', () => {
    const { volatile } = buildCustomerSystemPromptParts({ today: '2026-10-25' })
    expect(volatile).toContain('(Sunday 25 October 2026)')
  })
  it('the stable prompt tells Mia to carry the label and slot_id, never recompute a date', () => {
    const { stable } = buildCustomerSystemPromptParts({ businessName: 'UN1T' })
    expect(stable).toMatch(/slot_id/)
    expect(stable).toMatch(/never work out a date from a weekday name/i)
  })
})
