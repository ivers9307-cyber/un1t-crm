// UN1TCLASS.2 — project a studio's un1t.online events into class_occurrences,
// the table the TVs, dashboards and class-aware automations read for "what
// class runs when, where". Glofox fills it for Stillorgan
// (syncOccurrencesForLocation); this fills it for a un1t.online studio from
// the un1t_events rows the sync just mapped, so no extra API call is made.
//
// Rules (all pinned by un1t-online-occurrences.test.js):
//   - glofox_event_id = 'un1t:' + un1t_id. The prefix keeps the key disjoint
//     from a bare 24-hex Glofox id, because readers (credit-attendance,
//     auto-end-stale-hr-sessions, the climate automation log) look the column
//     up with no location filter.
//   - source_platform = 'un1t_online' (Glofox rows take the column default).
//   - NEVER deletes. An explicit status = 'cancelled' stamps cancelled_at (an
//     earlier stamp is kept, a reinstated class clears it).
//   - UN1TBOOK.20: a FUTURE un1t occurrence whose event this run's pull did
//     not return was deleted in un1t.online, and is stamped cancelled_at too,
//     so the TVs and dashboards (which read cancelled_at IS NULL) drop it. The
//     pull is complete (the sync refuses a truncated list) and /events only
//     rolls off the PAST, so absence proves nothing for a class that has
//     started: past rows are never touched. Same rule as the public class
//     list's freshness (un1t-online-freshness.js), taken from the run's own
//     pulled ids. A pull with no events cancels nothing (an upstream fault,
//     not every class deleted), and a sync that stops never gets here, so a
//     stalled sync changes nothing. If the event reappears, the upsert clears
//     the stamp (its status is not 'cancelled'). Glofox rows (and every other
//     studio's) are outside the read and the write.
//   - NEVER throws and never touches class_bookings. The sync treats the
//     result as informational: a projection failure must not fail the run,
//     whose membership and contact data are the primary payload.

import { UN1T_EVENT_PREFIX } from './manual-timetable'

const CHUNK = 200
// The existing-cancelled read puts every id in the URL's IN-list, so it takes
// smaller chunks than the upsert (whose ids travel in the body).
const READ_CHUNK = 100
// The reconcile read pages through the studio's future un1t occurrences.
const PAGE = 1000
// The same prefix the public class list mints for these classes (HATCHSTART.1).
const PREFIX = UN1T_EVENT_PREFIX
const SOURCE_PLATFORM = 'un1t_online'
const MAX_ERROR_LEN = 500

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

/**
 * Pure: shape one mapped un1t_events row into a class_occurrences upsert row.
 * Returns null when the event has no id or no start (nothing to timetable).
 *
 * @param {object} eventRow  a mapEvent() row
 * @param {{ locationId: string, nowIso: string, existingCancelledAt?: string|null }} ctx
 */
export function mapUn1tEventToOccurrence(eventRow, { locationId, nowIso, existingCancelledAt = null } = {}) {
  if (!eventRow || eventRow.un1t_id == null || eventRow.un1t_id === '' || !eventRow.starts_at || !locationId) return null
  const cancelled = eventRow.status === 'cancelled'
  return {
    location_id: locationId,
    glofox_event_id: `${PREFIX}${eventRow.un1t_id}`,
    source_platform: SOURCE_PLATFORM,
    name: eventRow.title ? String(eventRow.title).slice(0, 200) : null,
    program: null,
    starts_at: eventRow.starts_at,
    ends_at: eventRow.ends_at ?? null,
    capacity: eventRow.capacity ?? null,
    instructor: null,
    raw: {
      booked: eventRow.bookings_count ?? null,
      un1t: {
        status: eventRow.status ?? null,
        access_mode: eventRow.access_mode ?? null,
        is_free: eventRow.is_free ?? null,
        series_id: eventRow.series_id ?? null,
      },
    },
    synced_at: nowIso,
    cancelled_at: cancelled ? existingCancelledAt || nowIso : null,
  }
}

/**
 * IO: upsert the occurrences for these events (EVERY event this run pulled,
 * since the list doubles as the seen set). Reads the existing cancelled_at
 * first (so a re-cancel keeps its first stamp); if that read fails nothing is
 * written, because writing without it could move an earlier stamp. Then
 * stamps the future un1t occurrences the pull did not return (UN1TBOOK.20).
 * Never throws.
 *
 * @returns {Promise<{ upserted: number, cancelled?: number, error?: { code: string|null, message: string } }>}
 */
export async function projectUn1tOccurrences(db, { locationId, events, nowIso }) {
  try {
    const candidates = (Array.isArray(events) ? events : []).filter((e) => e && e.un1t_id != null && e.un1t_id !== '' && e.starts_at)
    if (candidates.length === 0) return { upserted: 0 }

    // Last row wins per id, so one upsert never touches a row twice.
    const byId = new Map()
    for (const e of candidates) byId.set(`${PREFIX}${e.un1t_id}`, e)
    const ids = [...byId.keys()]

    const cancelledAt = new Map()
    for (const idChunk of chunks(ids, READ_CHUNK)) {
      const { data, error } = await db
        .from('class_occurrences')
        .select('glofox_event_id, cancelled_at')
        .eq('location_id', locationId)
        .in('glofox_event_id', idChunk)
      if (error) return { error: safeError(error) }
      for (const r of data || []) if (r.cancelled_at) cancelledAt.set(r.glofox_event_id, r.cancelled_at)
    }

    const rows = []
    for (const [id, e] of byId) {
      const row = mapUn1tEventToOccurrence(e, { locationId, nowIso, existingCancelledAt: cancelledAt.get(id) ?? null })
      if (row) rows.push(row)
    }

    let upserted = 0
    for (const chunk of chunks(rows, CHUNK)) {
      const { error } = await db.from('class_occurrences').upsert(chunk, { onConflict: 'location_id,glofox_event_id' })
      if (error) return { error: safeError(error) }
      upserted += chunk.length
    }

    // UN1TBOOK.20 — every event this pull returned is seen, mappable or not.
    const seen = new Set((Array.isArray(events) ? events : [])
      .filter((e) => e && e.un1t_id != null && e.un1t_id !== '')
      .map((e) => `${PREFIX}${e.un1t_id}`))
    const gone = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('class_occurrences')
        .select('glofox_event_id')
        .eq('location_id', locationId)
        .eq('source_platform', SOURCE_PLATFORM)
        .gt('starts_at', nowIso)
        .is('cancelled_at', null)
        .order('glofox_event_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) return { upserted, cancelled: 0, error: safeError(error) }
      for (const r of data || []) if (r.glofox_event_id && !seen.has(r.glofox_event_id)) gone.push(r.glofox_event_id)
      if (!Array.isArray(data) || data.length < PAGE) break
    }
    let cancelled = 0
    for (const idChunk of chunks(gone, READ_CHUNK)) {
      const { data, error } = await db
        .from('class_occurrences')
        .update({ cancelled_at: nowIso })
        .eq('location_id', locationId)
        .eq('source_platform', SOURCE_PLATFORM)
        .in('glofox_event_id', idChunk)
        .gt('starts_at', nowIso)
        .is('cancelled_at', null)
        .select('glofox_event_id')
      if (error) return { upserted, cancelled, error: safeError(error) }
      cancelled += Array.isArray(data) ? data.length : 0
    }
    return { upserted, cancelled }
  } catch (err) {
    return { error: safeError(err) }
  }
}
