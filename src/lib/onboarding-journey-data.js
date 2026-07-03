// PULSE-90.2 — server-side data access for the first-90-days journey.
//
// Compute-on-read: NO state table. This module fetches the raw rows
// (contacts.joined_at + attended class_bookings) and feeds them to the pure
// pace math in onboarding-journey.js — the /pulse lane, the contact-profile
// panel, /api/me/journey and the nudge cron all read through here, so the
// window/attendance semantics live in exactly one IO layer. DB-touching —
// kept out of onboarding-journey.js so that module stays pure + unit-tested.
//
// Window semantics (matches journeyStatus): a booking is "in window" when
// its Dublin calendar day sits between the member's join day (day 0) and
// day windowDays inclusive — dublinDaysBetween, NOT a UTC/ms comparison
// (a 23:30 UTC session during IST belongs to the next Dublin day).
//
// Error handling: the member/booking/config reads THROW on a DB error and
// the routes turn that into a standard 500. The lastTouch overlay is
// best-effort (fetchActions precedent in churn-radar-data.js) — a failed
// actions read must not blank the whole lane.

import {
  journeyStatus,
  resolveJourneyConfig,
  dublinDaysBetween,
} from '@/lib/onboarding-journey'
import { MEMBER_STATUSES } from '@/lib/churn-radar'
import { selectAll, selectAllByKeys } from '@/lib/select-all'

// The lane keeps members visible for a couple of weeks past their window
// end, so coaches see who just fell through (expired) and who just finished
// (completed) — and /api/me/journey keeps serving a completed journey long
// enough for the app's short celebration state. Past joined_at + windowDays
// + LANE_TAIL_DAYS a member is off every journey surface.
const LANE_TAIL_DAYS = 14

// Same "someone reached out" action set the churn radar uses (its
// CONTACTING_ACTIONS) — the touch route below writes 'contacted', and any
// radar outreach on a lane member counts as a touch too.
const CONTACTING_ACTIONS = ['contacted', 'task_assigned', 'winback_sent', 'outreach_sent']

// Touches older than this can't be "recent outreach" on a ≤ ~8-week
// journey; mirrors the churn radar's 90-day action window.
const TOUCH_WINDOW_DAYS = 90

const DAY_MS = 86_400_000

// Worst-first lane order: the coach-actionable states lead (at_risk, then
// behind), healthy in-window members follow, and the closed journeys
// (expired — window over, can't intervene; completed — nothing to do)
// trail the list.
const STATUS_RANK = { at_risk: 0, behind: 1, on_track: 2, expired: 3, completed: 4 }

/** Read the location row and resolve its journey config (defaults 42/9). */
async function fetchJourneyConfig(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, notification_config')
    .eq('id', locationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return resolveJourneyConfig(data)
}

/**
 * Keep only the attendance instants inside [day 0, day windowDays] of the
 * member's journey, by Dublin calendar day. Rows with a null/unparseable
 * starts_at are dropped.
 *
 * @param {string} joinedAt   contacts.joined_at
 * @param {Array<{starts_at: string|null}>} rows  attended class_bookings
 * @param {number} windowDays
 * @returns {string[]} in-window starts_at instants
 */
function inWindowAttendance(joinedAt, rows, windowDays) {
  const joinedMs = Date.parse(joinedAt ?? '')
  if (!Number.isFinite(joinedMs)) return []
  const out = []
  for (const r of rows) {
    const ms = Date.parse(r?.starts_at ?? '')
    if (!Number.isFinite(ms)) continue
    const day = dublinDaysBetween(joinedMs, ms)
    if (day >= 0 && day <= windowDays) out.push(r.starts_at)
  }
  return out
}

/**
 * Best-effort: latest contacting action per contact at the location
 * (churn_radar_actions — the journey touch route writes there too).
 * Returns Map<contactId, { action, at }>; empty on any DB error so the
 * lane still renders without the touch column.
 */
async function fetchLastTouch(db, locationId, nowMs) {
  const since = new Date(nowMs - TOUCH_WINDOW_DAYS * DAY_MS).toISOString()
  const byContact = new Map()
  try {
    const rows = await selectAll((from, to) => db
      .from('churn_radar_actions')
      .select('contact_id, action, created_at')
      .eq('location_id', locationId)
      .in('action', CONTACTING_ACTIONS)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('contact_id', { ascending: true })
      .range(from, to))
    // Newest-first — the first hit per contact is the latest touch.
    for (const a of rows) {
      if (!byContact.has(a.contact_id)) {
        byContact.set(a.contact_id, { action: a.action, at: a.created_at })
      }
    }
  } catch {
    // Best-effort — lane renders without touch info.
  }
  return byContact
}

/**
 * Attended, non-cancelled class_bookings for a set of contacts, chunked
 * (IN-list URL cap) + paginated (1k row cap). `.not('status','eq',…)` also
 * drops NULL-status rows (Postgres NULL semantics) — matching
 * lookupBookedMember in class-bookings.js.
 *
 * @returns {Map<string, Array<{contact_id, starts_at}>>}
 */
async function fetchAttendanceByContact(db, locationId, contactIds, sinceIso) {
  const byContact = new Map()
  if (contactIds.length === 0) return byContact
  const rows = await selectAllByKeys(contactIds, (keys, from, to) => db
    .from('class_bookings')
    .select('contact_id, starts_at')
    .eq('location_id', locationId)
    .eq('attended', true)
    .not('status', 'eq', 'CANCELLED')
    .gte('starts_at', sinceIso)
    .in('contact_id', keys)
    .order('id', { ascending: true })
    .range(from, to))
  for (const r of rows) {
    const list = byContact.get(r.contact_id)
    if (list) list.push(r)
    else byContact.set(r.contact_id, [r])
  }
  return byContact
}

function worstFirst(a, b) {
  const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
  if (rank !== 0) return rank
  // Within a status: biggest pace deficit first, then the older journey
  // (less time left to fix it), then a stable id tiebreak.
  const deficit = (b.expectedByNow - b.attended) - (a.expectedByNow - a.attended)
  if (deficit !== 0) return deficit
  if (a.dayIndex !== b.dayIndex) return b.dayIndex - a.dayIndex
  return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0
}

/**
 * The /pulse journey lane: every member (fetchMembers statuses — member /
 * credit_member) at the location whose joined_at falls in the last
 * windowDays + 14 days, each scored by journeyStatus and overlaid with
 * their latest coach touch, sorted worst-first.
 *
 * @param {object} db          service-role client
 * @param {string} locationId
 * @param {number} [nowMs]
 * @returns {Promise<{ config: {windowDays: number, targetClasses: number}, lane: Array<object> }>}
 *   lane rows: { contactId, name, joinedAt, ...journeyStatus fields,
 *   lastTouch: {action, at}|null }
 */
export async function loadJourneyLane(db, locationId, nowMs = Date.now()) {
  const config = await fetchJourneyConfig(db, locationId)
  const sinceIso = new Date(nowMs - (config.windowDays + LANE_TAIL_DAYS) * DAY_MS).toISOString()

  const members = await selectAll((from, to) => db
    .from('contacts')
    .select('id, name, joined_at, glofox_membership_status')
    .eq('location_id', locationId)
    .in('glofox_membership_status', MEMBER_STATUSES)
    .gte('joined_at', sinceIso)
    .order('id', { ascending: true })
    .range(from, to))

  const [attendance, lastTouch] = await Promise.all([
    // Bookings before the earliest possible join day can't be in any lane
    // member's window, so the same cutoff trims the booking scan.
    fetchAttendanceByContact(db, locationId, members.map((m) => m.id), sinceIso),
    fetchLastTouch(db, locationId, nowMs),
  ])

  const lane = []
  for (const m of members) {
    const attendedAt = inWindowAttendance(m.joined_at, attendance.get(m.id) || [], config.windowDays)
    const row = journeyStatus({ joinedAt: m.joined_at, attendedAt, now: nowMs, config })
    if (!row) continue // unparseable joined_at — nothing to pace
    lane.push({
      contactId: m.id,
      name: m.name || 'Member',
      joinedAt: m.joined_at,
      ...row,
      lastTouch: lastTouch.get(m.id) || null,
    })
  }
  lane.sort(worstFirst)
  return { config, lane }
}

/**
 * Single-contact journey for the profile panel and /api/me/journey.
 *
 * Returns null when there is nothing to show ANY surface: contact missing,
 * no/unparseable joined_at, past the windowDays + 14 tail, or the window
 * expired without completion. A completed journey keeps returning through
 * the tail (inWindow false, status 'completed') so the member app can show
 * its short celebration state — the app's own display shaping hides it
 * after a few days, and the profile panel renders in-window rows only.
 *
 * @param {object} db         service-role client
 * @param {string} contactId
 * @param {number} [nowMs]
 * @returns {Promise<object|null>}  { contactId, name, joinedAt,
 *   ...journeyStatus fields } | null
 */
export async function loadContactJourney(db, contactId, nowMs = Date.now()) {
  if (!contactId) return null

  const { data: contact, error } = await db
    .from('contacts')
    .select('id, name, location_id, joined_at')
    .eq('id', contactId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!contact?.joined_at) return null
  const joinedMs = Date.parse(contact.joined_at)
  if (!Number.isFinite(joinedMs)) return null

  const config = contact.location_id
    ? await fetchJourneyConfig(db, contact.location_id)
    : resolveJourneyConfig(null)

  // Hard stop past the tail — skip the booking scan entirely.
  if (dublinDaysBetween(joinedMs, nowMs) > config.windowDays + LANE_TAIL_DAYS) return null

  const bookings = await selectAll((from, to) => db
    .from('class_bookings')
    .select('contact_id, starts_at')
    .eq('contact_id', contactId)
    .eq('attended', true)
    .not('status', 'eq', 'CANCELLED')
    .order('id', { ascending: true })
    .range(from, to))

  const attendedAt = inWindowAttendance(contact.joined_at, bookings, config.windowDays)
  const row = journeyStatus({ joinedAt: contact.joined_at, attendedAt, now: nowMs, config })
  if (!row) return null
  // Window over without hitting the target → no surface shows it (the
  // member card hides, the profile panel is in-window only).
  if (!row.inWindow && row.status !== 'completed') return null

  return { contactId: contact.id, name: contact.name || 'Member', joinedAt: contact.joined_at, ...row }
}
