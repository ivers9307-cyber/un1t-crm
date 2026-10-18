// Public class listing for the /start wizard. Reuses the Glofox event fetch
// the agent uses, but shapes each class with a structured day (YYYY-MM-DD,
// in the studio's own zone, TZ.7) + HH:MM time so the UI can group by day.
// Glofox's `time_start` is an instant (unix seconds) and is never re-zoned:
// only its day/time/label are rendered on the studio's clock. No auth — display-
// safe class data only: name and time. PUBCAP.1: NEVER a capacity figure
// (Richard's rule: class/event capacity is never surfaced to customers — no
// spots left, no size, no booked count, not even a "full" flag). Fullness is
// judged on the RAW Glofox event before shaping, and a full class is simply
// left out of the list.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { parseManualTimetable, manualClassOccurrences, manualTimetableConfigFromBlocks, classFunnelMinNoticeHours, UN1T_EVENT_PREFIX } from '@/lib/manual-timetable'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { formatInZone, getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { parseHiddenKeywords } from '@/lib/class-keywords'

// The exact Intl options the Dublin formatters used, so a Dublin studio's
// day/time/label text is byte-identical (TZ.7).
const DAY_OPTS = Object.freeze({ year: 'numeric', month: '2-digit', day: '2-digit' })
const TIME_OPTS = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false })
const LABEL_OPTS = Object.freeze({ weekday: 'short', day: 'numeric', month: 'short' })

// The ONLY keys a public class carries. tests/public-classes pin this list so
// a new field has to be added here on purpose, never leak in via a spread.
export const PUBLIC_CLASS_KEYS = Object.freeze(['event_id', 'name', 'starts_at', 'day', 'day_label', 'time'])

// Server-side only: is this raw Glofox event full? Never sent to a client.
export function isEventFull(e) {
  const size = Number(e?.size) || 0
  const booked = Number(e?.booked) || 0
  return size > 0 && booked >= size
}

function shapeAt(eventId, name, ms, zone) {
  const d = new Date(ms)
  return {
    event_id: eventId,
    name: name || 'Class',
    starts_at: d.toISOString(),
    day: formatInZone(d, zone, DAY_OPTS, 'en-CA'),
    day_label: formatInZone(d, zone, LABEL_OPTS, 'en-IE'),
    time: formatInZone(d, zone, TIME_OPTS, 'en-GB'),
  }
}

/** A raw Glofox event → the public class shape, rendered in `zone` (the studio's). */
export function shapePublicClass(e, zone = DEFAULT_TZ) {
  const startSec = Number(e.time_start) || 0
  return shapeAt(e._id || e.id, e.name, startSec * 1000, zone)
}

// Server-side only: is this un1t_events row full? Never sent to a client.
export function isUn1tEventFull(e) {
  const capacity = Number(e?.capacity) || 0
  const booked = Number(e?.bookings_count) || 0
  return capacity > 0 && booked >= capacity
}

/**
 * HATCHSTART.1 — a synced un1t_events row → the public class shape. The id is
 * 'un1t:' + its un1t.online id (what class_occurrences keys it by), which is
 * what sends a booking request for it to staff. un1t.online titles carry
 * stray trailing spaces ('RALLY '), so the name is trimmed.
 */
export function shapeUn1tPublicClass(e, zone = DEFAULT_TZ) {
  const name = typeof e.title === 'string' ? e.title.trim() : ''
  return shapeAt(`${UN1T_EVENT_PREFIX}${e.un1t_id}`, name, Date.parse(e.starts_at), zone)
}

// Operator deny-list. Hide classes whose name contains any configured keyword
// (case-insensitive), stored at locations.settings.glofox.hidden_class_keywords
// — keeps free-trial leads out of e.g. ELITES / members-only sessions. Applied
// inside readPublicClasses so it governs BOTH the public picker AND the booking
// enqueue (both go through here): a hidden class can be neither seen nor booked.
// parseHiddenKeywords lives in ./class-keywords (a light module, so the
// un1t.online settings reader does not import Glofox); re-exported here so
// every existing import keeps working.
export { parseHiddenKeywords }
export function isClassHidden(name, keywords) {
  if (!keywords || !keywords.length) return false
  const n = String(name || '').toLowerCase()
  return keywords.some((k) => n.includes(k))
}

/**
 * Resolve a location's live, bookable classes for the next `days` days.
 * Never throws.
 * @returns {Promise<{ classes: object[], error: (string|null) }>}
 *   error 'glofox_settings_unreadable' — the studio's Glofox settings could
 *     not be READ (a DB blip): not "no classes", not "not configured".
 *   error 'glofox_unreachable' — Glofox did not answer.
 *   error 'manual_timetable_unreadable' — a studio with no Glofox whose
 *     landing row (where its hand-written timetable lives) could not be read.
 *   error 'location_zone_unreadable' — a studio with no Glofox whose
 *     timezone could not be read (TZ.7): its timetable is wall clock in that
 *     zone, so it cannot be turned into class times on a guessed clock. A
 *     Glofox studio's classes are instants, so there the zone only labels
 *     them and an unreadable one falls back to DEFAULT_TZ.
 *   error 'un1t_settings_unreadable' / 'un1t_events_unreadable' — a studio
 *     with no Glofox whose location row, or (at a un1t.online studio) whose
 *     synced timetable, could not be read (HATCHSTART.1).
 *   A un1t.online studio lists its synced un1t_events (HATCHSTART.1). Any
 *   other studio with no Glofox lists the timetable written on its
 *   class_funnel block (MANUALFUNNEL.1), or { classes: [], error: null } when
 *   it has none.
 */
export async function readPublicClasses(db, locationId, days = 7) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (creds.readError) return { classes: [], error: creds.readError }
  if (missingGlofoxCredentialsForLocation(creds).length) return readNoGlofoxClasses(db, locationId, days)
  // REGISTRYREAD.1a: the deny-list rides on the SAME read as the credentials.
  // A second read used to fail OPEN — a blip answered {} and listed (and let
  // the funnel book) every hidden class.
  const hidden = parseHiddenKeywords(creds.hiddenClassKeywords)
  const start = Math.floor(Date.now() / 1000)
  const end = start + Math.min(14, Math.max(1, days)) * 86400
  const { ok, events } = await fetchUpcomingEvents(creds, { start, end, limit: 100 })
  if (!ok || !Array.isArray(events)) return { classes: [], error: 'glofox_unreachable' }
  const now = Date.now()
  const zone = await getLocationZone(db, locationId).catch((err) => {
    logWarn('public-classes', 'location zone unreadable; labelling in the default zone', { locationId, err })
    return DEFAULT_TZ
  })
  const classes = events
    .filter((e) => e && e.active !== false && e.private !== true && (Number(e.time_start) || 0) * 1000 > now)
    .filter((e) => !isEventFull(e))
    .map((e) => shapePublicClass(e, zone))
    .filter((c) => !isClassHidden(c.name, hidden))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return { classes, error: null }
}

// MANUALFUNNEL.1 — a studio with no Glofox lists the weekly timetable its
// operator wrote on the class_funnel block. Same shape as a Glofox class, and
// the booking route validates against this same read, so a time the operator
// removed can be neither seen nor requested. A landing row that could not be
// READ is an error, never "no classes": the booking route then answers
// timetable_unavailable and keeps what the customer typed.
//
// HATCHSTART.1 — a studio whose membership source is un1t.online (Hatch
// Street) lists its REAL timetable instead: the classes the un1t.online sync
// mirrored into un1t_events. The hand-written text is not read for it at all,
// because it drifts from what the studio actually runs.
async function readNoGlofoxClasses(db, locationId, days) {
  const { data, error } = await db.from('landing_page_settings')
    .select('blocks').eq('location_id', locationId).maybeSingle()
  if (error) return { classes: [], error: 'manual_timetable_unreadable' }
  const source = await readUn1tListingSource(db, locationId)
  if (source.error) return { classes: [], error: source.error }
  if (source.un1t) return readUn1tClasses(db, locationId, days, { blocks: data?.blocks, hidden: source.hidden })
  const cfg = manualTimetableConfigFromBlocks(data?.blocks)
  if (!cfg) return { classes: [], error: null }
  const zone = await readListingZone(db, locationId)
  if (!zone) return { classes: [], error: 'location_zone_unreadable' }
  const { slots } = parseManualTimetable(cfg.text)
  const classes = manualClassOccurrences({ slots, startDate: cfg.startDate, minNoticeHours: cfg.minNoticeHours, days, zone })
  return { classes, error: null }
}

// The timetable is wall clock in the studio's zone (or, for un1t.online,
// labelled in it), so an unreadable zone lists nothing rather than guess.
async function readListingZone(db, locationId) {
  try {
    return await getLocationZone(db, locationId)
  } catch (err) {
    logWarn('public-classes', 'location zone unreadable; timetable not listed', { locationId, err })
    return null
  }
}

// Is this a un1t.online studio, and which class names does it hide? Read off
// the location row: an unreadable row is an error, never "not un1t.online"
// (that would list the stale hand-written timetable as if it were real).
async function readUn1tListingSource(db, locationId) {
  let res
  try {
    res = await db.from('locations').select('membership_source, settings').eq('id', locationId).maybeSingle()
  } catch (err) {
    logWarn('public-classes', 'location row read threw; timetable not listed', { locationId, err })
    return { error: 'un1t_settings_unreadable' }
  }
  if (res?.error) {
    logWarn('public-classes', 'location row unreadable; timetable not listed', { locationId, err: res.error })
    return { error: 'un1t_settings_unreadable' }
  }
  if (res?.data?.membership_source !== 'un1t_online') return { un1t: false, error: null }
  return { un1t: true, hidden: un1tWriteSettingsFrom(res.data.settings).hiddenClassKeywords, error: null }
}

// Same filters a customer-facing list needs anywhere: scheduled, open to the
// public ('community' classes are members-only), starting after the block's
// minimum notice (staff book it by hand), not full (PUBCAP.1: judged here,
// never sent), and not hidden by settings.un1t_online.hidden_class_keywords.
// The window matches the Glofox read (at most 14 days); un1t.online runs ~60
// classes a fortnight, so 200 rows is never the binding limit.
const UN1T_LISTING_LIMIT = 200
async function readUn1tClasses(db, locationId, days, { blocks, hidden }) {
  const nowMs = Date.now()
  const fromMs = nowMs + classFunnelMinNoticeHours(blocks) * 3_600_000
  const toMs = nowMs + Math.min(14, Math.max(1, days)) * 86_400_000
  let res
  try {
    res = await db.from('un1t_events')
      .select('un1t_id, title, starts_at, capacity, bookings_count')
      .eq('location_id', locationId)
      .eq('status', 'scheduled')
      .eq('access_mode', 'open')
      .gt('starts_at', new Date(fromMs).toISOString())
      .lt('starts_at', new Date(toMs).toISOString())
      .order('starts_at', { ascending: true })
      .limit(UN1T_LISTING_LIMIT)
  } catch (err) {
    logWarn('public-classes', 'un1t_events read threw; timetable not listed', { locationId, err })
    return { classes: [], error: 'un1t_events_unreadable' }
  }
  if (res?.error) {
    logWarn('public-classes', 'un1t_events unreadable; timetable not listed', { locationId, err: res.error })
    return { classes: [], error: 'un1t_events_unreadable' }
  }
  const zone = await readListingZone(db, locationId)
  if (!zone) return { classes: [], error: 'location_zone_unreadable' }
  const classes = (res?.data || [])
    .filter((e) => e && e.un1t_id != null && e.un1t_id !== '' && Number.isFinite(Date.parse(e.starts_at)))
    .filter((e) => !isUn1tEventFull(e))
    .map((e) => shapeUn1tPublicClass(e, zone))
    .filter((c) => !isClassHidden(c.name, hidden))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return { classes, error: null }
}

// Old contract ([] on any failure) for the public list route and the
// WhatsApp Flow, where an empty screen is the honest fallback.
export async function listPublicClasses(db, locationId, days = 7) {
  return (await readPublicClasses(db, locationId, days)).classes
}
