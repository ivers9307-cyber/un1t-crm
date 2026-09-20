// RUNWAY.1 — roster runway: is the next week coming up ready?
//
// Live on 2026-09-19: the week of 28 Sep was 9 days away with 0 of 34 shifts
// staffed and nothing published, and no surface said so. Rosters are built in
// monthly batches, and the first week's lead time had slipped from 20 days to
// 12-14. The this-week staffing chip (shared/roster-staffing.js) cannot see
// it: it stops at Sunday and knows nothing about publication.
//
// `rosterRunway` is the one answer, shared by the web Today chip, the mobile
// Studio dashboard chip and the daily push, so the three cannot disagree.
//
// Dependency-free apart from roster-staffing: `shared/` is the mobile seam and
// cannot import src/lib. Dates are timezoneless YYYY-MM-DD strings; the caller
// supplies the Dublin "today" (dublinTodayStr on the server). All arithmetic
// goes through Date.UTC so a 23h / 25h DST day can never shift a calendar day.

export const RUNWAY_AMBER_DAYS = 10
export const RUNWAY_RED_DAYS = 5
export const RUNWAY_WEEKS = 3

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
 * The block-date window the reader must fetch: today to the Sunday of the
 * third week (this week, next week, the week after). A 10-day horizon can
 * never reach a fourth week, because the third Monday is at most 14 days off.
 */
export function runwayWindow(todayIso) {
  const thisMonday = weekStartIso(todayIso)
  return {
    from: todayIso,
    to: addDaysIso(thisMonday, RUNWAY_WEEKS * 7 - 1),
    weekStarts: Array.from({ length: RUNWAY_WEEKS }, (_, i) => addDaysIso(thisMonday, i * 7)),
  }
}

/**
 * The first week, soonest first, whose Monday is within 10 days and that is
 * not ready: some block has no coach, or some block is not published.
 *
 *   severity 'red'   — the week starts in 5 days or fewer (or is this week)
 *   severity 'amber' — it starts in 6 to 10 days
 *
 * Returns null when every week inside the horizon is ready. A week with ZERO
 * blocks says nothing: a studio with no shift templates has no blocks at all,
 * and "0 of 0" is not a roster that needs building.
 *
 * `underMin` rides along for the copy but does not raise the alert on its own:
 * this is about a roster that has not been BUILT, and a built week that is one
 * coach short is the staffing chip's job.
 *
 * @param {Array<{ weekStart: string, blocks: number, staffed: number, underMin: number, published: number }>} weeks
 * @param {string} todayIso
 */
export function rosterRunway(weeks, todayIso) {
  const sorted = (weeks || [])
    .filter((w) => w?.weekStart)
    .slice()
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))

  for (const w of sorted) {
    const daysAway = daysBetween(todayIso, w.weekStart)
    if (daysAway > RUNWAY_AMBER_DAYS) break
    if (daysAway < -6) continue // a week that has fully passed
    const blocks = Number(w.blocks) || 0
    if (blocks === 0) continue
    const staffed = Math.min(blocks, Number(w.staffed) || 0)
    const published = Math.min(blocks, Number(w.published) || 0)
    const unstaffed = blocks - staffed
    const unpublished = blocks - published
    if (unstaffed === 0 && unpublished === 0) continue
    return {
      weekStart: w.weekStart,
      daysAway,
      severity: daysAway <= RUNWAY_RED_DAYS ? 'red' : 'amber',
      blocks,
      staffed,
      underMin: Number(w.underMin) || 0,
      published,
      unstaffed,
      unpublished,
    }
  }
  return null
}
