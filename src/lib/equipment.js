// EQUIP-MAINT.1 — pure logic for the equipment maintenance feature.
//
// Nothing here touches Supabase or the network. Every function takes
// plain data and returns plain data, so the risky part (date maths)
// is testable without mocks. DB access lives in ./equipment-db.js.
//
// DATES: every date here is a timezone-less calendar string
// (YYYY-MM-DD), like bookings.booking_date. We build from parts in UTC
// and format by hand — never toISOString(), never local-time parsing —
// so results are identical under TZ=Europe/Dublin and a US timezone,
// and across the BST/GMT boundary. See CLAUDE.md "Timezones".

export const EQUIPMENT_STATUS = Object.freeze({
  IN_SERVICE: 'in_service',
  OUT_OF_SERVICE: 'out_of_service',
  RETIRED: 'retired',
})

export const INSPECTION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
})

export const ITEM_LABEL_MAX = 200
export const MAX_ITEMS_PER_TYPE = 50
export const RESULT_NOTE_MAX = 500
export const INTERVAL_WEEKS_MIN = 1
export const INTERVAL_WEEKS_MAX = 52

// issues.description caps at 4000 (mig 213) — compose never exceeds it.
export const ISSUE_DESCRIPTION_MAX = 4000

// ---- date helpers -------------------------------------------------

/** Format a UTC Date as YYYY-MM-DD by hand (toISOString is guardrail-blocked). */
function formatUtc(dt) {
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(dt.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toUtcDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Day of week for a YYYY-MM-DD string, Postgres convention (0 = Sunday). */
export function dowOf(dateStr) {
  return toUtcDate(dateStr).getUTCDay()
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
export function addDays(dateStr, days) {
  const dt = toUtcDate(dateStr)
  dt.setUTCDate(dt.getUTCDate() + days)
  return formatUtc(dt)
}

/** The next date on or after `fromDateStr` falling on weekday `dow`. */
export function nextOccurrenceOfDow(fromDateStr, dow) {
  const delta = (dow - dowOf(fromDateStr) + 7) % 7
  return addDays(fromDateStr, delta)
}

/**
 * First due date for a newly registered asset.
 * Operator override wins; otherwise the next inspection weekday on or
 * after today; otherwise (no settings row yet) today, which gets
 * snapped to the weekday at the first roll-forward.
 */
export function firstDueOn({ today, inspectionDayOfWeek, explicitFirstDue }) {
  if (explicitFirstDue) return explicitFirstDue
  if (inspectionDayOfWeek === null || inspectionDayOfWeek === undefined) return today
  return nextOccurrenceOfDow(today, inspectionDayOfWeek)
}

/**
 * Next due date after a submitted inspection.
 * Measured from `dueOn` (the cycle date), NOT from today, so a late
 * inspection does not drag the schedule permanently later. If that
 * still lands in the past, step in whole intervals until it is on or
 * after today, so submitting never produces an instantly-overdue item.
 * Because the interval is whole weeks, the weekday is preserved.
 */
export function rollForward({ dueOn, intervalWeeks, today }) {
  const step = intervalWeeks * 7
  let next = addDays(dueOn, step)
  while (next < today) next = addDays(next, step)
  return next
}
