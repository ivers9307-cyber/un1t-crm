// UN1TBOOK.3 — project a studio's un1t.online bookings into class_bookings,
// the per-class booking roster the studio scorecard (no-shows, attended,
// activation), the staff /live roster and the campaign outcomes report read.
// Glofox fills it for Stillorgan (upsertClassBookings); this fills it for a
// un1t.online studio from the un1t_bookings rows the sync just mapped, so no
// extra API call is made.
//
// Rules (all pinned by un1t-online-bookings.test.js):
//   - The Glofox shape every reader already understands. Attendance is the
//     `attended` boolean, never the status: booked / attended / no_show are
//     all BOOKED (attended true only for 'attended'), cancelled is CANCELLED,
//     any other value is its uppercase. The un1t status is kept in raw.un1t.
//   - glofox_booking_id = 'un1t:' + un1t_id, glofox_event_id = 'un1t:' +
//     event_id, glofox_member_id = null, source_platform = 'un1t_online'. The
//     mig 733 CHECK refuses a un1t: id without that platform, and the CRM's
//     reminder and crediting crons read only source_platform 'glofox', so a
//     projected row is never reminded or credited (Decision 1).
//   - raw holds only { un1t: { status, source, credit_charged } }, never the
//     booking's own raw (which carries guest details).
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
 * Pure: a un1t booking status in the Glofox shape.
 * @param {string|null} status
 * @returns {{ status: string|null, attended: boolean }}
 */
export function mapUn1tBookingStatus(status) {
  if (status == null) return { status: null, attended: false }
  const s = String(status).trim()
  if (s === '') return { status: null, attended: false }
  switch (s.toLowerCase()) {
    case 'booked':
      return { status: 'BOOKED', attended: false }
    case 'attended':
      return { status: 'BOOKED', attended: true }
    case 'no_show':
      return { status: 'BOOKED', attended: false }
    case 'cancelled':
      return { status: 'CANCELLED', attended: false }
    default:
      return { status: s.toUpperCase(), attended: false }
  }
}

/**
 * Pure: shape one mapped un1t_bookings row (with its contact_id) into a
 * class_bookings upsert row. Returns null when the booking has no id, no
 * event id, or no event with a start (nothing to put on a class).
 *
 * @param {object} bookingRow  a mapBooking() row carrying contact_id
 * @param {{ locationId: string, event: { title?: string|null, starts_at?: string|null }|null, memberName?: string|null, nowIso: string }} ctx
 *   memberName undefined = the key is omitted, so an upsert keeps the stored name.
 */
export function mapUn1tBookingToClassBooking(bookingRow, { locationId, event, memberName, nowIso } = {}) {
  if (!bookingRow || !hasValue(bookingRow.un1t_id) || !hasValue(bookingRow.event_id)) return null
  if (!event || !event.starts_at || !locationId) return null
  const { status, attended } = mapUn1tBookingStatus(bookingRow.status ?? null)
  const row = {
    location_id: locationId,
    glofox_booking_id: `${PREFIX}${bookingRow.un1t_id}`,
    glofox_event_id: `${PREFIX}${bookingRow.event_id}`,
    glofox_member_id: null,
    source_platform: SOURCE_PLATFORM,
    contact_id: bookingRow.contact_id ?? null,
  }
  if (memberName !== undefined) row.member_name = memberName
  Object.assign(row, {
    class_name: event.title ? String(event.title).slice(0, MAX_CLASS_NAME) : null,
    starts_at: event.starts_at,
    status,
    attended,
    raw: {
      un1t: {
        status: bookingRow.status ?? null,
        source: bookingRow.source ?? null,
        credit_charged: bookingRow.credit_charged ?? null,
      },
    },
    synced_at: nowIso,
  })
  return row
}

/**
 * IO: upsert the class_bookings rows for these bookings. Events come from
 * this run's mapped events first; ids still missing are read from un1t_events
 * at this location (if that read fails nothing is written: a later run
 * retries). Never throws.
 *
 * @returns {Promise<{ upserted: number, skipped_no_event: number, names?: 'unreadable' } | { error: { code: string|null, message: string } }>}
 */
export async function projectUn1tBookings(db, { locationId, bookings, events, nowIso }) {
  try {
    // Last row wins per id, so one upsert never touches a row twice.
    const byId = new Map()
    for (const b of Array.isArray(bookings) ? bookings : []) {
      if (b && hasValue(b.un1t_id)) byId.set(String(b.un1t_id), b)
    }
    if (byId.size === 0) return { upserted: 0, skipped_no_event: 0 }

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
    const result = { upserted, skipped_no_event: skippedNoEvent }
    if (namesUnreadable) result.names = 'unreadable'
    return result
  } catch (err) {
    return { error: safeError(err) }
  }
}
