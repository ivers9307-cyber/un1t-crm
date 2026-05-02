// Roster v2 helpers — block generation, date math, capacity checks.
//
// Used by:
//   - /api/schedule/templates POST/PUT (to materialise blocks when
//     a template's days_of_week changes)
//   - /api/schedule/blocks GET (to lazy-extend the visible horizon
//     when an operator scrolls forward past 8 weeks)
//   - block-related lib tests
//
// We deliberately keep this module pure on its inputs (the supabase
// client is passed in) so it can be unit-tested with the same mock
// pattern used elsewhere in src/lib/.

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
 * Format a Date as YYYY-MM-DD (no time component, no TZ).
 */
export function formatDate(date) {
  return date.toISOString().split('T')[0]
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

  const records = dates.map(date => ({
    location_id: template.location_id,
    template_id: template.id,
    block_date: date,
    start_time: template.start_time,
    end_time: template.end_time,
    max_coaches: template.max_coaches || 15,
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
