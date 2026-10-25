// src/lib/timezone-change.js — TZ.3. What changing a location's timezone touches.
//
// D2 = A (Richard, 11 Oct 2026): an owner (or master) may change a location's
// zone AT ANY TIME, after a preflight that shows the counts below and typing
// the location name to confirm. Nothing here refuses; it only reports.
//
// What a change means (the rules in the plan's Live facts):
//   • Wall-clock rows keep their LOCAL meaning: a 09:00 class stays 09:00, now
//     09:00 in the new zone. Nothing is rewritten for that; the rows hold no zone.
//   • Stored instants (*_at) and calendar keys (snapshot days, rollup days) are
//     NOT rewritten. History stays as it was written.
//   • Pending sequence steps (sequence_enrollments.next_step_at) are re-clamped
//     to the send window by the next run-sequences pass. Not rewritten here.
//   • Unfinished WhatsApp broadcasts carry their OWN copy of the zone
//     (send_window_tz). Those still on the OLD zone follow the location
//     (followBroadcastZone); one an operator set to a different zone is left
//     alone and listed.
//
// The counts are what an owner should know about before confirming. "Future" is
// judged against today IN THE LOCATION'S CURRENT ZONE, never the UTC day. Every
// count is head:true and location-scoped (no 1k cap), except two that cannot be
// expressed as one PostgREST count:
//   • hyrox_blocks: a block ends at starts_on + 7*weeks, which PostgREST cannot
//     filter on, so the active blocks are paged with .range() and judged here.
//   • pending_enrolments: sequence_enrollments has no location_id. An embedded
//     filter under head:true silently counts 0 (CLAUDE.md), so the studio's
//     sequence ids are paged first and the enrolments counted per id chunk.
// A count that fails is null and listed in `unknown`. It is never shown as 0.
//
// Not counted: staff_unavailability (keyed by person, no location_id: one
// person's availability is not one studio's), time_off_requests and other
// date-only rows (a whole day means the same in any zone), and the per-location
// settings that hold hours (quiet hours, sequence send windows), which simply
// keep their local meaning.
import { addDaysISO, canonicalZone, todayStrIn, zoneOfLocation } from '@/lib/location-time'

export const PREFLIGHT_KEYS = Object.freeze([
  'bookings', 'shift_blocks', 'race_events', 'hyrox_blocks',
  'pending_enrolments', 'sonos_schedules', 'shelly_devices', 'drip_broadcasts',
])

const PAGE = 1000 // the PostgREST row cap
const ID_CHUNK = 200 // ids per .in(): well inside the URL length limit
// Broadcast statuses that still send (or will): a 'sent'/'cancelled' one is done.
const UNFINISHED_BROADCAST = ['draft', 'scheduled', 'sending']
const HEAD = { count: 'exact', head: true }

// Run one count. Any error, thrown or returned, is "unknown" (null), never 0.
async function safeCount(run) {
  try {
    const { count, error } = await run()
    if (error || typeof count !== 'number') return null
    return count
  } catch {
    return null
  }
}

// Page a location-scoped read to the end (ordered by id). Returns null on any error.
async function readAll(build) {
  const rows = []
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().order('id').range(from, from + PAGE - 1)
      if (error || !Array.isArray(data)) return null
      rows.push(...data)
      if (data.length < PAGE) return rows
    }
  } catch {
    return null
  }
}

async function countPendingEnrolments(db, locationId, nowIso) {
  const sequences = await readAll(() => db.from('email_sequences').select('id').eq('location_id', locationId))
  if (!sequences) return null
  const ids = sequences.map((s) => s.id)
  let total = 0
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const n = await safeCount(() => db.from('sequence_enrollments').select('id', HEAD)
      .in('sequence_id', chunk)
      .eq('status', 'active')
      .gt('next_step_at', nowIso))
    if (n === null) return null // a partial sum would read as a smaller real number
    total += n
  }
  return total
}

async function countLiveHyroxBlocks(db, locationId, today) {
  const blocks = await readAll(() => db.from('hyrox_blocks').select('id, starts_on, weeks')
    .eq('location_id', locationId)
    .eq('status', 'active'))
  if (!blocks) return null
  // The block's last day is starts_on + 7*weeks - 1; it is live if that is today or later.
  return blocks.filter((b) => {
    if (!b.starts_on || !Number.isFinite(Number(b.weeks))) return false
    return addDaysISO(b.starts_on, 7 * Number(b.weeks) - 1) >= today
  }).length
}

/**
 * Counts of what has future wall-clock meaning at a location, judged in its
 * CURRENT zone. Never throws; a failed count is null and named in `unknown`.
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ id: string, timezone?: string|null }} location the row in hand
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ zone: string, today: string, future: Record<string, number|null>,
 *   unknown: string[], hasFutureData: boolean|null }>}
 *   hasFutureData: true if any count is above 0; false only if every count answered 0; else null.
 */
export async function timezoneChangePreflight(db, location, { nowMs = Date.now() } = {}) {
  const locationId = location.id
  const zone = zoneOfLocation(location)
  const today = todayStrIn(zone, nowMs)
  const nowIso = new Date(nowMs).toISOString()

  const [bookings, shiftBlocks, raceEvents, hyrox, enrolments, sonos, shelly, drips] = await Promise.all([
    safeCount(() => db.from('bookings').select('id', HEAD)
      .eq('location_id', locationId).gte('booking_date', today).neq('status', 'cancelled')),
    safeCount(() => db.from('shift_blocks').select('id', HEAD)
      .eq('location_id', locationId).gte('block_date', today)),
    safeCount(() => db.from('race_events').select('id', HEAD)
      .eq('location_id', locationId).gte('race_date', today)),
    countLiveHyroxBlocks(db, locationId, today),
    countPendingEnrolments(db, locationId, nowIso),
    safeCount(() => db.from('sonos_schedules').select('id', HEAD)
      .eq('location_id', locationId).eq('enabled', true)),
    safeCount(() => db.from('shelly_devices').select('id', HEAD)
      .eq('location_id', locationId).eq('enabled', true).in('schedule_mode', ['fixed', 'class'])),
    safeCount(() => db.from('whatsapp_broadcasts').select('id', HEAD)
      .eq('location_id', locationId).eq('delivery_mode', 'drip').in('status', ['scheduled', 'sending'])),
  ])

  const future = {
    bookings, shift_blocks: shiftBlocks, race_events: raceEvents, hyrox_blocks: hyrox,
    pending_enrolments: enrolments, sonos_schedules: sonos, shelly_devices: shelly, drip_broadcasts: drips,
  }
  const unknown = PREFLIGHT_KEYS.filter((k) => future[k] === null)
  const anyAbove = PREFLIGHT_KEYS.some((k) => (future[k] ?? 0) > 0)
  const hasFutureData = anyAbove ? true : (unknown.length ? null : false)
  return { zone, today, future, unknown, hasFutureData }
}

/**
 * Move the location's unfinished broadcasts whose send_window_tz IS the old
 * zone (compared through canonicalZone) onto the new zone. One an operator set
 * to a different zone keeps it and is returned in `kept`. Never throws.
 * @returns {Promise<{ followed: number, kept: Array<{ id: string, name: string|null, send_window_tz: string|null }>, error: string|null }>}
 */
export async function followBroadcastZone(db, locationId, fromZone, toZone) {
  const from = canonicalZone(fromZone)
  let rows
  try {
    rows = []
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await db.from('whatsapp_broadcasts')
        .select('id, name, send_window_tz')
        .eq('location_id', locationId)
        .in('status', UNFINISHED_BROADCAST)
        .order('id')
        .range(start, start + PAGE - 1)
      if (error) return { followed: 0, kept: [], error: error.message || 'read failed' }
      rows.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  } catch (e) {
    return { followed: 0, kept: [], error: e?.message || 'read failed' }
  }

  const follow = []
  const kept = []
  for (const r of rows) {
    if (from && canonicalZone(r.send_window_tz) === from) follow.push(r.id)
    else kept.push({ id: r.id, name: r.name ?? null, send_window_tz: r.send_window_tz ?? null })
  }

  let followed = 0
  for (let i = 0; i < follow.length; i += ID_CHUNK) {
    const chunk = follow.slice(i, i + ID_CHUNK)
    try {
      const { error } = await db.from('whatsapp_broadcasts')
        .update({ send_window_tz: toZone })
        .eq('location_id', locationId)
        .in('id', chunk)
      if (error) return { followed, kept, error: error.message || 'write failed' }
    } catch (e) {
      return { followed, kept, error: e?.message || 'write failed' }
    }
    followed += chunk.length
  }
  return { followed, kept, error: null }
}
