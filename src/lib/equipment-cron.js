// EQUIP-MAINT.3 — decision logic for the two inspection crons.
//
// Pure: no DB, no clock, no push. `today` is always passed in as a
// Dublin calendar string (YYYY-MM-DD) so every branch is testable and
// nothing depends on the server's timezone.

import { dowOf } from './equipment-dates.js'

/** Is `today` this location's inspection weekday, and is it switched on? */
export function isInspectionDay(settings, today) {
  if (!settings || !settings.enabled) return false
  const dow = settings.inspection_day_of_week
  // Explicit null/undefined check, not falsy — 0 is Sunday.
  if (dow === null || dow === undefined) return false
  return dowOf(today) === dow
}

/**
 * Assets that are due and have no SUBMITTED inspection for their
 * current cycle, most overdue first.
 *
 * Matching is on (equipment_id, due_on) — a submission for an earlier
 * cycle must not count as covering the current one, or an asset that
 * rolled forward would never be chased again.
 */
export function selectOutstanding({ assets = [], submitted = [], today }) {
  const done = new Set(submitted.map((s) => `${s.equipment_id}::${s.due_on}`))
  return assets
    .filter((a) => a.status === 'in_service')
    .filter((a) => a.next_due_on <= today)
    .filter((a) => !done.has(`${a.id}::${a.next_due_on}`))
    .sort((x, y) => (x.next_due_on < y.next_due_on ? -1 : x.next_due_on > y.next_due_on ? 1 : 0))
}

/** Push body for the inspection-day reminder. */
export function buildReminderBody(assets = []) {
  if (assets.length === 1) return `${assets[0].name} is due for inspection today.`
  return `${assets.length} pieces of equipment are due for inspection today.`
}

/**
 * Push body for the evening chase. Capped so it stays a push, not an
 * essay — the operator opens the app for the detail.
 */
export function buildOverdueBody(assets = []) {
  const n = assets.length
  const noun = n === 1 ? 'piece of equipment' : 'pieces of equipment'
  return `${n} ${noun} were due for inspection and no one submitted a check.`
}
