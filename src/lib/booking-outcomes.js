// BOOKINGOUTCOME.1 — did a consultation booker show up?
//
// A booking (the Calendly-style /book/[slug] kind) stays 'confirmed' until
// staff record what happened: 'completed' (they showed) or 'no_show'. A
// booking "needs an outcome" when it is still 'confirmed' and its END has
// passed. The end is booking_date + end_time, a WALL CLOCK in the booking's
// studio zone, so it is read with zonedWallClockToInstant in that zone (never
// `new Date(`${d}T${t}Z`)`, which is off by the zone's offset). An end_time
// earlier than the start_time runs past midnight into the next day.
//
// Server-side helpers (the paged read takes a service-role client); the pure
// parts are shared by /bookings, the bulk route and the booking type page.
import { zonedWallClockToInstant, todayStrIn, addDaysIn, DEFAULT_TZ } from '@/lib/location-time'
import { selectAll } from '@/lib/select-all'

/** A contact at one of these funnel stages counts as "now a member". */
export const MEMBER_STAGE_SLUGS = Object.freeze(['member', 'pack_member'])
/** The statuses an outcome may set. */
export const OUTCOME_STATUSES = Object.freeze(['completed', 'no_show'])
/** At most this many rows are listed on the Needs outcome tab. */
export const NEEDS_OUTCOME_CAP = 2000

/**
 * UTC ms when the booking ends, read in `zone`; null when the date or time
 * cannot be read (callers treat that as "not ended", never guess).
 * @param {{ booking_date?: string, start_time?: string, end_time?: string }|null} booking
 * @param {string} zone IANA zone of the booking's studio
 * @returns {number|null}
 */
export function bookingEndMs(booking, zone = DEFAULT_TZ) {
  if (!booking) return null
  const { booking_date: date, start_time: start, end_time: end } = booking
  const sameDay = zonedWallClockToInstant(date, end, zone)
  if (sameDay == null) return null
  // 'HH:MM[:SS]' strings compare in clock order. An end before the start is
  // the next calendar day (a 23:30 to 00:30 slot).
  if (typeof start === 'string' && String(end) < start) {
    return zonedWallClockToInstant(addDaysIn(date, 1, zone), end, zone)
  }
  return sameDay
}

/**
 * Why a booking cannot take an outcome now, or null when it can.
 * @returns {null|'not_confirmed'|'bad_time'|'not_ended'}
 */
export function judgeOutcomeTarget(booking, zone = DEFAULT_TZ, nowMs = Date.now()) {
  if (booking?.status !== 'confirmed') return 'not_confirmed'
  const end = bookingEndMs(booking, zone)
  if (end == null) return 'bad_time'
  if (end > nowMs) return 'not_ended'
  return null
}

/** Still 'confirmed' and its end (in the studio zone) has passed. */
export function needsOutcome(booking, zone = DEFAULT_TZ, nowMs = Date.now()) {
  return judgeOutcomeTarget(booking, zone, nowMs) === null
}

/**
 * The outcomes summary for a set of bookings (one booking type's).
 * `nowMembers` counts distinct booker contacts whose pipeline_stage_slug is a
 * member stage; `showRate` is the percent of decided bookings that showed
 * (null until one is decided).
 * @param {Array<{ status?: string, contacts?: { id?: string, pipeline_stage_slug?: string }|null }>} bookings
 */
export function summarizeBookingOutcomes(bookings, zone = DEFAULT_TZ, nowMs = Date.now()) {
  const out = { total: 0, showed: 0, noShow: 0, cancelled: 0, awaiting: 0, upcoming: 0, nowMembers: 0, showRate: null }
  const members = new Set()
  for (const b of bookings || []) {
    out.total += 1
    if (b.status === 'completed') out.showed += 1
    else if (b.status === 'no_show') out.noShow += 1
    else if (b.status === 'cancelled') out.cancelled += 1
    else if (b.status === 'confirmed') {
      if (needsOutcome(b, zone, nowMs)) out.awaiting += 1
      else out.upcoming += 1
    }
    const c = b.contacts
    if (c?.id && MEMBER_STAGE_SLUGS.includes(c.pipeline_stage_slug)) members.add(c.id)
  }
  out.nowMembers = members.size
  const decided = out.showed + out.noShow
  out.showRate = decided ? Math.round((out.showed / decided) * 100) : null
  return out
}

// Named columns: rows from this read reach client components (the outcome
// buttons and the bulk action take their ids).
const NEEDS_OUTCOME_COLUMNS =
  'id, status, booking_date, start_time, end_time, customer_name, customer_email, customer_phone, event_types(name, color), contacts(id, name)'

/**
 * Every booking at one studio that needs an outcome, newest first. Paged
 * under the 1,000-row cap with a stable order, stopping at NEEDS_OUTCOME_CAP.
 * Throws when a page cannot be read (never an empty list that reads as
 * "nothing to do").
 * @param {object} db service-role client
 * @param {string|null|undefined} locationId the studio
 * @param {string} zone that studio's zone
 * @param {{ nowMs?: number, hardCap?: number }} [opts]
 * @returns {Promise<{ bookings: object[], truncated: boolean }>}
 */
export async function listNeedsOutcome(db, locationId, zone = DEFAULT_TZ, { nowMs = Date.now(), hardCap = NEEDS_OUTCOME_CAP } = {}) {
  if (!locationId) return { bookings: [], truncated: false }
  // On or before the studio's today: anything later cannot have ended (an
  // overnight slot is dated by its start, so it is in range too).
  const today = todayStrIn(zone, nowMs)
  const rows = await selectAll((from, to) => db.from('bookings')
    .select(NEEDS_OUTCOME_COLUMNS)
    .eq('location_id', locationId)
    .eq('status', 'confirmed')
    .lte('booking_date', today)
    .order('booking_date', { ascending: false })
    .order('start_time', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to), { hardCap })
  return {
    bookings: rows.filter((b) => needsOutcome(b, zone, nowMs)),
    truncated: rows.length >= hardCap,
  }
}
