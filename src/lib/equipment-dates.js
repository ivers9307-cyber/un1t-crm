// EQUIP-MAINT.1 — pure date arithmetic for inspection cycles.
//
// Split out of equipment.js at code review: date maths is the only
// genuinely risky and reusable part of this feature, and equipment.js
// will keep growing through PR 2/3 — splitting later is an untangle.
// equipment.js re-exports everything here, so existing import sites
// are unaffected.
//
// DATES: every date here is a timezone-less calendar string
// (YYYY-MM-DD), like bookings.booking_date — not a wall-clock instant.
// Local-time Date parsing shifts these across the BST/GMT boundary and
// silently corrupts a business "today" (CLAUDE.md "Timezones").
// addDaysISO (dublin-time.js) parses via `new Date(dateStr +
// 'T00:00:00Z')` and formats off the UTC fields, so results are
// identical under TZ=Europe/Dublin and a US timezone, and across the
// BST/GMT boundary. It does no I/O, so this file stays mock-free.

import { addDaysISO } from '@/lib/dublin-time'

// Defined HERE, not in ./equipment.js, and re-exported from there for callers.
// rollForward's range guard is the only place these are enforced, so importing
// them back from equipment.js would create a cycle — and in that cycle they
// evaluate to undefined at module-eval time, making `intervalWeeks < undefined`
// always false and silently disabling the guard that prevents the roll-forward
// loop spinning on a request thread.
export const INTERVAL_WEEKS_MIN = 1
export const INTERVAL_WEEKS_MAX = 52

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function assertDateStr(dateStr, fnName) {
  if (!DATE_RE.test(String(dateStr))) {
    throw new RangeError(`${fnName}: expected a YYYY-MM-DD date, got ${dateStr}`)
  }
}

/**
 * Add (or subtract) whole days to a YYYY-MM-DD string.
 * Malformed input throws at the defect rather than downstream — a bad
 * date silently producing another bad date is how corruption spreads.
 */
export function addDays(dateStr, days) {
  assertDateStr(dateStr, 'addDays')
  return addDaysISO(dateStr, days)
}

/** Day of week for a YYYY-MM-DD string, Postgres convention (0 = Sunday). */
export function dowOf(dateStr) {
  assertDateStr(dateStr, 'dowOf')
  return new Date(dateStr + 'T00:00:00Z').getUTCDay()
}

/** The next date on or after `fromDateStr` falling on weekday `dow`. */
export function nextOccurrenceOfDow(fromDateStr, dow) {
  const delta = (dow - dowOf(fromDateStr) + 7) % 7
  return addDays(fromDateStr, delta)
}

/**
 * First due date for a newly registered asset.
 * Operator override wins; otherwise the next inspection weekday on or
 * after today; otherwise (no settings row yet) today. That last
 * fallback is NOT corrected later — rollForward adds whole weeks from
 * `dueOn` and is never given inspectionDayOfWeek, so a `today` that
 * doesn't fall on the studio's inspection weekday keeps its wrong
 * weekday forever. It remains here only as a defensive default for
 * direct callers; the register route (src/app/api/equipment/route.js
 * POST) is no longer able to reach it — it 409s before calling this
 * when getSettings() returns no row, rather than mint an off-weekday
 * asset.
 */
export function firstDueOn({ today, inspectionDayOfWeek, explicitFirstDue }) {
  if (explicitFirstDue) return explicitFirstDue
  if (inspectionDayOfWeek === null || inspectionDayOfWeek === undefined) return today
  if (!Number.isInteger(inspectionDayOfWeek) || inspectionDayOfWeek < 0 || inspectionDayOfWeek > 6) {
    throw new RangeError(
      `firstDueOn: inspectionDayOfWeek must be an integer 0-6, got ${inspectionDayOfWeek}`
    )
  }
  return nextOccurrenceOfDow(today, inspectionDayOfWeek)
}

/**
 * Next due date after a submitted inspection.
 * Measured from `dueOn` (the cycle date), NOT from today, so a late
 * inspection does not drag the schedule permanently later. If that
 * still lands in the past, step in whole intervals until it is on or
 * after today, so submitting never produces an instantly-overdue item.
 * Because the interval is whole weeks, the weekday is preserved.
 *
 * intervalWeeks is already validated by Zod at the route and by a
 * `check (interval_weeks between 1 and 52)` in the database, so an
 * invalid value reaching here means both gates were bypassed — a
 * broken invariant, not user input. This throws rather than clamping:
 * clamping would invent a schedule the operator never chose and hide
 * the failure for months. It also closes a quieter failure mode than
 * the obvious infinite loop — with `dueOn` in the FUTURE and
 * intervalWeeks 0/invalid, an unguarded version has no loop and no
 * error, so it returns `dueOn` unchanged and the caller reports
 * success while the asset's schedule silently stops advancing.
 */
export function rollForward({ dueOn, intervalWeeks, today }) {
  if (
    !Number.isInteger(intervalWeeks) ||
    intervalWeeks < INTERVAL_WEEKS_MIN ||
    intervalWeeks > INTERVAL_WEEKS_MAX
  ) {
    throw new RangeError(
      `rollForward: intervalWeeks must be an integer ${INTERVAL_WEEKS_MIN}-${INTERVAL_WEEKS_MAX}, got ${intervalWeeks}`
    )
  }
  const step = intervalWeeks * 7
  let next = addDays(dueOn, step)
  // Bounded backstop: with a validated interval this cannot run away,
  // but dueOn/today are not validated here and nothing may ever spin
  // on a request thread. 520 iterations is ten years at weekly.
  for (let i = 0; next < today && i < 520; i++) next = addDays(next, step)
  return next
}
