// Roster v2 phase 4 — week + month roll-up helpers.
//
// Pure functions over (blocks, staff, location). The
// ScheduleCalendar fetches blocks already; this lib transforms
// them into the numbers the summary panel renders.
//
// The shapes:
//   blocks  = [{ id, location_id, block_date, start_time, end_time,
//                 max_coaches, shift_assignments: [{ profile_id, ... }] }]
//   staff   = [{ id, full_name, employment_type, contracted_hours_per_week,
//                hourly_rate, annual_salary, overtime_rate }]
//
// We deliberately re-use shiftHours() from payroll.js — it
// handles overnight, override, and template fallback uniformly.
//
// Budget model (locked decision, mig 071):
//   - FTE shifts are sunk cost. They DON'T count against the
//     contractor euro budget. They get tracked in HOURS as a
//     utilisation metric ("are we using what we're paying for?").
//   - Contractor shifts cost (hours × hourly_rate) and that
//     total is what the monthly budget is measured against.

import { shiftHours, implicitHourlyRate } from './payroll'
import { addDays, formatDate } from './roster'

/**
 * Flatten a list of blocks into one virtual "shift" per (block,
 * assignment). Mirrors the legacy shifts shape just enough that
 * the existing payroll helpers can consume it.
 */
function blocksToShiftRows(blocks) {
  const rows = []
  for (const block of blocks || []) {
    const tpl = block.shift_templates || {}
    for (const a of block.shift_assignments || []) {
      rows.push({
        // Either start_time/end_time on the row itself, OR via the
        // shift_templates shape — both are accepted by shiftHours().
        start_time: block.start_time,
        end_time: block.end_time,
        shift_templates: tpl,
        profile_id: a.profile_id,
        block_date: block.block_date,
      })
    }
  }
  return rows
}

/**
 * Sum (date, hours) tuples for a single profile, across the date
 * range supplied. Returns total hours.
 */
function sumHoursForProfile(rows, profileId, startIso, endIso) {
  let total = 0
  for (const r of rows) {
    if (r.profile_id !== profileId) continue
    if (startIso && r.block_date < startIso) continue
    if (endIso && r.block_date > endIso) continue
    total += shiftHours(r)
  }
  return total
}

/**
 * Summarise the week starting at `weekStart` (Mon, 00:00 local).
 * Returns per-coach FTE utilisation rows + a contractor spend
 * roll-up for the visible week.
 *
 * @returns {{
 *   weekStartIso: string,
 *   weekEndIso: string,
 *   fte: Array<{
 *     profile_id: string, full_name: string,
 *     allocated_hours: number, contracted_hours: number,
 *     utilisation_pct: number | null,
 *     status: 'underused' | 'on_target' | 'overtime' | 'no_contract'
 *   }>,
 *   contractorWeekCostEur: number,
 *   blockCount: number,
 *   unstaffedCount: number,
 *   incompleteProfileNames: string[]
 * }}
 */
export function summarizeWeek({ blocks, staff, weekStart, today = new Date() }) {
  const start = weekStart instanceof Date ? weekStart : new Date(weekStart)
  const end = addDays(start, 6)
  const startIso = formatDate(start)
  const endIso = formatDate(end)
  const todayIso = formatDate(today instanceof Date ? today : new Date(today))

  const weekBlocks = (blocks || []).filter(
    b => b.block_date >= startIso && b.block_date <= endIso
  )
  const rows = blocksToShiftRows(weekBlocks)

  const fteSummaries = []
  const incompleteProfileNames = []
  let contractorWeekCostEur = 0

  for (const s of staff || []) {
    if (!s.active) continue
    const allocated = sumHoursForProfile(rows, s.id, startIso, endIso)
    if (allocated <= 0) continue

    if (s.employment_type === 'fte') {
      const contracted = Number(s.contracted_hours_per_week) || 0
      const hasPay = (Number(s.annual_salary) > 0) || (Number(s.hourly_rate) > 0)
      if (!hasPay || contracted <= 0) {
        incompleteProfileNames.push(s.full_name)
      }
      const status = contracted <= 0
        ? 'no_contract'
        : allocated > contracted
          ? 'overtime'
          : allocated >= contracted * 0.95
            ? 'on_target'
            : 'underused'
      fteSummaries.push({
        profile_id: s.id,
        full_name: s.full_name,
        allocated_hours: round1(allocated),
        contracted_hours: contracted,
        utilisation_pct: contracted > 0 ? Math.round((allocated / contracted) * 100) : null,
        status,
      })
    } else if (s.employment_type === 'contractor') {
      const rate = Number(s.hourly_rate) || 0
      if (rate <= 0) {
        incompleteProfileNames.push(s.full_name)
      }
      contractorWeekCostEur += allocated * rate
    }
  }

  // Sort FTE: overtime first, then underused, then on-target. Helps
  // the manager scan the panel for problems first.
  const order = { overtime: 0, no_contract: 1, underused: 2, on_target: 3 }
  fteSummaries.sort((a, b) => order[a.status] - order[b.status])

  const blockCount = weekBlocks.length
  const unstaffedCount = weekBlocks.filter(
    b => (b.shift_assignments?.length || 0) === 0 && b.block_date >= todayIso
  ).length

  return {
    weekStartIso: startIso,
    weekEndIso: endIso,
    fte: fteSummaries,
    contractorWeekCostEur: round2(contractorWeekCostEur),
    blockCount,
    unstaffedCount,
    incompleteProfileNames: Array.from(new Set(incompleteProfileNames)),
  }
}

/**
 * Summarise contractor cost for the calendar month containing
 * `referenceDate`. Compared against the location's
 * monthly_contractor_budget_eur (null = not configured).
 */
export function summarizeMonth({ blocks, staff, referenceDate, monthlyBudgetEur }) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate)
  const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1)
  const monthEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 0)
  const startIso = formatDate(monthStart)
  const endIso = formatDate(monthEnd)

  const monthBlocks = (blocks || []).filter(
    b => b.block_date >= startIso && b.block_date <= endIso
  )
  const rows = blocksToShiftRows(monthBlocks)

  let contractorCostEur = 0
  let fteImplicitCostEur = 0  // FTE doesn't hit the budget but we expose it for context
  for (const s of staff || []) {
    if (!s.active) continue
    const allocated = sumHoursForProfile(rows, s.id, startIso, endIso)
    if (allocated <= 0) continue
    if (s.employment_type === 'contractor') {
      const rate = Number(s.hourly_rate) || 0
      contractorCostEur += allocated * rate
    } else if (s.employment_type === 'fte') {
      fteImplicitCostEur += allocated * implicitHourlyRate(s)
    }
  }

  const budget = monthlyBudgetEur != null ? Number(monthlyBudgetEur) : null
  const remaining = budget != null ? budget - contractorCostEur : null
  const overBudget = budget != null && contractorCostEur > budget
  const utilisationPct = budget != null && budget > 0
    ? Math.round((contractorCostEur / budget) * 100)
    : null

  return {
    monthStartIso: startIso,
    monthEndIso: endIso,
    contractorCostEur: round2(contractorCostEur),
    fteImplicitCostEur: round2(fteImplicitCostEur),
    monthlyBudgetEur: budget,
    remainingEur: remaining != null ? round2(remaining) : null,
    overBudget,
    utilisationPct,
  }
}

function round1(n) { return Math.round(n * 10) / 10 }
function round2(n) { return Math.round(n * 100) / 100 }
