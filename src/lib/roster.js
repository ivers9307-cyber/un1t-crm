// Roster v2 helpers — block generation, date math, capacity checks.
//
// Used by:
//   - /api/schedule/templates POST/PUT (to materialise blocks when
//     a template's days_of_week changes)
//   - /api/cron/extend-roster-horizon (the nightly sweep — why it
//     replaced the old lazy extend is in src/lib/roster-horizon.js)
//   - block-related lib tests
//
// We deliberately keep this module pure on its inputs (the supabase
// client is passed in) so it can be unit-tested with the same mock
// pattern used elsewhere in src/lib/.

import { logWarn } from '@/lib/log'

// Canonical weekday codes — match the CHECK on
// shift_templates.days_of_week (mig 067). Indexed Monday-first
// because that's how the rest of the schedule UI presents weeks.
export const WEEKDAY_CODES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * Convert a JS Date (or ISO date string) to its canonical weekday
 * code ('mon'..'sun'). UTC-day-of-week is what we want — the date
 * stored in shift_blocks.block_date is a calendar date with no TZ.
 */
export function dayCodeForDate(input) {
  const d = input instanceof Date ? input : new Date(input)
  // JS getDay(): Sun=0, Mon=1, ..., Sat=6. Roll into Mon-first.
  const jsDay = d.getDay()
  const monFirst = jsDay === 0 ? 6 : jsDay - 1
  return WEEKDAY_CODES[monFirst]
}

/**
 * Returns the Monday of the week containing `date`, normalised to
 * midnight. Mirrors getMonday() in ScheduleCalendar but exposed as
 * a lib helper so server code can use it too.
 */
export function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Add N days to a Date and return a new Date.
 */
export function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/**
 * Format a Date as YYYY-MM-DD using LOCAL calendar components.
 *
 * Why not toISOString().split('T')[0]? That shifts to UTC. In any
 * timezone east of UTC (e.g. Ireland BST = +1), local midnight
 * Monday is UTC 23:00 Sunday — toISOString() then returns the
 * previous day's date string. The result: Monday slots in the
 * weekly calendar key off Sunday's date, no blocks match, the
 * Monday column renders empty.
 *
 * shift_blocks.block_date is a calendar date (no TZ) representing
 * the day the operator MEANT, so we want the local-day intent
 * preserved. getFullYear/getMonth/getDate use local components.
 */
export function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * First day of a Date's calendar month, at local midnight.
 */
export function getMonthStart(date) {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

// ROSTER-FIX.6a — one rule for the calendar's Month/Week toggle: a week
// belongs to the month its MIDWEEK day (Thursday) falls in. Both directions
// have to agree on it or the toggle loses a month.
//
// Before: Month took getMonthStart(weekStart), so the week 27 Jul - 2 Aug
// jumped to July while the operator was looking at August; Week took
// getMonday(monthStart), so August 2026 (a Saturday start) landed on 27 July
// and the next Month click read July. Any month starting Fri/Sat/Sun did it.

/**
 * The month the visible week belongs to. Midweek decides, so a week that
 * straddles a month boundary goes to whichever month holds most of it.
 */
export function monthStartForWeek(weekStart) {
  return getMonthStart(addDays(weekStart, 3))
}

/**
 * The week to show when leaving month view. Keeps the week already on screen
 * when it belongs to this month (so Month then Week is a no-op), otherwise
 * the month's first week - defined by the same midweek rule, which is what
 * makes the reverse trip land back on the month we came from.
 */
export function weekStartForMonth(monthStart, currentWeekStart) {
  const ms = getMonthStart(monthStart)
  if (currentWeekStart && monthStartForWeek(currentWeekStart).getTime() === ms.getTime()) {
    return getMonday(currentWeekStart)
  }
  return getMonday(addDays(ms, 3))
}

/**
 * Generate the list of dates within [fromDate, toDate] (inclusive)
 * whose weekday code is in `dayCodes`. Used both by the block
 * generator and by tests asserting which weekdays a template hits.
 */
export function expandDaysToDates(dayCodes, fromDate, toDate) {
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate)
  const to = toDate instanceof Date ? toDate : new Date(toDate)
  const set = new Set(dayCodes)
  const out = []
  let cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  while (cursor <= to) {
    if (set.has(dayCodeForDate(cursor))) {
      out.push(formatDate(cursor))
    }
    cursor = addDays(cursor, 1)
  }
  return out
}

/**
 * Materialise shift_blocks for a template across a date window.
 *
 * Idempotent — relies on the (location_id, template_id, block_date)
 * unique key on shift_blocks. Calling it twice with the same
 * arguments is a no-op for already-existing blocks.
 *
 * @param {SupabaseClient} db    server-role client
 * @param {object} template      shift_templates row (must include id,
 *                               location_id, start_time, end_time,
 *                               days_of_week, max_coaches)
 * @param {Date|string} fromDate  inclusive lower bound (defaults to
 *                               start of current week)
 * @param {number} weeks         how many weeks to project forward
 *                               from fromDate (default 8)
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function generateBlocksForTemplate(db, template, fromDate = null, weeks = 8) {
  const days = template.days_of_week || []
  if (days.length === 0) return { inserted: 0, skipped: 0 }

  const start = fromDate ? new Date(fromDate) : getMonday(new Date())
  start.setHours(0, 0, 0, 0)
  const end = addDays(start, weeks * 7 - 1)

  const dates = expandDaysToDates(days, start, end)
  if (dates.length === 0) return { inserted: 0, skipped: 0 }

  // ROSTER-FIX.5 — a block created after its week was published belongs to
  // that roster. Untagged blocks were invisible to every roster-scoped
  // reader (change log, "which roster is this shift on?"), which is how a
  // late template edit could add a shift nobody could trace. ONE query for
  // the whole window, matched in JS — an N-date generator must not fire N
  // lookups.
  const rosterByDate = await findPublishedRosterIdsByDate(db, template.location_id, dates)

  const records = dates.map(date => ({
    location_id: template.location_id,
    template_id: template.id,
    block_date: date,
    start_time: template.start_time,
    end_time: template.end_time,
    max_coaches: template.max_coaches || 15,
    roster_id: rosterByDate.get(date) || null,
  }))

  // Use upsert with ignoreDuplicates so we don't fail when a block
  // already exists for that (location, template, date). Postgres
  // returns the affected rows; we count what came back to report
  // "inserted" vs "skipped".
  const { data, error } = await db
    .from('shift_blocks')
    .upsert(records, {
      onConflict: 'location_id,template_id,block_date',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) throw new Error(`Failed to generate blocks: ${error.message}`)

  const inserted = (data || []).length
  return { inserted, skipped: dates.length - inserted }
}

/**
 * Compute "is block unstaffed AND in the future" — the condition
 * the calendar uses to flag a block red. Pure function so the
 * Today-tab badge counter can reuse it.
 *
 * @param {object} block         shift_blocks row with block_date
 * @param {number} assignmentCount  current number of assignments on the block
 * @param {Date|string} now      current date (for testability)
 */
export function isBlockUnstaffedFuture(block, assignmentCount, now = new Date()) {
  if (assignmentCount > 0) return false
  const today = formatDate(now instanceof Date ? now : new Date(now))
  return block.block_date >= today
}

/**
 * ROSTER-FIX.1 — the one definition of "this assignment still puts a coach
 * on the block". Every reader (capacity, budget, notify, reports, copy)
 * goes through this so a dropped shift can't be counted somewhere by
 * accident. Only `cancelled` is dead; `swapped` is a real shift owned by
 * the taker; a missing status is a legacy row and counts as live.
 */
export function isLiveAssignment(a) {
  return a?.status !== 'cancelled'
}

/** Filter helper — tolerates null/undefined. */
export function liveAssignments(list) {
  return (list || []).filter(isLiveAssignment)
}

/**
 * ROSTER-FIX.5 — which published roster covers `dateIso` at this location?
 *
 * Kept alongside the batched form below because PR 4 calls it for a single
 * date; the batch is for the N-date generator.
 *
 * Returns the rosters.id, or null when nothing is published for that day.
 * Nothing stops two published rosters overlapping a date — a re-cut week is
 * published beside the one it replaces, and a WIDER period may be published
 * over ones it already contains. An unordered .limit(1) then returns whichever
 * row Postgres happened to reach first, so the same block could be tagged to a
 * different roster on two runs.
 *
 * THE RULE: the most recently PUBLISHED roster wins — published_at desc (nulls
 * last), then created_at desc. Ordering by period_start is wrong. Publish the
 * week 2026-05-04..05-10, then publish the month 2026-05-01..05-31 over it:
 * that month publish re-tags every block inside it, so a block created
 * afterwards for 2026-05-06 belongs to the MONTH — but the later period_start
 * is the WEEK's, and period_start ordering would hand the block back to a
 * roster the operator has already superseded.
 *
 * published_at is nullable (mig 072), so a row without one falls back to its
 * created_at; the batch matcher below does that coalesce in JS, and here the
 * nulls-last ORDER BY keeps an unstamped row behind a stamped one.
 *
 * Never throws: a failed lookup must not take a block insert down with it,
 * so an error is logged and treated as "no roster" (the block is created
 * untagged, which is exactly the pre-fix behaviour).
 *
 * @param {SupabaseClient} db  server-role client
 * @param {string} locationId
 * @param {string} dateIso     YYYY-MM-DD
 * @returns {Promise<string|null>}
 */
export async function findPublishedRosterFor(db, locationId, dateIso) {
  if (!locationId || !dateIso) return null
  const { data, error } = await db
    .from('rosters')
    .select('id, published_at, created_at')
    .eq('location_id', locationId)
    .eq('status', 'published')
    .lte('period_start', dateIso)
    .gte('period_end', dateIso)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    logWarn('roster', 'findPublishedRosterFor failed', { locationId, dateIso, err: error })
    return null
  }
  return data?.id || null
}

/**
 * ROSTER-FIX.5 — the batch form of findPublishedRosterFor. One query
 * spanning min(dates)..max(dates), matched in JS, so generating eight weeks
 * of blocks costs a single round trip instead of one per date.
 *
 * Overlapping published rosters resolve the same way as the single-date form:
 * the most recently PUBLISHED roster wins — published_at desc (nulls last),
 * then created_at desc. The ORDER BY is on the query AND the tie-break is
 * redone in JS — the ordering is what the database is asked for, the JS is
 * what makes the answer independent of the order the rows actually arrive in.
 *
 * @returns {Promise<Map<string, string>>} date (YYYY-MM-DD) → rosters.id.
 *          Dates with no published roster are simply absent.
 */
// ROSTER-FIX.5 — "the most recently published roster wins" for two published
// rosters covering the same day. NOT period_start: publish the week
// 2026-05-04..05-10, then publish the month 2026-05-01..05-31 over it, and a
// block created afterwards for 2026-05-06 must join the MONTH — the month is
// what re-tagged every block in that range — even though the WEEK has the
// later period_start.
//
// Key: published_at, falling back to created_at when a row was never stamped
// (published_at is nullable, mig 072), then created_at as the tie-break. A
// missing value (an old row, or a mock that doesn't carry it) sorts oldest
// rather than throwing the comparison off.
function publishedOrder(r) {
  return String(r.published_at || r.created_at || '')
}

function isNewerRoster(candidate, incumbent) {
  const a = publishedOrder(candidate)
  const b = publishedOrder(incumbent)
  if (a !== b) return a > b
  return String(candidate.created_at || '') > String(incumbent.created_at || '')
}

export async function findPublishedRosterIdsByDate(db, locationId, dates) {
  const out = new Map()
  const list = (dates || []).filter(Boolean)
  if (!locationId || list.length === 0) return out

  // Don't assume the caller sorted them.
  const sorted = [...list].sort()
  const minDate = sorted[0]
  const maxDate = sorted[sorted.length - 1]

  const { data, error } = await db
    .from('rosters')
    .select('id, period_start, period_end, published_at, created_at')
    .eq('location_id', locationId)
    .eq('status', 'published')
    .lte('period_start', maxDate)
    .gte('period_end', minDate)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (error) {
    logWarn('roster', 'findPublishedRosterIdsByDate failed', { locationId, minDate, maxDate, err: error })
    return out
  }

  // ISO dates compare correctly as strings, so no Date objects needed.
  for (const date of list) {
    let hit = null
    for (const r of (data || [])) {
      if (!(r.period_start <= date && r.period_end >= date)) continue
      if (hit && !isNewerRoster(r, hit)) continue
      hit = r
    }
    if (hit) out.set(date, hit.id)
  }
  return out
}
