// HOLDPLACES.1 — places a class has already promised that its booked count
// does not show yet.
//
// A website booking waits in class_booking_requests ('queued', then
// 'processing') for a minute or two before it is sent to the booking
// platform. The public class list judged "full" on the platform's booked
// count alone, so the last place in a class stayed on offer while someone
// was already queued for it: on 23 Nov 2026 three people took a class with
// two places left inside 90 seconds, and the third was refused.
//
// Two kinds of place are counted on top of the platform's number:
//   waiting — requests still queued or processing for a class not yet run.
//   recent  — requests this CRM booked in the last RECENT_MS. Only a mirror
//     needs them (un1t_events is synced every 15 minutes, so a booking made
//     since a row's synced_at is not in its bookings_count). Glofox is read
//     live and ignores them.
//
// Never sent to a client (PUBCAP.1): callers use it only to leave a class
// out. A failed read counts nothing held: listing a class that turns out
// full costs one review card, hiding the whole timetable costs the customer.
import { logWarn } from '@/lib/log'

const WAITING = ['queued', 'processing']
// The un1t.online sync runs every 15 minutes; twice that covers a late run.
const RECENT_MS = 30 * 60_000
const READ_LIMIT = 1000

const EMPTY = Object.freeze({ waiting: new Map(), recent: [] })

/**
 * @returns {Promise<{ waiting: Map<string, number>, recent: { eventId: string, atMs: number }[] }>}
 */
export async function readHeldPlaces(db, locationId, { nowMs = Date.now(), withRecent = false } = {}) {
  const nowIso = new Date(nowMs).toISOString()
  try {
    const waitingRead = db.from('class_booking_requests')
      .select('glofox_event_id')
      .eq('location_id', locationId)
      .in('status', WAITING)
      .gt('starts_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(READ_LIMIT)
    const recentRead = withRecent
      ? db.from('class_booking_requests')
        .select('glofox_event_id, updated_at')
        .eq('location_id', locationId)
        .eq('status', 'booked')
        .gt('updated_at', new Date(nowMs - RECENT_MS).toISOString())
        .gt('starts_at', nowIso)
        .order('updated_at', { ascending: true })
        .limit(READ_LIMIT)
      : Promise.resolve({ data: [], error: null })
    const [w, r] = await Promise.all([waitingRead, recentRead])
    if (w?.error || r?.error) {
      logWarn('class-places-held', 'queued bookings unreadable; no places held', { locationId, err: w?.error || r?.error })
      return EMPTY
    }
    const waiting = new Map()
    for (const row of w?.data || []) {
      const id = row?.glofox_event_id
      if (typeof id === 'string' && id) waiting.set(id, (waiting.get(id) || 0) + 1)
    }
    const recent = []
    for (const row of r?.data || []) {
      const atMs = Date.parse(row?.updated_at)
      if (typeof row?.glofox_event_id === 'string' && row.glofox_event_id && Number.isFinite(atMs)) recent.push({ eventId: row.glofox_event_id, atMs })
    }
    return { waiting, recent }
  } catch (err) {
    logWarn('class-places-held', 'queued bookings read threw; no places held', { locationId, err })
    return EMPTY
  }
}

/**
 * How many places `eventId` holds beyond its platform count. `syncedAt` is
 * when a mirrored row was last synced: a recent booking made before it is
 * already in the row's count. Omit it for a live read (Glofox).
 */
export function heldPlacesFor(held, eventId, syncedAt = undefined) {
  if (!held || !eventId) return 0
  let n = held.waiting?.get(eventId) || 0
  if (syncedAt === undefined) return n
  const syncedMs = Date.parse(syncedAt)
  for (const b of held.recent || []) {
    if (b.eventId === eventId && (!Number.isFinite(syncedMs) || b.atMs > syncedMs)) n += 1
  }
  return n
}
