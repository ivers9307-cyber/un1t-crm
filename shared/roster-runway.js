// RUNWAY.1 — roster runway: is the next week coming up ready?
//
// Live on 2026-09-19: the week of 28 Sep was 9 days away with 0 of 34 shifts
// staffed and nothing published, and no surface said so. Rosters are built in
// monthly batches, and the first week's lead time had slipped from 20 days to
// 12-14. The this-week staffing chip (shared/roster-staffing.js) cannot see
// it: it stops at Sunday and knows nothing about publication.
//
// SCOPE: weeks that START IN THE FUTURE (Monday > today), and only those. The
// current week already has its surfaces: the Today page's staffing-gap card
// (fetchStaffingGapsThisWeek) counts empty and short shifts from today to
// Sunday, and the schedule banner covers publication. Counting it here too
// let one empty shift this week MASK the chip for an unbuilt later week and
// sent a red "This week: ..." push that said nothing the card did not.
//
// DELIBERATE: a PUBLISHED week whose only problem is a shift BELOW its minimum
// (but with at least one coach) does NOT alert. This studio routinely runs
// several shifts one coach short every week, so alerting on it would push
// every week forever and train people to ignore the alert; the calendar's
// amber "1 of 2" badges and the publish preview already show it. The body
// still reports "N below the minimum" when a week alerts for another reason.
//
// SHIFTTYPE.1: admin shifts are not on the runway at all. futureBlockStaffing
// returns null for them, so they count toward none of blocks / staffed /
// published, and a week whose only unstaffed or unpublished blocks are admin
// is ready. A week of only admin blocks is "0 blocks", which says nothing.
//
// ACCEPTED: on its Monday a week drops off the runway even if it is staffed
// but still unpublished. By then its amber and its red have both fired and
// the chip has shown for ten days; from Monday it is the banner's job.
//
// `rosterRunway` is the one answer, shared by the web Today chip, the mobile
// Studio dashboard chip and the daily push, so the three cannot disagree.
//
// Dependency-free apart from roster-staffing: `shared/` is the mobile seam and
// cannot import src/lib. Dates are timezoneless YYYY-MM-DD strings; the caller
// supplies the Dublin "today" (dublinTodayStr on the server). All arithmetic
// goes through Date.UTC so a 23h / 25h DST day can never shift a calendar day.

import { futureBlockStaffing } from './roster-staffing.js'

export const RUNWAY_AMBER_DAYS = 10
export const RUNWAY_RED_DAYS = 5
export const RUNWAY_WEEKS = 2

const DAY_MS = 24 * 60 * 60 * 1000
const utcMs = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// Whole calendar days from `fromIso` to `toIso` (negative when `toIso` is
// earlier). These three date helpers are deliberately NOT exported: src/lib
// already exports an `addDaysIso` (invoice-extraction.js) and a `daysBetween`
// (hyrox/mapping.js), and tests/shared-pair-sync.test.js makes any export name
// shared between shared/ and src/lib a pair someone must classify.
function daysBetween(fromIso, toIso) {
  return Math.round((utcMs(toIso) - utcMs(fromIso)) / DAY_MS)
}

// The Monday of the Mon-Sun week containing `dateIso`.
function weekStartIso(dateIso) {
  const ms = utcMs(dateIso)
  const daysSinceMonday = (new Date(ms).getUTCDay() + 6) % 7
  return isoOf(ms - daysSinceMonday * DAY_MS)
}

function addDaysIso(dateIso, days) {
  return isoOf(utcMs(dateIso) + days * DAY_MS)
}

/**
 * The block-date window the reader must fetch: NEXT Monday to the Sunday of
 * the week after it (next week and the week after). The current week is not
 * read at all. A 10-day horizon can never reach a third upcoming week: next
 * Monday is 1 to 7 days off, so the third one is at least 15.
 */
export function runwayWindow(todayIso) {
  const nextMonday = addDaysIso(weekStartIso(todayIso), 7)
  return {
    from: nextMonday,
    to: addDaysIso(nextMonday, RUNWAY_WEEKS * 7 - 1),
    weekStarts: Array.from({ length: RUNWAY_WEEKS }, (_, i) => addDaysIso(nextMonday, i * 7)),
  }
}

/**
 * EVERY week, soonest first, whose Monday is 1 to 10 days away and that is not
 * ready: some block has no coach, or some block is not published.
 *
 *   severity 'red'   — the week starts in 1 to 5 days
 *   severity 'amber' — it starts in 6 to 10 days
 *
 * A week that has started (its Monday is today or earlier) is never returned,
 * whatever state it is in: see SCOPE at the top of this file.
 *
 * Empty when every week inside the horizon is ready. A week with ZERO blocks
 * says nothing: a studio with no shift templates has no blocks at all, and
 * "0 of 0" is not a roster that needs building.
 *
 * `underMin` rides along for the copy but does not raise the alert on its own:
 * this is about a roster that has not been BUILT, and a built week that is one
 * coach short is the staffing chip's job.
 *
 * The daily push walks this whole list. It must: one shift in NEXT week that
 * cannot be filled keeps next week unready until it starts, and announcing
 * only the first unready week would hide the week after until it was 7 days
 * out, swallowing most of its amber. The chips show the head of the list
 * (rosterRunway).
 *
 * @param {Array<{ weekStart: string, blocks: number, staffed: number, underMin: number, published: number }>} weeks
 * @param {string} todayIso
 */
export function rosterRunwayWeeks(weeks, todayIso) {
  const sorted = (weeks || [])
    .filter((w) => w?.weekStart)
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))

  const unready = []
  for (const w of sorted) {
    const daysAway = daysBetween(todayIso, w.weekStart)
    if (daysAway > RUNWAY_AMBER_DAYS) break
    if (daysAway < 1) continue // this week (or a past one): not the runway's business
    const blocks = Number(w.blocks) || 0
    if (blocks === 0) continue
    const staffed = Math.min(blocks, Number(w.staffed) || 0)
    const published = Math.min(blocks, Number(w.published) || 0)
    const unstaffed = blocks - staffed
    const unpublished = blocks - published
    if (unstaffed === 0 && unpublished === 0) continue
    unready.push({
      weekStart: w.weekStart,
      daysAway,
      severity: daysAway <= RUNWAY_RED_DAYS ? 'red' : 'amber',
      blocks,
      staffed,
      underMin: Number(w.underMin) || 0,
      published,
      unstaffed,
      unpublished,
    })
  }
  return unready
}

/**
 * The FIRST unready week inside the horizon (see rosterRunwayWeeks), or null
 * when every week is ready. This is what the chips show: one line per studio.
 */
export function rosterRunway(weeks, todayIso) {
  return rosterRunwayWeeks(weeks, todayIso)[0] ?? null
}

/**
 * Per-week counts from raw shift_blocks rows (ONE location's rows).
 *
 *   blocks    — blocks dated inside the two upcoming Mon-Sun weeks (the current
 *               week, and anything past, is not counted at all)
 *   staffed   — of those, blocks with at least one LIVE coach
 *   underMin  — of the staffed ones, blocks below their min_coaches
 *   published — blocks whose roster is published, i.e. exactly what a coach
 *               can see (`rosters.status === 'published'`; superseded is NOT)
 *
 * Staffing is futureBlockStaffing's answer, the same one the calendar, the
 * banner and the this-week chip use, so a cancelled assignment is not a coach.
 *
 * @param {Array<object>} blocks  rows: block_date, min_coaches, rosters: { status }, shift_assignments: [{ status }]
 * @param {string} todayIso
 * @returns {Array<{ weekStart: string, blocks: number, staffed: number, underMin: number, published: number }>}
 */
export function runwayWeeksFromBlocks(blocks, todayIso) {
  const byWeek = new Map(
    runwayWindow(todayIso).weekStarts.map((ws) => [ws, { weekStart: ws, blocks: 0, staffed: 0, underMin: 0, published: 0 }]),
  )
  for (const b of blocks || []) {
    const s = futureBlockStaffing(b, todayIso)
    if (!s) continue // unreadable, an admin shift (SHIFTTYPE.1), or past (the window excludes those anyway)
    const week = byWeek.get(weekStartIso(b.block_date))
    if (!week) continue // the current week, or beyond the second upcoming one
    week.blocks++
    if (s.status !== 'empty') week.staffed++
    if (s.status === 'short') week.underMin++
    if (b.rosters?.status === 'published') week.published++
  }
  return [...byWeek.values()]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso) => {
  const [, m, d] = String(iso).split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}
const plural = (n, one, many) => (n === 1 ? one : many)

/** "Week of 28 Sep is not ready", or "Studio North: week of 28 Sep is not ready". */
export function rosterRunwayHeadline(runway, { locationName = '' } = {}) {
  const lead = locationName ? `${locationName}: week` : 'Week'
  return `${lead} of ${shortDate(runway.weekStart)} is not ready`
}

/** "Starts in 9 days: 34 of 34 shifts have no coach, not published." */
export function rosterRunwayDetail(runway) {
  const parts = []
  if (runway.unstaffed > 0) {
    parts.push(`${runway.unstaffed} of ${runway.blocks} ${plural(runway.blocks, 'shift', 'shifts')} ${plural(runway.unstaffed, 'has', 'have')} no coach`)
  }
  if (runway.underMin > 0) parts.push(`${runway.underMin} below the minimum`)
  if (runway.unpublished === runway.blocks) parts.push('not published')
  else if (runway.unpublished > 0) parts.push(`${runway.unpublished} ${plural(runway.unpublished, 'shift', 'shifts')} not published`)
  // daysAway is always >= 1: a week that has started is never on the runway.
  const when = runway.daysAway === 1 ? 'Starts tomorrow' : `Starts in ${runway.daysAway} days`
  return `${when}: ${parts.join(', ')}.`
}
