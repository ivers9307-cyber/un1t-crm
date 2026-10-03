// STAFFCOST.1 — reading a staff row out of a STORED report, for display.
//
// Since the overtime work (30 Apr) generateReport's staff_cost rows carry
// regular_rate / overtime_rate / regular_hours / overtime_hours /
// regular_cost / overtime_cost / total_cost, but the Reporting table still
// read hourly_rate and total_hours — so every rate cell rendered €NaN and
// every hours cell 0, under summary cards that were correct.
//
// generated_reports keeps report_data forever, so rows written BEFORE the
// overtime change (hourly_rate, total_hours, total_cost) are still opened
// from Report History. Each field therefore falls back on its own to the old
// name, and anything that is not a finite number comes back null, which the
// formatters render as "—". Never NaN, never a made-up 0.

export const EMPTY_CELL = '—'

function num(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/**
 * Normalise one staff_cost row (new or legacy shape).
 * @returns {{ rate: number|null, overtimeRate: number|null, regularHours: number|null,
 *   overtimeHours: number|null, totalHours: number|null, totalCost: number|null,
 *   hasSplit: boolean }}
 */
export function readStaffCostRow(row = {}) {
  const regular = num(row.regular_hours)
  const overtime = num(row.overtime_hours)
  const hasSplit = regular != null || overtime != null
  const legacyTotal = num(row.total_hours)

  let totalHours = null
  if (hasSplit) totalHours = round1((regular ?? 0) + (overtime ?? 0))
  else if (legacyTotal != null) totalHours = legacyTotal

  return {
    rate: num(row.regular_rate) ?? num(row.hourly_rate),
    // null on the new shape means "no premium, overtime pays at the regular
    // rate" — shown as a dash, not as €0.
    overtimeRate: num(row.overtime_rate),
    // A legacy row has no split: all its hours were regular hours.
    regularHours: regular ?? legacyTotal,
    overtimeHours: overtime,
    totalHours,
    totalCost: num(row.total_cost),
    hasSplit,
  }
}

/** Hours for a staff_hours / legacy row: `total` (staff_hours) or `total_hours`. */
export function readStaffHoursTotal(row = {}) {
  const v = num(row.total) ?? num(row.total_hours)
  return v == null ? null : round1(v)
}

export function formatEuroCell(value) {
  const n = num(value)
  if (n == null) return EMPTY_CELL
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(n)
}

export function formatHoursCell(value) {
  const n = num(value)
  return n == null ? EMPTY_CELL : String(round1(n))
}

/** Does any row in this report carry the regular/overtime split? */
export function staffCostHasSplit(rows) {
  return (rows || []).some(r => readStaffCostRow(r).hasSplit)
}
