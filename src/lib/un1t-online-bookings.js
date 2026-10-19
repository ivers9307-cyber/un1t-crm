// UN1TBOOK.3 / .16 — project a studio's un1t.online bookings into
// class_bookings, the per-class booking roster the studio scorecard
// (no-shows, attended visits), the staff /live roster and the campaign
// outcomes report read. Glofox fills it for Stillorgan (upsertClassBookings);
// this fills it for a un1t.online studio from the un1t_bookings rows the sync
// just mapped, so no extra API call is made. D's write-through (after a CRM
// book or cancel) builds its row with the same mapper, writtenBy 'crm'.
//
// Rules (spec C §3 and §7; all pinned by un1t-online-bookings.test.js):
//   - Explicit statuses (UN1T_STATUS_RANK): booked → BOOKED (rank 0),
//     attended → ATTENDED (attended true), no_show → NO_SHOW, cancelled →
//     CANCELLED (rank 1 each). Any other value, an empty one or null is NOT
//     projected: counted skipped_unknown_status, with one logWarn per run
//     naming the distinct values (the roster cannot know whether it means
//     "coming"). A past BOOKED is undecided on the scorecard
//     (shared/studio-kpi-math.js bookingOutcome), never a no-show.
//   - glofox_booking_id = 'un1t:' + un1t_id, glofox_event_id = 'un1t:' +
//     event_id, glofox_member_id = null, source_platform = 'un1t_online'. The
//     mig 737 namespace CHECK refuses a un1t: id without that platform, and
//     the CRM's reminder and crediting crons act only on rows
//     crmMayActOnClassBooking admits (src/lib/class-booking-platform.js), so a
//     projected row is never reminded, credited or rewarded (decision 7).
//   - raw holds only { un1t: { status, source, credit_charged, has_guest,
//     updated_at, written_by } }, never the booking's own raw (which carries
//     guest details). updated_at is un1t.online's own clock
//     (un1t_bookings.remote_updated_at), null when it gives none, never ours.
//   - member_name is contacts.name; 'Guest' for a booking with no contact
//     where un1t.online says there is a guest, so the coach's count is right.
//   - A booking whose event is unknown (not in this run's pull, not in
//     un1t_events) is skipped and counted, never written with a null
//     starts_at that would overwrite a good one.
//   - A failed names read writes the rows WITHOUT member_name (every row of
//     the run alike, so one bulk upsert never nulls the key for some rows),
//     and existing names are kept.
//   - NEVER deletes and NEVER updates: upsert only. NEVER throws: the sync
//     records the result in its counts, and a failure never fails the run.

import { logWarn } from './log'

const CHUNK = 200
// Reads put every id in the URL's IN-list, so they take smaller chunks than
// the upsert (whose rows travel in the body).
const READ_CHUNK = 100
const PREFIX = 'un1t:'
const SOURCE_PLATFORM = 'un1t_online'
const MAX_ERROR_LEN = 500
const MAX_CLASS_NAME = 200
const GUEST_NAME = 'Guest'
const WRITERS = new Set(['sync', 'crm'])
// The unknown-status warning names at most this many distinct values, each
// cut short: they are un1t.online's enum values, never customer data.
const MAX_LOGGED_STATUSES = 10
const MAX_LOGGED_STATUS_LEN = 40

/**
 * spec C §3 / §7: the rank of each projected status. A terminal status
 * (rank 1) is what a CRM-written BOOKED gives way to (shouldReplaceStored).
 * D imports it.
 */
export const UN1T_STATUS_RANK = Object.freeze({ BOOKED: 0, ATTENDED: 1, NO_SHOW: 1, CANCELLED: 1 })

const STATUS_TABLE = Object.freeze({
  booked: Object.freeze({ status: 'BOOKED', attended: false }),
  attended: Object.freeze({ status: 'ATTENDED', attended: true }),
  no_show: Object.freeze({ status: 'NO_SHOW', attended: false }),
  cancelled: Object.freeze({ status: 'CANCELLED', attended: false }),
})

/** Only code and message ever leave this file (never details / hint). */
function safeError(err) {
  const raw = err?.message || err?.code || (typeof err === 'string' ? err : '') || 'unknown error'
  const s = String(raw)
  return { code: err?.code ?? null, message: s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s }
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const hasValue = (v) => v != null && v !== ''

/**
 * Pure: a un1t.online booking status as class_bookings stores it.
 * @param {string|null|undefined} status
 * @returns {{ status: 'BOOKED'|'ATTENDED'|'NO_SHOW'|'CANCELLED', attended: boolean, rank: 0|1 } | null}
 *   null = not projectable (an unknown value, empty or null).
 */
export function mapUn1tBookingStatus(status) {
  if (status == null) return null
  const key = String(status).trim().toLowerCase()
  const hit = Object.prototype.hasOwnProperty.call(STATUS_TABLE, key) ? STATUS_TABLE[key] : null
  if (!hit) return null
  return { status: hit.status, attended: hit.attended, rank: UN1T_STATUS_RANK[hit.status] }
}

/**
 * Pure: shape one mapped un1t_bookings row (with its contact_id) into a
 * class_bookings upsert row. Returns null when the booking has no id, no
 * event id, no event with a start (nothing to put on a class), or a status
 * that is not projectable.
 *
 * @param {object} bookingRow  a mapBooking() row carrying contact_id
 * @param {{ locationId: string, event: { title?: string|null, starts_at?: string|null }|null, memberName?: string|null, nowIso: string, writtenBy?: 'sync'|'crm' }} ctx
 *   memberName undefined = the key is omitted, so an upsert keeps the stored
 *   name (guests included: every row of one upsert carries the same keys).
 *   writtenBy is 'sync' (this projection) or 'crm' (D's write-through);
 *   anything else throws TypeError.
 */
export function mapUn1tBookingToClassBooking(bookingRow, { locationId, event, memberName, nowIso, writtenBy = 'sync' } = {}) {
  if (!WRITERS.has(writtenBy)) {
    throw new TypeError(`mapUn1tBookingToClassBooking: writtenBy must be 'sync' or 'crm'`)
  }
  if (!bookingRow || !hasValue(bookingRow.un1t_id) || !hasValue(bookingRow.event_id)) return null
  if (!event || !event.starts_at || !locationId) return null
  const mapped = mapUn1tBookingStatus(bookingRow.status ?? null)
  if (!mapped) return null
  const contactId = bookingRow.contact_id ?? null
  const row = {
    location_id: locationId,
    glofox_booking_id: `${PREFIX}${bookingRow.un1t_id}`,
    glofox_event_id: `${PREFIX}${bookingRow.event_id}`,
    glofox_member_id: null,
    source_platform: SOURCE_PLATFORM,
    contact_id: contactId,
  }
  if (memberName !== undefined) {
    row.member_name = contactId == null && bookingRow.has_guest === true ? GUEST_NAME : memberName
  }
  Object.assign(row, {
    class_name: event.title ? String(event.title).slice(0, MAX_CLASS_NAME) : null,
    starts_at: event.starts_at,
    status: mapped.status,
    attended: mapped.attended,
    raw: {
      un1t: {
        status: bookingRow.status ?? null,
        source: bookingRow.source ?? null,
        credit_charged: bookingRow.credit_charged ?? null,
        has_guest: bookingRow.has_guest ?? null,
        updated_at: bookingRow.remote_updated_at ?? null,
        written_by: writtenBy,
      },
    },
    synced_at: nowIso,
  })
  return row
}

/** A status for the unknown-status warning: never empty, never long. */
function loggedStatus(status) {
  const s = status == null ? '' : String(status).trim()
  if (s === '') return '(empty)'
  return s.length > MAX_LOGGED_STATUS_LEN ? `${s.slice(0, MAX_LOGGED_STATUS_LEN)}…` : s
}

/**
 * IO: upsert the class_bookings rows for these bookings. Events come from
 * this run's mapped events first; ids still missing are read from un1t_events
 * at this location (if that read fails nothing is written: a later run
 * retries). Never throws.
 *
 * @returns {Promise<{ upserted: number, skipped_no_event: number, skipped_unknown_status: number, names?: 'unreadable' } | { error: { code: string|null, message: string } }>}
 */
export async function projectUn1tBookings(db, { locationId, bookings, events, nowIso }) {
  try {
    // Last row wins per id, so one upsert never touches a row twice.
    const latest = new Map()
    for (const b of Array.isArray(bookings) ? bookings : []) {
      if (b && hasValue(b.un1t_id)) latest.set(String(b.un1t_id), b)
    }
    if (latest.size === 0) return { upserted: 0, skipped_no_event: 0, skipped_unknown_status: 0 }

    // An unprojectable status is skipped before anything is read for it.
    const byId = new Map()
    let skippedUnknownStatus = 0
    const unknownStatuses = new Set()
    for (const [id, b] of latest) {
      if (mapUn1tBookingStatus(b.status ?? null)) {
        byId.set(id, b)
      } else {
        skippedUnknownStatus += 1
        if (unknownStatuses.size < MAX_LOGGED_STATUSES) unknownStatuses.add(loggedStatus(b.status))
      }
    }
    if (skippedUnknownStatus > 0) {
      logWarn('un1t-online-bookings', 'bookings with a status the projection does not know were not projected', {
        locationId, count: skippedUnknownStatus, statuses: [...unknownStatuses],
      })
    }

    const eventById = new Map()
    for (const e of Array.isArray(events) ? events : []) {
      if (e && hasValue(e.un1t_id)) eventById.set(String(e.un1t_id), e)
    }
    const missing = [...new Set(
      [...byId.values()].filter((b) => hasValue(b.event_id)).map((b) => String(b.event_id)),
    )].filter((id) => !eventById.has(id))
    for (const idChunk of chunks(missing, READ_CHUNK)) {
      const { data, error } = await db
        .from('un1t_events')
        .select('un1t_id, title, starts_at')
        .eq('location_id', locationId)
        .in('un1t_id', idChunk)
      if (error) return { error: safeError(error) }
      for (const e of data || []) eventById.set(String(e.un1t_id), e)
    }

    // Names: a failed read leaves member_name off every row (stored names kept).
    const contactIds = [...new Set([...byId.values()].map((b) => b.contact_id).filter(hasValue))]
    let nameById = new Map()
    let namesUnreadable = false
    for (const idChunk of chunks(contactIds, READ_CHUNK)) {
      const { data, error } = await db.from('contacts').select('id, name').in('id', idChunk)
      if (error) {
        namesUnreadable = true
        nameById = null
        logWarn('un1t-online-bookings', 'could not read contact names; projecting bookings without member_name', { locationId, err: safeError(error) })
        break
      }
      for (const c of data || []) nameById.set(c.id, c.name ?? null)
    }

    const rows = []
    let skippedNoEvent = 0
    for (const b of byId.values()) {
      const event = hasValue(b.event_id) ? eventById.get(String(b.event_id)) ?? null : null
      const memberName = namesUnreadable
        ? undefined
        : hasValue(b.contact_id) ? nameById.get(b.contact_id) ?? null : null
      const row = mapUn1tBookingToClassBooking(b, { locationId, event, memberName, nowIso })
      if (row) rows.push(row)
      else skippedNoEvent += 1
    }

    let upserted = 0
    for (const chunk of chunks(rows, CHUNK)) {
      const { error } = await db
        .from('class_bookings')
        .upsert(chunk, { onConflict: 'location_id,glofox_booking_id' })
      if (error) return { error: safeError(error) }
      upserted += chunk.length
    }
    const result = { upserted, skipped_no_event: skippedNoEvent, skipped_unknown_status: skippedUnknownStatus }
    if (namesUnreadable) result.names = 'unreadable'
    return result
  } catch (err) {
    return { error: safeError(err) }
  }
}
