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
//   - SHIFTTYPE.1 (Richard, 25 Sep 2026): an ADMIN shift is out of the
//     contractor budget entirely. Its hours still count as hours (FTE
//     utilisation, implicit cost, week-cost, payroll).
//   - CONTRACTORSPEND.1 (27 Sep 2026): the MONTH figure prices every live
//     assignment at this studio by whoever HOLDS it (active, deactivated,
//     deleted, or a member of another studio: pay comes in keyed by holder),
//     counts only PUBLISHED shifts as spend and reports the rest beside it,
//     and takes its month from the Dublin calendar string, never a Date.

import { shiftHours, implicitHourlyRate } from './payroll'
import { addDays, formatDate, liveAssignments } from './roster'
import { effectiveOverride } from './roster-read'
import { shiftKindOf, isAdminShift } from '@shared/shift-kind'
import { monthBounds } from '@shared/roster-month'
import { isRealCalendarDate } from './schemas'

// Roster v2 phase 6 — leave-aware availability.
//
// For utilisation purposes, an FTE who's on holiday Mon-Wed
// can't be expected to fill their full contracted weekly hours.
// We subtract leave-day equivalents from the denominator so
// the "underused / on-target / overtime" bands stay meaningful.
//
// Convention: contracted_hours_per_week is treated as a Mon-Fri
// working contract (5 working days). Each weekday in approved
// leave subtracts (contracted_hours_per_week / 5) hours. Weekend
// leave doesn't reduce availability — the contract didn't count
// it in the first place.
//
// HOLIDAYLEAVE.1 — a bank holiday inside approved leave STILL counts here.
// countLeaveDays (time-off-days.js) skips it because it costs no ALLOWANCE;
// this function measures AVAILABILITY, and the coach is no more available on a
// bank holiday they are on leave for. The two are different questions and are
// meant to disagree on that one day.
//
// Half-days aren't honoured here; we'd need a `hours_per_day`
// or similar on time_off_requests for that. The error from
// treating a half-day as a full day is small and conservative
// (slightly over-counts leave → slightly under-counts
// expected hours → rooster shows the coach as more utilised
// than reality). Operators will spot it and we can refine.
export function leaveHoursInWeek({ timeOff, profileId, weekStart, contractedHoursPerWeek }) {
  if (!contractedHoursPerWeek || contractedHoursPerWeek <= 0) return 0
  if (!timeOff || timeOff.length === 0) return 0

  const start = weekStart instanceof Date ? weekStart : new Date(weekStart)
  start.setHours(0, 0, 0, 0)
  const startIso = formatDate(start)
  const endIso = formatDate(addDays(start, 6))

  const perDay = contractedHoursPerWeek / 5
  let weekdaysOnLeave = 0

  for (const req of timeOff) {
    if (req.profile_id !== profileId) continue
    if (req.status !== 'approved') continue

    // Overlap range of leave with the week.
    const overlapStart = req.start_date > startIso ? req.start_date : startIso
    const overlapEnd = req.end_date < endIso ? req.end_date : endIso
    if (overlapStart > overlapEnd) continue

    // Walk each day in the overlap and tick weekdays.
    let cursor = new Date(overlapStart + 'T00:00:00')
    const stop = new Date(overlapEnd + 'T00:00:00')
    while (cursor <= stop) {
      const dow = cursor.getDay() // 0 Sun .. 6 Sat
      if (dow >= 1 && dow <= 5) weekdaysOnLeave++
      cursor = addDays(cursor, 1)
    }
  }

  return Math.min(weekdaysOnLeave * perDay, contractedHoursPerWeek)
}

/**
 * Flatten a list of blocks into one virtual "shift" per (block,
 * assignment). Mirrors the legacy shifts shape just enough that
 * the existing payroll helpers can consume it.
 *
 * ROSTER-FIX.6c — exported, and now the ONLY copy. ScheduleCalendar carried a
 * second one (`flattenBlocksToShifts`) and the new /api/schedule/week-cost
 * endpoint needs the same rows server-side. The two were not identical, so the
 * merge had to pick a winner:
 *
 *   This one used to set `shift_templates: tpl` with no override, and
 *   shiftHours() prefers `tpl.start_time` over the row's own `start_time` — so
 *   it billed the TEMPLATE's window. The calendar's copy set a synthetic
 *   override whenever the block's times differed from the template's, so it
 *   billed the BLOCK's window.
 *
 *   The calendar's is correct and is what survives. A template edit never
 *   touches PAST blocks (templates/[id]/route.js says so deliberately: hours
 *   already worked are not rewritten), so a block whose times differ from its
 *   template is the normal shape of history, and billing the template's new
 *   window would restate a week that has already been paid. The only figures
 *   that move are in exactly that case, and they move toward the roster the
 *   operator is looking at.
 *
 * ROSTER-HOURS.1 layers the missing rung on top of that. Neither copy ever
 * consulted the ASSIGNMENT's own start_time_override / end_time_override, so a
 * coach put on part of a block billed the whole of it — in the summary panel,
 * the week-cost panel, and the contractor SPEND total that gates the
 * over-budget confirmation on POST /api/schedule/rosters. The precedence is now
 * the one roster-publish.js settled in ROSTER-FIX.4 and payroll's shiftHours
 * has always read: **the assignment's own window, then the block's, then the
 * template's** — which is exactly `effectiveOverride` (roster-read.js), already
 * the collapse used by the swaps, copy-week and /api/schedule/shifts reads.
 * Reusing it keeps one definition of "effective override" in the repo.
 *
 * The extra ids (`id` = the shift_assignments id, `block_id`, `location_id`,
 * `shift_date`) are what the calendar's swap flow reads off a row; nothing in
 * this module looks at them.
 */
export function blocksToShiftRows(blocks) {
  const rows = []
  for (const block of blocks || []) {
    const tpl = block.shift_templates || {}
    // ROSTER-FIX.1 — a cancelled assignment bills nobody's hours.
    for (const a of liveAssignments(block.shift_assignments)) {
      rows.push({
        id: a.id,
        block_id: block.id,
        location_id: block.location_id,
        // CONTRACTORSPEND.1 — contractor spend counts a shift as spend only on a
        // PUBLISHED roster (no roster, a draft or a stood-down 'superseded' one
        // is not yet spend). Nothing that counts HOURS looks at it.
        published: block.rosters?.status === 'published',
        profile_id: a.profile_id,
        shift_template_id: block.template_id,
        // SHIFTTYPE.1 — class | admin, read through the embedded template.
        // Contractor spend skips admin rows (summarizeMonth directly,
        // summarizeWeek via sumHoursForProfile's classOnly); nothing that
        // counts HOURS looks at it.
        kind: shiftKindOf(block),
        // Two spellings of the same day on purpose: the legacy shift shape the
        // payroll + swap helpers read says `shift_date`, this module's own
        // range filter says `block_date`.
        shift_date: block.block_date,
        block_date: block.block_date,
        // Either start_time/end_time on the row itself, OR via the
        // shift_templates shape — both are accepted by shiftHours(), which
        // reads the override FIRST.
        start_time: block.start_time,
        end_time: block.end_time,
        start_time_override: effectiveOverride(a.start_time_override, block.start_time, tpl.start_time),
        end_time_override: effectiveOverride(a.end_time_override, block.end_time, tpl.end_time),
        role_label: tpl.role_label || null,
        notes: a.notes || block.notes || null,
        status: a.status,
        shift_templates: tpl,
        profiles: a.profiles,
      })
    }
  }
  return rows
}

/**
 * Sum (date, hours) tuples for a single profile, across the date
 * range supplied. Returns total hours. `classOnly` (SHIFTTYPE.1) skips
 * admin rows: set ONLY where the hours become contractor euros.
 */
function sumHoursForProfile(rows, profileId, startIso, endIso, { classOnly = false } = {}) {
  let total = 0
  for (const r of rows) {
    if (r.profile_id !== profileId) continue
    if (startIso && r.block_date < startIso) continue
    if (endIso && r.block_date > endIso) continue
    if (classOnly && r.kind === 'admin') continue
    total += shiftHours(r)
  }
  return total
}

/**
 * Summarise the week starting at `weekStart` (Mon, 00:00 local).
 * Returns per-coach FTE utilisation rows + a contractor spend
 * roll-up for the visible week.
 *
 * @param {object[]} [args.timeOff]  Approved time_off_requests
 *   covering the visible window. When supplied (Roster v2
 *   phase 6), each FTE row's denominator is reduced by the
 *   profile's leave-day equivalents this week — so a coach
 *   who's off Mon-Wed shows full utilisation against the
 *   remaining 2 days, not "underused vs the full 30h
 *   contract".
 *
 * @returns {{
 *   weekStartIso: string,
 *   weekEndIso: string,
 *   fte: Array<{
 *     profile_id: string, full_name: string,
 *     allocated_hours: number,
 *     contracted_hours: number,
 *     leave_hours: number,
 *     effective_contracted_hours: number,
 *     utilisation_pct: number | null,
 *     status: 'underused' | 'on_target' | 'overtime' | 'no_contract' | 'on_leave'
 *   }>,
 *   contractorWeekCostEur: number,
 *   blockCount: number,
 *   unstaffedCount: number,
 *   incompleteProfileNames: string[]
 * }}
 */
export function summarizeWeek({ blocks, staff, weekStart, timeOff = [], today = new Date() }) {
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
      const leaveHours = leaveHoursInWeek({
        timeOff,
        profileId: s.id,
        weekStart: start,
        contractedHoursPerWeek: contracted,
      })
      const effectiveContracted = Math.max(0, contracted - leaveHours)

      // Status thresholds:
      //   no_contract → contracted = 0 (no comparator)
      //   on_leave    → leave consumed the entire week (effective = 0)
      //                 but the coach was rostered anyway. Distinct
      //                 from overtime because the cause is a roster
      //                 bug (assigned during approved leave) rather
      //                 than a workload signal.
      //   overtime    → allocated > effective contracted
      //   on_target   → allocated >= effective contracted * 0.95
      //   underused   → otherwise
      let status
      if (contracted <= 0) status = 'no_contract'
      else if (effectiveContracted <= 0) status = 'on_leave'
      else if (allocated > effectiveContracted) status = 'overtime'
      else if (allocated >= effectiveContracted * 0.95) status = 'on_target'
      else status = 'underused'

      const utilisationPct = effectiveContracted > 0
        ? Math.round((allocated / effectiveContracted) * 100)
        : (allocated > 0 ? 999 : null) // sentinel for "rostered while on full leave"

      fteSummaries.push({
        profile_id: s.id,
        full_name: s.full_name,
        allocated_hours: round1(allocated),
        contracted_hours: contracted,
        leave_hours: round1(leaveHours),
        effective_contracted_hours: round1(effectiveContracted),
        utilisation_pct: utilisationPct,
        status,
      })
    } else if (s.employment_type === 'contractor') {
      const rate = Number(s.hourly_rate) || 0
      if (rate <= 0) {
        incompleteProfileNames.push(s.full_name)
      }
      // SHIFTTYPE.1 — admin shifts are out of contractor spend.
      contractorWeekCostEur += sumHoursForProfile(rows, s.id, startIso, endIso, { classOnly: true }) * rate
    }
  }

  // Sort FTE: rostered-while-on-leave first (red flag), then
  // overtime, then no_contract, underused, on-target. Helps the
  // manager scan the panel for problems first.
  const order = { on_leave: 0, overtime: 1, no_contract: 2, underused: 3, on_target: 4 }
  fteSummaries.sort((a, b) => order[a.status] - order[b.status])

  const blockCount = weekBlocks.length
  // SHIFTTYPE.1 — an admin shift has no minimum staffing, so an empty one is
  // not "unstaffed" (it is still counted in blockCount).
  const unstaffedCount = weekBlocks.filter(
    b => !isAdminShift(b) && liveAssignments(b.shift_assignments).length === 0 && b.block_date >= todayIso
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
 * Contractor cost for the calendar month containing `referenceDate`, against
 * the location's monthly_contractor_budget_eur (null = not configured).
 *
 * CONTRACTORSPEND.1 — three rules changed, each of which dropped worked shifts:
 *   - WHO: every live assignment on these blocks is priced by its HOLDER, found
 *     in `pay` (loadHolderPay, keyed by profile id). It used to loop over this
 *     studio's ACTIVE members, so a contractor deactivated mid-month, one from
 *     the sibling studio covering a class, and a deleted one all cost €0.
 *   - WHICH: `contractorCostEur` (and overBudget / remainingEur /
 *     utilisationPct) counts PUBLISHED shifts; everything else is
 *     `unpublishedContractorCostEur`, with the projection beside it, so a month
 *     still being drafted shows where it is heading without calling it spent.
 *   - WHEN: `referenceDate` is a 'YYYY-MM-DD' Dublin calendar date and the
 *     month is string arithmetic (monthBounds). It was `new Date(referenceDate)`
 *     read with local getters: UTC midnight, so west of UTC the 1st was the
 *     month before and the sum came back €0. A Date, and an impossible date
 *     (2026-02-30, 2026-13-01), are refused.
 * SHIFTTYPE.1 unchanged: an admin shift costs the contractor budget nothing.
 * Employment type is the holder's CURRENT one for the whole month (no history).
 *
 * @param {object} args
 * @param {object[]} args.blocks  shift_blocks with rosters(status), shift_templates, shift_assignments
 * @param {Map<string, {employment_type, hourly_rate, annual_salary, contracted_hours_per_week}>} args.pay
 * @param {string} args.referenceDate  YYYY-MM-DD inside the month
 * @param {number|string|null} args.monthlyBudgetEur
 */
export function summarizeMonth({ blocks, pay, referenceDate, monthlyBudgetEur }) {
  // The shape alone is not enough: monthBounds('2026-02-30') is March and
  // '2026-13-01' is NaN-NaN-NaN, which matches no block and reads as €0 spent.
  if (!isRealCalendarDate(referenceDate)) {
    throw new TypeError('summarizeMonth: referenceDate must be a real YYYY-MM-DD string (a Dublin calendar date)')
  }
  const { monthStartIso, monthEndIso } = monthBounds(referenceDate)

  const monthBlocks = (blocks || []).filter(
    b => b.block_date >= monthStartIso && b.block_date <= monthEndIso
  )

  let contractorCostEur = 0
  let unpublishedContractorCostEur = 0
  // FTE doesn't hit the budget; it is context for owners / managers / masters.
  // Salary-derived, so the route withholds it from head coaches (FTECOSTVIS.1).
  let fteImplicitCostEur = 0
  for (const r of blocksToShiftRows(monthBlocks)) {
    const person = pay?.get(r.profile_id)
    if (!person) continue
    const hours = shiftHours(r)
    if (person.employment_type === 'contractor') {
      // SHIFTTYPE.1 — admin shifts are out of the contractor budget.
      if (r.kind === 'admin') continue
      const cost = hours * (Number(person.hourly_rate) || 0)
      if (r.published) contractorCostEur += cost
      else unpublishedContractorCostEur += cost
    } else if (person.employment_type === 'fte' && r.published) {
      fteImplicitCostEur += hours * implicitHourlyRate(person)
    }
  }

  const projected = contractorCostEur + unpublishedContractorCostEur
  const budget = monthlyBudgetEur != null ? Number(monthlyBudgetEur) : null
  const remaining = budget != null ? budget - contractorCostEur : null
  const overBudget = budget != null && contractorCostEur > budget
  const utilisationPct = budget != null && budget > 0
    ? Math.round((contractorCostEur / budget) * 100)
    : null

  return {
    monthStartIso,
    monthEndIso,
    contractorCostEur: round2(contractorCostEur),
    unpublishedContractorCostEur: round2(unpublishedContractorCostEur),
    projectedContractorCostEur: round2(projected),
    fteImplicitCostEur: round2(fteImplicitCostEur),
    monthlyBudgetEur: budget,
    remainingEur: remaining != null ? round2(remaining) : null,
    overBudget,
    projectedOverBudget: budget != null && projected > budget,
    utilisationPct,
  }
}

function round1(n) { return Math.round(n * 10) / 10 }
function round2(n) { return Math.round(n * 100) / 100 }
