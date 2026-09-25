// Roster v2 phase 5 — publish helpers.
//
// projectPublishImpact: server-side function that given a
// location + publish period returns what the month-total
// contractor spend WILL be if this period is published, plus
// the budget delta — per calendar month the period touches
// (BUDGETAPPROVE.1). Drives the publish modal's "you'll be €X
// over budget" preview AND the API's hard gate for managers.
//
// publishRoster: creates a `rosters` row, tags blocks in the
// period with the roster_id, sets shifts.published=true via
// the legacy mirror so mobile/reports keep working.
//
// findConflictingPublishedRosters: the overlap guard. Lives here
// rather than in the POST route because BOTH ways a roster becomes
// published — POST /api/schedule/rosters and the approve endpoint
// flipping a draft — have to run it, and a guard that only one of
// them ran was no guard at all.

import { shiftHours, mondayOf } from './payroll'
import { liveAssignments } from './roster'
import { staffingGaps } from './roster-staffing'
import { dublinTodayStr, addDaysISO } from './dublin-time'
import { leaveScopeOrFilter } from './time-off-leave'
import { logWarn } from './log'
import { leaveCovering, leaveClashes, doubleBookings } from './roster-publish-advisories'
import { loadWorkingTimeShifts } from './working-time-data'
import { workingTimeAdvisories } from '@shared/working-time'

function isoFirstOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`
}

function isoLastOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number)
  // m is 1-12; new Date(y, m, 0) returns last day of month m.
  const last = new Date(Date.UTC(y, m, 0))
  return last.toISOString().slice(0, 10)
}

/**
 * ROSTER-TRIM.1 — the ISO date `days` either side of `iso`, in UTC so it
 * cannot drift with the process timezone. Used to compute the day before a
 * publish period starts (and the day after it ends), which is where a
 * straddling roster gets trimmed back to.
 */
export function isoShiftDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * BUDGETAPPROVE.1 — every calendar month [periodStart, periodEnd] touches, as
 * `{ monthStart, monthEnd }` in order. Pure string arithmetic on ISO dates, so
 * it cannot drift with the process timezone (a `new Date('2026-09-01')` parsed
 * in Dublin and formatted in UTC is how month keys go wrong).
 */
export function monthsTouched(periodStart, periodEnd) {
  const months = []
  let [y, m] = periodStart.slice(0, 7).split('-').map(Number)
  const [endY, endM] = periodEnd.slice(0, 7).split('-').map(Number)
  while (y < endY || (y === endY && m <= endM)) {
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`
    months.push({ monthStart, monthEnd: isoLastOfMonth(monthStart) })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return months
}

// PostgREST caps every select at 1000 rows whatever .limit() says. One month
// of blocks fits, but a period spanning months loads every month it touches,
// so the block read pages rather than trusting it to fit.
const BLOCK_PAGE_SIZE = 1000

/**
 * Return the (location, contractor staff lookup, blocks-in-months
 * with roster join, current monthly_contractor_budget_eur) needed
 * to evaluate a publish.
 *
 * BUDGETAPPROVE.1 — loads EVERY calendar month the period touches, not just
 * the month periodStart falls in. Loading only that month silently dropped
 * the days a week carried into the next month: the 31 Aug–6 Sep draft was
 * stored at €99.96 (Monday alone) against a real €689.95.
 *
 * COPYLEAVE.1 — `advisories: false` skips everything that only feeds the
 * advisory lists (the widened leave scope and the other-studio read), for
 * callers that never show them. The budget inputs are identical either way.
 */
async function loadBudgetContext(db, locationId, periodStart, periodEnd = periodStart, { advisories = true } = {}) {
  const monthStart = isoFirstOfMonth(periodStart)
  const monthEnd = isoLastOfMonth(periodEnd > periodStart ? periodEnd : periodStart)

  // Location budget snapshot.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, organization_id, monthly_contractor_budget_eur')
    .eq('id', locationId)
    .single()
  if (locErr) throw new Error(`Location lookup failed: ${locErr.message}`)

  // Contractor profiles assigned to this location with their rates.
  const { data: links, error: linksErr } = await db
    .from('profile_locations')
    .select('profile_id, profiles:profile_id(id, employment_type, hourly_rate, active)')
    .eq('location_id', locationId)
  if (linksErr) throw new Error(`Profile lookup failed: ${linksErr.message}`)

  const contractorRateById = {}
  for (const link of links || []) {
    const p = link.profiles
    if (!p) continue
    if (p.employment_type !== 'contractor') continue
    contractorRateById[p.id] = Number(p.hourly_rate) || 0
  }

  // All blocks in the calendar months the period touches, with
  // their assignments and roster join. We consider the union of
  // (already-published blocks in those months outside the period)
  // PLUS (all blocks in the period — published or not).
  // ROSTER-FIX.4 — the per-coach overrides ride along: a coach whose window
  // a manager adjusted is paid for THAT window, not the block's.
  const monthBlocks = []
  for (let from = 0; ; from += BLOCK_PAGE_SIZE) {
    const { data: page, error: blocksErr } = await db
      .from('shift_blocks')
      .select(`
        id, location_id, block_date, start_time, end_time, roster_id, min_coaches,
        shift_templates(name),
        shift_assignments(profile_id, status, start_time_override, end_time_override, profiles:profile_id(full_name)),
        rosters:roster_id(id, status)
      `)
      .eq('location_id', locationId)
      .gte('block_date', monthStart)
      .lte('block_date', monthEnd)
      .order('block_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + BLOCK_PAGE_SIZE - 1)
    if (blocksErr) throw new Error(`Block lookup failed: ${blocksErr.message}`)
    monthBlocks.push(...(page || []))
    if (!page || page.length < BLOCK_PAGE_SIZE) break
  }

  // COPYLEAVE.1 — everyone with a live shift on these blocks. Used twice
  // below, both times for the advisory lists only: to widen the leave scope to
  // a guest coach so leaveClashes can name them (leave covers the PERSON,
  // LEAVE.2; the money is unaffected, a guest has no rate here), and to look
  // for the same people's shifts at other studios.
  const rosteredIds = advisories
    ? [...new Set(monthBlocks.flatMap((b) => liveAssignments(b.shift_assignments).map((a) => a.profile_id)).filter(Boolean))]
    : []

  // ROSTER-FIX.4 — approved leave for the months, in ONE query. A coach on
  // approved leave is not working the shift they are still rostered on, so
  // billing it inflated the projection and could refuse a publish that was
  // actually within budget.
  // LEAVE.2 — leave covers the person: a coach here who filed leave from
  // another studio is still not working this studio's shifts.
  // ROSTERTIDY.1 — paged like the block read. One month of approved leave
  // never approaches 1,000 rows, but the batch projection loads the whole span
  // a queue of drafts touches, and a silently-truncated leave list would bill
  // coaches who are off.
  const leave = []
  for (let from = 0; ; from += BLOCK_PAGE_SIZE) {
    const { data: page, error: leaveErr } = await db
      .from('time_off_requests')
      .select('id, profile_id, start_date, end_date')
      .or(leaveScopeOrFilter([locationId], [...(links || []).map((l) => l.profile_id), ...rosteredIds]))
      .eq('status', 'approved')
      .lte('start_date', monthEnd)
      .gte('end_date', monthStart)
      .order('start_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + BLOCK_PAGE_SIZE - 1)
    if (leaveErr) throw new Error(`Leave lookup failed: ${leaveErr.message}`)
    leave.push(...(page || []))
    if (!page || page.length < BLOCK_PAGE_SIZE) break
  }

  const leaveByProfile = new Map()
  for (const row of leave) {
    if (!leaveByProfile.has(row.profile_id)) leaveByProfile.set(row.profile_id, [])
    leaveByProfile.get(row.profile_id).push(row)
  }

  // COPYLEAVE.1 — the same coaches' assignments at OTHER studios, for the
  // double-booking advisory. Same shape and paging as readAssignmentsInRange
  // (time-off-leave.js). FAILS SOFT: this function is also the hard budget
  // gate for a real publish, and an advisory must never be able to refuse one.
  // null = "could not check", which impactFromContext reports as
  // crossLocationChecked: false rather than as "no clashes".
  //
  // ONLY this organisation's other studios. Nothing keeps a person inside one
  // organisation, and the advisory prints the other shift's name, times and
  // studio: "not this location" alone would show one tenant another tenant's
  // roster. An organisation has a handful of locations, so this read does not
  // page. No siblings = nothing to check, which is a complete check (the flag
  // stays true and the modal says nothing).
  //
  // A REJECTED read (or a client that throws) degrades exactly like a returned
  // error. The try wraps these two advisory reads ONLY: the budget inputs
  // above keep throwing, as they always have.
  let otherAssignments = []
  try {
    let siblingIds = []
    if (rosteredIds.length > 0) {
      const { data: siblings, error: sibErr } = loc?.organization_id
        ? await db.from('locations').select('id').eq('organization_id', loc.organization_id).neq('id', locationId)
        : { data: null, error: { message: 'location has no organization_id' } }
      if (sibErr) {
        logWarn('roster-publish', 'sibling studios unreadable; double-booking check is this studio only', { locationId, err: sibErr.message })
        otherAssignments = null
      } else {
        siblingIds = (siblings || []).map((l) => l.id).filter(Boolean)
      }
    }
    if (siblingIds.length > 0) {
      for (let from = 0; ; from += BLOCK_PAGE_SIZE) {
        const { data: page, error: otherErr } = await db
          .from('shift_assignments')
          .select('id, profile_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name), locations(name))')
          .in('profile_id', rosteredIds)
          .in('shift_blocks.location_id', siblingIds)
          .gte('shift_blocks.block_date', monthStart)
          .lte('shift_blocks.block_date', monthEnd)
          .order('id', { ascending: true })
          .range(from, from + BLOCK_PAGE_SIZE - 1)
        if (otherErr) {
          logWarn('roster-publish', 'other-studio assignments unreadable; double-booking check is this studio only', { locationId, err: otherErr.message })
          otherAssignments = null
          break
        }
        otherAssignments.push(...(page || []))
        if (!page || page.length < BLOCK_PAGE_SIZE) break
      }
    }
  } catch (e) {
    logWarn('roster-publish', 'other-studio check threw; double-booking check is this studio only', { locationId, err: e?.message })
    otherAssignments = null
  }

  // WORKTIME.1 — every shift, at any studio of this organisation, of the
  // people rostered HERE in the period, from the Sunday before the period's
  // first week to the Monday after its last (a rest gap reaches one day either
  // side; a week total needs the whole Mon-Sun week). ONE reader call per
  // preview, never per block. The reader never throws and reads names and
  // employment type only, never a rate. The try is belt and braces: this
  // function is also the budget gate, and an advisory must never be able to
  // refuse a publish.
  let workingTime = null
  if (advisories) {
    try {
      workingTime = await loadWorkingTimeShifts(db, {
        locationId,
        profileIds: rosteredHereIn(monthBlocks, periodStart, periodEnd),
        from: addDaysISO(mondayOf(periodStart), -1),
        to: addDaysISO(mondayOf(periodEnd), 7),
      })
    } catch (e) {
      logWarn('roster-publish', 'working-time read threw; omitted from the publish preview', { locationId, err: e?.message })
      workingTime = { shifts: [], people: new Map(), crossStudioChecked: false, error: { message: e?.message || 'working-time read threw' } }
    }
  }

  return {
    location: loc,
    monthStart,
    monthEnd,
    contractorRateById,
    leaveByProfile,
    monthBlocks,
    otherAssignments,
    workingTime,
    advisories,
  }
}

// WORKTIME.1 — the people with a live shift at this studio in [from, to].
function rosteredHereIn(blocks, from, to) {
  return [...new Set((blocks || [])
    .filter((b) => b.block_date >= from && b.block_date <= to)
    .flatMap((b) => liveAssignments(b.shift_assignments).map((a) => a.profile_id))
    .filter(Boolean))]
}

/**
 * Is this coach on approved leave on this date? Both ends inclusive —
 * time_off_requests.end_date is documented inclusive (mig 011). Dates are
 * ISO YYYY-MM-DD strings, so string comparison IS date comparison.
 */
function isOnLeave(leaveByProfile, profileId, dateIso) {
  return Boolean(leaveCovering(leaveByProfile, profileId, dateIso))
}

function blockContractorCost(block, contractorRateById, leaveByProfile) {
  let cost = 0
  // ROSTER-FIX.1 — a cancelled assignment costs nothing; counting it here
  // pushed publishes over the contractor budget for shifts nobody works.
  for (const a of liveAssignments(block.shift_assignments)) {
    const rate = contractorRateById[a.profile_id] || 0
    if (rate === 0) continue
    // ROSTER-FIX.4 — a coach on approved leave isn't working this shift.
    if (isOnLeave(leaveByProfile, a.profile_id, block.block_date)) continue
    // ROSTER-FIX.4 — hours are PER ASSIGNMENT: shiftHours prefers the
    // coach's override window and falls back to the block's.
    const hours = shiftHours({
      start_time_override: a.start_time_override,
      end_time_override: a.end_time_override,
      shift_templates: { start_time: block.start_time, end_time: block.end_time },
    })
    cost += hours * rate
  }
  return cost
}

/**
 * Project what the month-total contractor cost will be after
 * publishing (period_start, period_end). Does NOT mutate state.
 *
 * BUDGETAPPROVE.1 — the budget is MONTHLY, so a period that crosses a month
 * boundary is judged per month: each month's total is (that month's published
 * spend outside the period + this period's days in that month) against that
 * month's budget. `months` carries the breakdown. The top-level fields keep
 * their old names for every existing caller:
 *   - periodProjectedEur / alreadyPublishedEur / blockCount are summed over
 *     the months (the whole period's cost, which is what the stored
 *     `projected_contractor_eur` snapshot means);
 *   - overBudget is true when ANY month is over, and overrunEur is the sum of
 *     each month's overrun (a month under budget cannot absorb another's
 *     overspend);
 *   - monthStart / monthEnd / monthProjectedTotalEur / remainingEur describe
 *     the BINDING month — the most over (or least remaining) — so a single
 *     "month total of budget" line still quotes a real month, never a sum of
 *     two months against one month's budget.
 * For a period inside one month all of these are exactly what they were.
 *
 * @returns {{
 *   monthStart, monthEnd,
 *   monthlyBudgetEur: number | null,
 *   alreadyPublishedEur: number,     // outside the period, on a published roster
 *   periodProjectedEur: number,      // about to be published
 *   monthProjectedTotalEur: number,
 *   remainingEur: number | null,
 *   overBudget: boolean,
 *   overrunEur: number,              // 0 if under, positive if over
 *   blockCount: number,              // ROSTERVIS.1 — every block in the period
 *   staffingGaps: Array<{ block_id, block_date, start_time, end_time, name,
 *                         status: 'empty'|'short', count, min }>,
 *   // COPYLEAVE.1 — the next three are present only with `advisories: true`
 *   // (the default here; the batch defaults to false). Callers that never
 *   // show the lists pass false and skip the reads behind them.
 *   leaveClashes: Array<{ block_id, block_date, start_time, end_time, name,
 *                         profile_id, coach_name, leave_start, leave_end }>,
 *   doubleBookings: Array<{ profile_id, coach_name, block_date, first, second }>,
 *   crossLocationChecked: boolean,
 *   // WORKTIME.1 — with `advisories: true` only. Employees, hours only.
 *   workingTime: { restGaps: Array<{ profile_id, coach_name, rest_minutes, before, after }>,
 *                  longWeeks: Array<{ profile_id, coach_name, week_start, minutes, shift_count, studio_count }>,
 *                  checked: boolean },
 *   months: Array<{
 *     monthStart, monthEnd, monthlyBudgetEur, alreadyPublishedEur,
 *     periodProjectedEur, monthProjectedTotalEur, remainingEur,
 *     overBudget, overrunEur, blockCount,
 *   }>,
 * }}
 */
export async function projectPublishImpact(db, { locationId, periodStart, periodEnd, todayIso = dublinTodayStr(), advisories = true }) {
  const ctx = await loadBudgetContext(db, locationId, periodStart, periodEnd, { advisories })
  return impactFromContext(ctx, { periodStart, periodEnd, todayIso })
}

/**
 * ROSTERTIDY.1 — projectPublishImpact for MANY periods, loading each
 * location's data ONCE.
 *
 * The approvals queue (provider + /schedule/approvals) used to call
 * projectPublishImpact per draft — up to 50 drafts, each reloading the
 * location, its contractor rates, every block in every month it touches (paged)
 * and the leave over them. Here the periods are grouped by location, one
 * context is loaded per location covering the SPAN of every month those
 * periods touch (first-of-month of the earliest start → last-of-month of the
 * latest end), and each period is then judged by the SAME pure
 * impactFromContext the single path uses.
 *
 * Why a wider load gives identical figures: impactFromContext only reads
 * blocks whose month is one this period touches (monthByKey), staffingGaps
 * filters to [periodStart, periodEnd], leave is matched per block date, and
 * rates/budget are per location, not per month. Extra rows outside a period's
 * months are therefore never counted — pinned by a test that runs the same
 * draft both ways.
 *
 * The span is contiguous, so drafts months apart load the months between
 * them too. That is bounded (blocks and leave both page) and far cheaper than
 * a load per draft; a queue of 50 is one location in practice.
 *
 * Never throws. A location whose context fails to load fails every period at
 * it; a period that fails to compute fails alone. Callers keep today's
 * "overrun could not be re-checked" fallback on `impact: null`.
 *
 * @param {Array<{ locationId: string, periodStart: string, periodEnd: string }>} periods
 * @param {{ todayIso?: string, advisories?: boolean }} [opts]  COPYLEAVE.1 —
 *   `advisories` defaults to FALSE here: both callers (the approvals provider
 *   and /schedule/approvals) show budget figures only, so the other-studio
 *   read and the advisory lists are skipped unless asked for.
 * @returns {Promise<Array<{ impact: object|null, error: Error|null }>>} same order as `periods`
 */
export async function projectPublishImpactBatch(db, periods, { todayIso = dublinTodayStr(), advisories = false } = {}) {
  const list = periods || []
  const results = list.map(() => ({ impact: null, error: null }))

  const byLocation = new Map()
  list.forEach((p, i) => {
    if (!p?.locationId || !p?.periodStart || !p?.periodEnd) {
      results[i].error = new Error('period is missing locationId, periodStart or periodEnd')
      return
    }
    if (!byLocation.has(p.locationId)) byLocation.set(p.locationId, [])
    byLocation.get(p.locationId).push(i)
  })

  await Promise.all([...byLocation.entries()].map(async ([locationId, idxs]) => {
    let spanStart = null
    let spanEnd = null
    for (const i of idxs) {
      const { periodStart, periodEnd } = list[i]
      const end = periodEnd > periodStart ? periodEnd : periodStart
      if (spanStart == null || periodStart < spanStart) spanStart = periodStart
      if (spanEnd == null || end > spanEnd) spanEnd = end
    }

    let ctx
    try {
      ctx = await loadBudgetContext(db, locationId, spanStart, spanEnd, { advisories })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      for (const i of idxs) results[i].error = err
      return
    }

    for (const i of idxs) {
      try {
        results[i].impact = impactFromContext(ctx, {
          periodStart: list[i].periodStart,
          periodEnd: list[i].periodEnd,
          todayIso,
        })
      } catch (e) {
        results[i].error = e instanceof Error ? e : new Error(String(e))
      }
    }
  }))

  return results
}

/**
 * WORKTIME.1 — the preview's working-time list from the reader's answer.
 * Only the people rostered here in THIS period are listed: the batch reads
 * once for a span of drafts, and a draft must not list another draft's people.
 * `checked: false` when the read failed, could not see the other studios, or
 * the pure helper threw: an empty list is then "not checked", never "clear".
 */
function workingTimeList(wt, { locationId, monthBlocks, periodStart, periodEnd, todayIso }) {
  const unchecked = { restGaps: [], longWeeks: [], checked: false }
  if (!wt || wt.error) return unchecked
  try {
    const here = new Set(rosteredHereIn(monthBlocks, periodStart, periodEnd))
    const { restGaps, longWeeks } = workingTimeAdvisories(
      (wt.shifts || []).filter((s) => here.has(s.profile_id)),
      { people: wt.people, hereLocationId: locationId, from: periodStart, to: periodEnd, todayIso },
    )
    return { restGaps, longWeeks, checked: wt.crossStudioChecked !== false }
  } catch (e) {
    logWarn('roster-publish', 'working-time advisory threw; omitted from the publish preview', { locationId, err: e?.message })
    return unchecked
  }
}

/**
 * The pure half of projectPublishImpact: judge one period against an already
 * loaded context. Shared by the single and batch paths so they cannot disagree.
 * `ctx.monthBlocks` may cover MORE months than the period touches (the batch
 * loads a span); everything below filters to the period's own months.
 */
function impactFromContext(ctx, { periodStart, periodEnd, todayIso }) {
  const { location, contractorRateById, leaveByProfile, monthBlocks, otherAssignments, workingTime, advisories = true } = ctx

  const budget = location?.monthly_contractor_budget_eur != null
    ? Number(location.monthly_contractor_budget_eur)
    : null

  const months = monthsTouched(periodStart, periodEnd).map((m) => ({
    ...m, alreadyPublishedEur: 0, periodProjectedEur: 0, blockCount: 0,
  }))
  const monthByKey = new Map(months.map((m) => [m.monthStart.slice(0, 7), m]))

  for (const b of monthBlocks) {
    const month = monthByKey.get(String(b.block_date).slice(0, 7))
    if (!month) continue
    const inPeriod = b.block_date >= periodStart && b.block_date <= periodEnd
    // ROSTERVIS.1 — "Blocks in period" counts every block in the period. It
    // used to count only blocks carrying contractor cost, so a week staffed by
    // FTEs (or not staffed at all) read as having almost no shifts.
    if (inPeriod) month.blockCount++
    const cost = blockContractorCost(b, contractorRateById, leaveByProfile)
    if (cost === 0) continue
    if (inPeriod) {
      month.periodProjectedEur += cost
    } else {
      // Only count if currently on a PUBLISHED roster — drafts
      // don't consume budget until they're published.
      if (b.rosters?.status === 'published') {
        month.alreadyPublishedEur += cost
      }
    }
  }

  const perMonth = months.map((m) => {
    const monthProjectedTotalEur = round2(m.alreadyPublishedEur + m.periodProjectedEur)
    const remainingEur = budget != null ? round2(budget - monthProjectedTotalEur) : null
    const overBudget = budget != null && monthProjectedTotalEur > budget
    return {
      monthStart: m.monthStart,
      monthEnd: m.monthEnd,
      monthlyBudgetEur: budget,
      alreadyPublishedEur: round2(m.alreadyPublishedEur),
      periodProjectedEur: round2(m.periodProjectedEur),
      monthProjectedTotalEur,
      remainingEur,
      overBudget,
      overrunEur: overBudget ? round2(monthProjectedTotalEur - budget) : 0,
      blockCount: m.blockCount,
    }
  })

  // The binding month: largest overrun, then largest total (one budget
  // figure serves every month, so that is also least remaining, and it still
  // picks a real month when no budget is set). Ties keep the earlier month.
  const binding = perMonth.reduce((best, m) => {
    if (m.overrunEur !== best.overrunEur) return m.overrunEur > best.overrunEur ? m : best
    if (m.monthProjectedTotalEur !== best.monthProjectedTotalEur) {
      return m.monthProjectedTotalEur > best.monthProjectedTotalEur ? m : best
    }
    return best
  })

  // ROSTERVIS.1 — the shifts in this period that are empty or below their
  // minimum, for the publish preview. Information only: nothing here gates a
  // publish. Future blocks only, the same rule the calendar applies.
  const staffingGapsInPeriod = staffingGaps(monthBlocks, { from: periodStart, to: periodEnd, todayIso })
    .map(({ block, status, count, min }) => ({
      block_id: block.id,
      block_date: block.block_date,
      start_time: block.start_time,
      end_time: block.end_time,
      name: block.shift_templates?.name || 'Shift',
      status,
      count,
      min,
    }))

  // COPYLEAVE.1 — advisory, like staffingGaps: nothing here gates a publish.
  // Absent altogether (not empty) when the caller asked for no advisories, so
  // "not computed" can never read as "all clear".
  let advisoryLists = {}
  if (advisories) {
    // A bug in a pure advisory helper must not refuse a publish either: that
    // list comes back empty and the check is flagged incomplete.
    let complete = otherAssignments !== null
    const soft = (name, fn) => {
      try { return fn() } catch (e) {
        logWarn('roster-publish', `${name} advisory threw; omitted from the publish preview`, { locationId: location?.id, err: e?.message })
        complete = false
        return []
      }
    }
    advisoryLists = {
      leaveClashes: soft('leaveClashes', () => leaveClashes(monthBlocks, { from: periodStart, to: periodEnd, todayIso, leaveByProfile })),
      doubleBookings: soft('doubleBookings', () => doubleBookings(monthBlocks, otherAssignments, { from: periodStart, to: periodEnd, todayIso })),
    }
    // false = the other-studio read failed (or a helper threw), so the lists
    // are not a full check. The modal says so instead of implying an all-clear.
    advisoryLists.crossLocationChecked = complete
    // WORKTIME.1 — employees' rest and weekly hours, both studios. Its own
    // `checked`: a working-time read that failed is not a clash check that
    // failed, and neither may read as an all-clear.
    advisoryLists.workingTime = workingTimeList(workingTime, { locationId: location?.id, monthBlocks, periodStart, periodEnd, todayIso })
  }

  return {
    monthStart: binding.monthStart,
    monthEnd: binding.monthEnd,
    monthlyBudgetEur: budget,
    alreadyPublishedEur: round2(perMonth.reduce((s, m) => s + m.alreadyPublishedEur, 0)),
    periodProjectedEur: round2(perMonth.reduce((s, m) => s + m.periodProjectedEur, 0)),
    monthProjectedTotalEur: binding.monthProjectedTotalEur,
    remainingEur: binding.remainingEur,
    overBudget: perMonth.some((m) => m.overBudget),
    overrunEur: round2(perMonth.reduce((s, m) => s + m.overrunEur, 0)),
    blockCount: perMonth.reduce((s, m) => s + m.blockCount, 0),
    months: perMonth,
    staffingGaps: staffingGapsInPeriod,
    ...advisoryLists,
  }
}

/**
 * BUDGETAPPROVE.1 — has the projection moved since a roster row snapshotted
 * it? Compares the two figures the row stores (`projected_contractor_eur`,
 * the whole period's cost; `budget_at_publish_eur`, the monthly budget) to
 * the cent, treating null as its own value — a budget set or cleared since
 * the draft was submitted is a change the approver should hear about.
 */
export function projectionChanged(roster, impact) {
  if (!roster || !impact) return false
  const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100))
  return cents(roster.projected_contractor_eur) !== cents(impact.periodProjectedEur)
    || cents(roster.budget_at_publish_eur) !== cents(impact.monthlyBudgetEur)
}

/**
 * ROSTER-FIX.4 — the published rosters at `locationId` that (periodStart,
 * periodEnd) would collide with.
 *
 * WHY: publishing rewrites `shift_blocks.roster_id` for every block in the
 * period, so a second overlapping published roster silently STEALS the days
 * it shares — the older row still claims those dates while owning none of
 * their blocks, and "which roster published this day" (reports,
 * findPublishedRosterFor, the approvals queue) stops having one answer.
 *
 * A published roster is NOT a conflict when the new period fully contains
 * it, which covers both legitimate overlaps:
 *   - the EXACT same period — how a re-publish re-notifies the coaches whose
 *     shifts changed since last time;
 *   - a period that CONTAINS the published one — the documented "publish the
 *     week, then publish the whole month" flow, where the wider roster takes
 *     over every block including the earlier week's.
 *
 * ROSTER-SUPERSEDE.1 — those two shapes are no longer merely tolerated, they
 * are RESOLVED: releasePublishedRostersFor() supersedes the contained rosters
 * before the insert and supersedeSwallowedRosters() stamps the successor
 * after the re-tag, so the swallowed row stops claiming days it owns no
 * blocks on and mig 602's exclusion constraint is satisfied. The old row is
 * kept, not deleted — it is the audit trail of a real publish event.
 *
 * ROSTER-TRIM.1 — a ONE-SIDED STRADDLE is now resolved too, by TRIMMING.
 * "Publish the boundary week, then publish the month" used to 409: the week
 * of Mon 31 Aug runs into September, so publishing September met a roster
 * starting one day before the period and was refused — and the refusal said
 * "re-publish that range instead", which publishes the WEEK, never the month
 * the operator asked for. There was no sequence of clicks that got them there.
 *
 * Trimming is the containment case one notch gentler: the straddler keeps the
 * days OUTSIDE the new period (and every block on them) and gives up exactly
 * the days the new roster is taking over — which is what supersedeSwallowed-
 * Rosters' phase-2 sweep already does to any roster left owning fewer days
 * than it claims. `requested_period_*` is never rewritten, so the original ask
 * survives.
 *
 * A TWO-SIDED straddle — a published roster that runs past BOTH ends of the
 * new period — still 409s. Trimming it would have to SPLIT it into two ranges,
 * which the row cannot express, and mig 602 would reject the insert anyway.
 * The refusal now carries `suggested_period`: the smallest period that covers
 * both, which is a publish that genuinely resolves it.
 *
 * Both period bounds are inclusive, and dates are ISO YYYY-MM-DD strings, so
 * string comparison IS date comparison.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, periodStart: string, periodEnd: string, excludeRosterId?: string|null }} opts
 * @returns {Promise<{
 *   conflicts: Array<{id: string, period_start: string, period_end: string}>,
 *   trimmable: Array<{id: string, period_start: string, period_end: string, trim_to: {period_start: string, period_end: string}}>,
 *   overlapping: Array<{id: string, period_start: string, period_end: string}>,
 *   error: any,
 * }>}
 */
export async function findConflictingPublishedRosters(db, { locationId, periodStart, periodEnd, excludeRosterId = null } = {}) {
  let query = db
    .from('rosters')
    .select('id, period_start, period_end')
    .eq('location_id', locationId)
    .eq('status', 'published')
    // Inclusive-range overlap: starts on or before our end AND ends on or
    // after our start.
    .lte('period_start', periodEnd)
    .gte('period_end', periodStart)
  // The approve path re-checks a roster that already exists as a row; it must
  // not count itself as the thing it collides with.
  if (excludeRosterId) query = query.neq('id', excludeRosterId)

  const { data, error } = await query
  if (error) return { conflicts: [], trimmable: [], overlapping: [], error }

  const overlapping = data || []
  const conflicts = []
  const trimmable = []
  for (const r of overlapping) {
    const verdict = classifyPublishedOverlap(r, periodStart, periodEnd)
    if (verdict.kind === 'contained') continue
    if (verdict.kind === 'trim') {
      trimmable.push({ ...r, trim_to: verdict.trim_to })
      continue
    }
    conflicts.push(r)
  }
  return { conflicts, trimmable, overlapping, error: null }
}

/**
 * ROSTER-TRIM.1 — how a single published roster relates to a publish period.
 *
 *   'contained'  — fully inside it (an exact re-publish falls out here too).
 *                  Resolved by superseding; never a conflict.
 *   'trim'       — runs past ONE end of it. Resolved by shrinking the roster
 *                  back to the days outside the period; `trim_to` is the
 *                  period it keeps.
 *   'engulfing'  — runs past BOTH ends. A trim would have to split the row in
 *                  two, so this is the one shape that still refuses.
 *
 * Pure and string-only, so it is safe in a client bundle and cannot drift
 * with the process timezone.
 *
 * @param {{period_start: string, period_end: string}} roster
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {{kind: 'contained'} | {kind: 'engulfing'} | {kind: 'trim', trim_to: {period_start: string, period_end: string}}}
 */
export function classifyPublishedOverlap(roster, periodStart, periodEnd) {
  const s = roster.period_start
  const e = roster.period_end
  if (s >= periodStart && e <= periodEnd) return { kind: 'contained' }
  if (s < periodStart && e > periodEnd) return { kind: 'engulfing' }
  if (s < periodStart) {
    return { kind: 'trim', trim_to: { period_start: s, period_end: isoShiftDays(periodStart, -1) } }
  }
  return { kind: 'trim', trim_to: { period_start: isoShiftDays(periodEnd, 1), period_end: e } }
}

/**
 * ROSTER-TRIM.1 — the smallest period that covers the publish the operator
 * asked for AND every roster that refused it. Publishing THAT is the one
 * action that actually resolves an engulfing overlap, so the 409 names it
 * instead of telling the operator to publish something narrower than what
 * they wanted.
 *
 * @returns {{start: string, end: string}}
 */
export function suggestedCoveringPeriod(conflicts, periodStart, periodEnd) {
  let start = periodStart
  let end = periodEnd
  for (const r of conflicts || []) {
    if (r?.period_start && r.period_start < start) start = r.period_start
    if (r?.period_end && r.period_end > end) end = r.period_end
  }
  return { start, end }
}

/**
 * ROSTER-TRIM.1 — do these (inclusive) ranges between them cover every day of
 * [periodStart, periodEnd]? Used to decide whether a period is ALREADY live to
 * staff, which is what the over-budget approval email's wording turns on.
 *
 * @param {Array<{period_start: string, period_end: string}>} ranges
 */
export function coversPeriod(ranges, periodStart, periodEnd) {
  const sorted = (ranges || [])
    .filter((r) => r?.period_start && r?.period_end && r.period_end >= periodStart && r.period_start <= periodEnd)
    .sort((a, b) => (a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0))
  let reached = periodStart
  for (const r of sorted) {
    if (r.period_start > reached) return false
    if (r.period_end >= reached) reached = isoShiftDays(r.period_end, 1)
    if (reached > periodEnd) return true
  }
  return reached > periodEnd
}

/**
 * ROSTER-TRIM.1 — shrink each straddling published roster back to the days it
 * keeps, BEFORE the new roster is inserted. Mig 602's exclusion constraint
 * judges the INSERT, so this has to run first for exactly the reason
 * releasePublishedRostersFor does.
 *
 * All-or-nothing, same as the release: a half-applied set still trips the
 * constraint, so a failure part-way puts back what it already moved and
 * reports the failure rather than leaving the caller to insert into it.
 *
 * `requested_period_*` is deliberately untouched — it is the record of what
 * the operator originally asked to publish, and a later trim is not a change
 * to that ask.
 *
 * ROSTERTIDY.1 — the residue #1716 accepted here is now PARTLY settled,
 * after the publish, by supersedeEmptyTrimmedRosters(). A trimmed remnant that
 * ends up owning NO blocks (every block it had was inside the period this
 * publish took) stays published over dates it owns nothing on, and the
 * phase-2 sweep can never see it: after the trim it no longer overlaps the new
 * period.
 *
 * It is NOT harmless in general, and it is not always wrong either: a
 * published roster's period is what findPublishedRosterFor /
 * findPublishedRosterIdsByDate (src/lib/roster.js) use to adopt a NEW block —
 * one added by hand (/api/schedule/blocks) or by generation
 * (roster-write.js). While a remnant covers a day, a block created there joins
 * it and reads PUBLISHED at once; supersede the remnant and that block has no
 * roster and reads unpublished until someone publishes again. So:
 *   - a remnant whose trimmed period ENDED before today (Dublin) can never
 *     adopt a block anyone will work, and is superseded;
 *   - a remnant reaching today or later is KEPT on purpose, empty, because
 *     its period still does real work for blocks added on those days.
 * FINALTIDY.1 — the same rule now settles the PARTLY empty remnant too: a past
 * remnant that still owns blocks, but on fewer days than its trimmed period
 * covers, is shrunk to the first/last day it owns a block on (the phase-2
 * sweep's min/max shrink, via the same ownedBlockRange). Its empty days are in
 * the past, so no block will ever be created there to need them.
 * #1716's two objections are answered in the helper: the "owns nothing" rule
 * is the same live recount the sweep uses, taken after the re-tag (before it,
 * the remnant still owns the blocks this publish takes); and the cost is at
 * most two count queries (one straddler per end), only on a publish that
 * trimmed, and none at all for a future remnant.
 * The row is superseded, never deleted, so the audit trail of the publish
 * that created it survives exactly as the sweep's own supersede keeps it.
 *
 * @param {Array<{id: string, period_start: string, period_end: string, trim_to: {period_start: string, period_end: string}}>} trims
 * @returns {Promise<{ trimmed: Array<{id: string, period_start: string, period_end: string, trim_to: object}>, error: any }>}
 */
export async function trimPublishedRosters(db, trims) {
  const targets = (trims || []).filter((t) => t?.id && t?.trim_to?.period_start && t?.trim_to?.period_end)
  if (targets.length === 0) return { trimmed: [], error: null }

  const trimmed = []

  // ONE way out of this function for every failure, so no path can forget the
  // restore. The restore is itself a write and can itself fail — or throw —
  // and a roster left trimmed for a publish that never happens owns blocks
  // outside its own period, so the ids are NAMED when that happens: putting
  // them back is then a human job.
  async function abort(err) {
    let restoreErr = null
    try {
      ;({ error: restoreErr } = await restoreRosterPeriods(db, trimmed))
    } catch (e) {
      restoreErr = e instanceof Error ? e : new Error(String(e))
    }
    if (restoreErr) {
      return { trimmed: [], error: withRestoreFailure(err, restoreErr, trimmed.map((x) => x.id)) }
    }
    return { trimmed: [], error: err }
  }

  // 🔴 THE LOOP IS WRAPPED because a THROWN error never produces an error
  // object: a PostgREST 5xx, a dropped fetch or the function timing out skips
  // every `updErr` branch below, and the caller's own catch sees the EMPTY
  // `trimmed` it was handed before the call — so the rosters already trimmed
  // would stay trimmed forever. It is reachable on the headline case, a month
  // whose boundary weeks are BOTH published: the first trim lands, the second
  // throws.
  try {
    for (const t of targets) {
      // COMPARE-AND-SWAP. The classification was made from a read taken before
      // the budget projection, so another publish can have moved this row in
      // between. Pinning the period we read means a raced row is simply not
      // written — and because a zero-row UPDATE is NOT an error in PostgREST
      // (CLAUDE.md), the rows touched are judged explicitly: proceeding on a
      // silent no-op would walk straight into mig 602's 23P01 on the insert.
      const { data: touched, error: updErr } = await db
        .from('rosters')
        .update({ period_start: t.trim_to.period_start, period_end: t.trim_to.period_end })
        .eq('id', t.id)
        .eq('status', 'published')
        .eq('period_start', t.period_start)
        .eq('period_end', t.period_end)
        .select('id')
      if (updErr) return await abort(updErr)
      if ((touched || []).length === 0) {
        return await abort(new Error(`roster ${t.id} changed since it was read, so it was not trimmed`))
      }
      trimmed.push(t)
    }
  } catch (e) {
    return await abort(e instanceof Error ? e : new Error(String(e)))
  }
  return { trimmed, error: null }
}

/**
 * ROSTERTIDY.1 — after a publish that TRIMMED straddling rosters, settle every
 * trimmed remnant that is in the PAST. See trimPublishedRosters' header for
 * the full trade-off. One live recount (ownedBlockRange) decides:
 *   - owns ZERO blocks → superseded (ROSTERTIDY.1);
 *   - owns blocks on FEWER days than its trimmed period → shrunk to the
 *     first/last block_date it owns (FINALTIDY.1), the phase-2 sweep's min/max
 *     shrink; `requested_period_*` untouched;
 *   - its blocks span the whole trimmed period → left alone (`kept`).
 * A block dated OUTSIDE the trimmed period is left alone with a warning: the
 * range would widen, not shrink, and that is the c2 state mig 602 forbids.
 *
 * 🔴 PAST ONLY. A remnant whose trimmed `period_end` is today or later (Dublin,
 * dublinTodayStr) is kept without even a recount: its period is how a block
 * added on those days later finds its published roster
 * (findPublishedRosterFor / findPublishedRosterIdsByDate), so superseding it
 * would make such a block read unpublished where today it is published at
 * once. It is reported in `future` for the caller to log.
 *
 * 🔴 ORDER: call only once the new roster is inserted AND its blocks are
 * tagged. Before the re-tag the remnant still owns the blocks the publish is
 * taking, so the recount would keep it; the route calls this straight after
 * supersedeSwallowedRosters, which has the same precondition.
 *
 * 🔴 A shrink can never trip mig 602's exclusion constraint: the new period is
 * a SUBSET of the trimmed one (enforced below, not assumed), and the trimmed
 * period already overlaps no other published roster at this studio, so no
 * subset of it can.
 *
 * Same mechanism as the sweep's zero-block supersede: status `superseded`,
 * `superseded_by` the new roster, `superseded_at` now (both from mig 602), and
 * `requested_period_*` untouched. The write is compare-and-swap on the
 * TRIMMED period and on `published`, so a remnant another publish has since
 * reshaped is left alone, and the rows touched are judged explicitly because
 * a zero-row UPDATE is not an error.
 *
 * Best-effort and never throws: a past remnant left published over empty days
 * is only a tidiness cost (it overlaps no published roster, so mig 602 is
 * satisfied, and no block will ever be created on a past day to join it), so nothing
 * here may fail a publish that already happened. Every problem comes back in
 * `warning` for the caller to logWarn.
 *
 * @param {{ newRosterId: string, trimmed: Array<{id: string, trim_to: {period_start: string, period_end: string}}>, todayIso?: string }} opts
 * @returns {Promise<{ superseded: string[], shrunk: Array<{id: string, period_start: string, period_end: string}>, kept: string[], future: string[], warning: string|null }>}
 */
export async function supersedeEmptyTrimmedRosters(db, { newRosterId, trimmed = [], todayIso = dublinTodayStr() } = {}) {
  const superseded = []
  const shrunk = []
  const kept = []
  const future = []
  const warnings = []
  const targets = (trimmed || []).filter((t) => t?.id && t.id !== newRosterId && t?.trim_to?.period_start && t?.trim_to?.period_end)
  if (targets.length === 0) return { superseded, shrunk, kept, future, warning: null }
  if (!newRosterId) return { superseded, shrunk, kept, future, warning: 'trimmed-remnant check skipped: no newRosterId' }

  const nowIso = new Date().toISOString()
  for (const t of targets) {
    // Dates are ISO YYYY-MM-DD strings, so string comparison IS date order.
    if (t.trim_to.period_end >= todayIso) {
      future.push(t.id)
      continue
    }
    try {
      // Recount-then-supersede is not atomic: a block tagged to this roster
      // in between would be orphaned. Same accepted race as the phase-2 sweep.
      const { count, first, last, error: ownErr } = await ownedBlockRange(db, t.id)
      if (ownErr) {
        // Reading a failed count as "owns nothing" would supersede a live
        // roster and unpublish its blocks. Leave it alone and say so.
        warnings.push(`block recount failed for trimmed roster ${t.id}: ${ownErr.message}`)
        continue
      }
      if (count > 0) {
        const { period_start: trimStart, period_end: trimEnd } = t.trim_to
        if (!first || !last) {
          warnings.push(`block range unreadable for trimmed roster ${t.id}, so it was not shrunk`)
          continue
        }
        if (first < trimStart || last > trimEnd) {
          // Owns a block outside its own trimmed period: min/max would WIDEN
          // it, possibly back over the period this publish just took.
          warnings.push(`trimmed roster ${t.id} owns blocks ${first}..${last} outside its period ${trimStart}..${trimEnd}, so it was not shrunk`)
          continue
        }
        if (first === trimStart && last === trimEnd) {
          kept.push(t.id)
          continue
        }
        // FINALTIDY.1 — shrink to the days it owns. first..last is inside
        // trimStart..trimEnd (checked above), so this can only narrow a period
        // that already clears mig 602. Compare-and-swap on the TRIMMED period
        // and `published`; requested_period_* is never rewritten.
        const { data: touched, error: shrinkErr } = await db
          .from('rosters')
          .update({ period_start: first, period_end: last })
          .eq('id', t.id)
          .eq('status', 'published')
          .eq('period_start', trimStart)
          .eq('period_end', trimEnd)
          .select('id')
        if (shrinkErr) {
          warnings.push(`period shrink failed for trimmed roster ${t.id}: ${shrinkErr.message}`)
        } else if ((touched || []).length === 0) {
          warnings.push(`trimmed roster ${t.id} changed since the trim, so it was not shrunk`)
        } else {
          shrunk.push({ id: t.id, period_start: first, period_end: last })
        }
        continue
      }
      const { data: touched, error: supErr } = await db
        .from('rosters')
        .update({ status: 'superseded', superseded_at: nowIso, superseded_by: newRosterId })
        .eq('id', t.id)
        .eq('status', 'published')
        .eq('period_start', t.trim_to.period_start)
        .eq('period_end', t.trim_to.period_end)
        .select('id')
      if (supErr) {
        warnings.push(`supersede failed for trimmed roster ${t.id}: ${supErr.message}`)
      } else if ((touched || []).length === 0) {
        warnings.push(`trimmed roster ${t.id} changed since the trim, so it was not superseded`)
      } else {
        superseded.push(t.id)
      }
    } catch (e) {
      warnings.push(`trimmed-remnant check threw for roster ${t.id}: ${e?.message || e}`)
    }
  }
  return { superseded, shrunk, kept, future, warning: warnings.length > 0 ? warnings.join('; ') : null }
}

/**
 * ROSTER-TRIM.1 — what to tell the operator when a publish wrote its roster
 * row but the block re-tag then failed.
 *
 * The two aftermaths are NOT the same thing and the first cut described them
 * with one sentence, which made it false for half of them:
 *
 *   - a STOOD-DOWN (superseded) roster is no longer published, so every block
 *     still hanging off it reads as UNPUBLISHED to its coach. That is the
 *     urgent one.
 *   - a TRIMMED roster is still published and its blocks still read published,
 *     so nobody has lost sight of a shift. What is wrong is narrower: its
 *     period no longer covers the days it still owns blocks on, which is the
 *     state mig 602's pre-apply check (c2) requires to be empty, and phase 2's
 *     min/max shrink would later widen that period back over the days this
 *     publish was taking. Re-publishing the period settles it.
 *
 * Returns a LEADING-SPACE string to append to an existing sentence, or '' when
 * there is nothing to say.
 *
 * @param {{ releasedCount?: number, trimmedCount?: number }} counts
 * @returns {string}
 */
export function publishAftermathNote({ releasedCount = 0, trimmedCount = 0 } = {}) {
  const parts = []
  if (releasedCount > 0) {
    const noun = releasedCount === 1 ? 'roster it replaces has' : 'rosters it replaces have'
    parts.push(`The ${noun} already been stood down, so those shifts read as unpublished until you publish this period again.`)
  }
  if (trimmedCount > 0) {
    const subject = trimmedCount === 1
      ? 'One overlapping roster was trimmed back'
      : `${trimmedCount} overlapping rosters were trimmed back`
    parts.push(`${subject} to the days outside this period. Those shifts are still published, but that roster's dates no longer match the shifts it owns, so publish this period again to settle it.`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/**
 * Undo trimPublishedRosters() when the publish it cleared the way for never
 * happened. Safe on an empty list.
 *
 * @returns {Promise<{ error: any }>}
 */
export async function restoreRosterPeriods(db, trims) {
  const targets = (trims || []).filter((t) => t?.id && t?.period_start && t?.period_end)
  if (targets.length === 0) return { error: null }
  for (const t of targets) {
    const { data: touched, error } = await db
      .from('rosters')
      .update({ period_start: t.period_start, period_end: t.period_end })
      .eq('id', t.id)
      .eq('status', 'published')
      .select('id')
    if (error) return { error }
    // A zero-row restore is a roster left holding days it does not own, and
    // silence there is exactly what the caller needs to log by name.
    if ((touched || []).length === 0) {
      return { error: new Error(`roster ${t.id} could not be put back to ${t.period_start}..${t.period_end}`) }
    }
  }
  return { error: null }
}

function round2(n) { return Math.round(n * 100) / 100 }

// ─────────────────────────────────────────────────────────────────────────
// ROSTER-SUPERSEDE.1 — a publish supersedes the rosters it swallows.
//
// THE MODEL (verified against prod 2026-09-09, mig 602's header carries the
// numbers): publishing INSERTs a `rosters` row and re-tags every
// `shift_blocks.roster_id` in the period. Ownership is therefore PER BLOCK,
// and a roster's period is the request that produced it, not a claim on those
// days. Mig 602 makes that a rule — an exclusion constraint forbidding two
// PUBLISHED rosters over one day at one location — so the app has to resolve
// the swallowing itself instead of leaving a row claiming days it owns
// nothing on.
//
// 🔴 ORDERING. The constraint judges the INSERT (and the draft→published
// UPDATE), which happens BEFORE any block can be re-tagged to the new roster.
// So "supersede afterwards" alone cannot work: an exact re-publish — the
// commonest flow there is — would meet a raw 23P01 before the supersede ever
// ran. The sequence is therefore two-phase:
//
//   1. releasePublishedRostersFor()  — before the insert. Every published
//      roster this period fully CONTAINS is marked superseded (successor not
//      yet known). Containment is exactly the set findConflictingPublished-
//      Rosters lets through, so after this nothing published overlaps and the
//      insert satisfies the constraint. A straddle never reaches here: it is
//      still a 409.
//   2. supersedeSwallowedRosters()   — after the re-tag. Stamps
//      `superseded_by` on the rows phase 1 released, then sweeps any OTHER
//      still-published overlapping roster: zero blocks left → supersede,
//      blocks left → shrink its period to what it owns.
//
// Phase 2's sweep is unreachable on a box where 602 is applied and both
// publish paths run phase 1 — which is the point of keeping it: it is what
// makes the invariant self-healing on data that predates the constraint, and
// on any publish path added later that forgets phase 1.
//
// If the insert fails after phase 1, restorePublishedRosters() puts the
// released rows back — a roster superseded with no successor owns blocks that
// would read as UNPUBLISHED to every coach.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Mark every PUBLISHED roster at `locationId` whose period is fully contained
 * in [periodStart, periodEnd] as superseded, so the about-to-be-inserted
 * roster does not trip mig 602's exclusion constraint.
 *
 * `superseded_by` is deliberately left NULL here — the successor row does not
 * exist yet. supersedeSwallowedRosters() stamps it once it does.
 *
 * All-or-nothing: a write that fails part-way restores what it already
 * released, because a half-released set both still trips the constraint AND
 * leaves live blocks hanging off a superseded roster.
 *
 * @returns {Promise<{ released: Array<{id: string, period_start: string, period_end: string}>, error: any }>}
 */
export async function releasePublishedRostersFor(db, { locationId, periodStart, periodEnd, excludeRosterId = null } = {}) {
  let query = db
    .from('rosters')
    .select('id, period_start, period_end')
    .eq('location_id', locationId)
    .eq('status', 'published')
    // Containment, not overlap: starts on or after our start AND ends on or
    // before our end. Inclusive both ends, so an EXACT re-publish is caught.
    .gte('period_start', periodStart)
    .lte('period_end', periodEnd)
  if (excludeRosterId) query = query.neq('id', excludeRosterId)

  const { data, error } = await query
  // A failed probe must never read as "nothing to release" — the insert would
  // then meet the constraint head-on.
  if (error) return { released: [], error }

  const targets = (data || []).filter((r) => r.id !== excludeRosterId)
  if (targets.length === 0) return { released: [], error: null }

  const nowIso = new Date().toISOString()
  const released = []
  for (const r of targets) {
    const { error: updErr } = await db
      .from('rosters')
      .update({ status: 'superseded', superseded_at: nowIso, superseded_by: null })
      .eq('id', r.id)
      .eq('status', 'published')
    if (updErr) {
      // ROSTER-SUPERSEDE.1 — the restore is itself a write and can itself
      // fail: legitimately with a 23P01 when another publish has taken this
      // range in the meantime, or from whatever broke the write above.
      // Discarding that error (repo rule: no discarded write errors) would
      // leave rosters stood down with nobody told, so it is folded into the
      // error the caller reports, and it NAMES the stranded ids because
      // putting those rows back is then a human job.
      const { error: restoreErr } = await restorePublishedRosters(db, released)
      if (restoreErr) {
        return { released: [], error: withRestoreFailure(updErr, restoreErr, released.map((x) => x.id)) }
      }
      return { released: [], error: updErr }
    }
    released.push(r)
  }
  return { released, error: null }
}

/**
 * ROSTER-SUPERSEDE.1 — fold a failed restore into the error the caller will
 * report, keeping any PostgREST code/details the original carried (a
 * PostgrestError extends Error, so a bare spread would drop them).
 */
function withRestoreFailure(err, restoreErr, strandedIds) {
  const ids = strandedIds.length > 0 ? strandedIds.join(', ') : 'none recorded'
  const message = `${err?.message || err}; the rosters already stood down could not be restored (${restoreErr.message}). Still superseded, and only a human can put them back: ${ids}`
  if (err instanceof Error) {
    const merged = new Error(message)
    if (err.code) merged.code = err.code
    if (err.details) merged.details = err.details
    if (err.hint) merged.hint = err.hint
    return merged
  }
  return { ...err, message }
}

/**
 * Undo releasePublishedRostersFor() when the publish it was clearing the way
 * for never happened. Safe on an empty list.
 *
 * @returns {Promise<{ error: any }>}
 */
export async function restorePublishedRosters(db, rosters) {
  const ids = (rosters || []).map((r) => r?.id).filter(Boolean)
  if (ids.length === 0) return { error: null }
  const { error } = await db
    .from('rosters')
    .update({ status: 'published', superseded_at: null, superseded_by: null })
    .in('id', ids)
  return { error: error || null }
}

/**
 * How many blocks a roster owns right now: the live recount behind every
 * "owns nothing → supersede" decision (the phase-2 sweep and, since
 * ROSTERTIDY.1, the trimmed-remnant check). Count-only, so no row cap applies.
 *
 * @returns {Promise<{ count: number, error: any }>}
 */
async function ownedBlockCount(db, rosterId) {
  const { count, error } = await db
    .from('shift_blocks')
    .select('id', { count: 'exact', head: true })
    .eq('roster_id', rosterId)
  if (error) return { count: 0, error }
  return { count: count || 0, error: null }
}

/**
 * The blocks a roster still owns: how many, and the first/last date. Three
 * cheap queries rather than one `select('block_date')` because the 1,000-row
 * select cap would silently truncate min/max on a long period (CLAUDE.md).
 *
 * @returns {Promise<{ count: number, first: string|null, last: string|null, error: any }>}
 */
async function ownedBlockRange(db, rosterId) {
  const { count, error: countErr } = await ownedBlockCount(db, rosterId)
  if (countErr) return { count: 0, first: null, last: null, error: countErr }
  if (!count) return { count: 0, first: null, last: null, error: null }

  const { data: firstRow, error: firstErr } = await db
    .from('shift_blocks')
    .select('block_date')
    .eq('roster_id', rosterId)
    .order('block_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (firstErr) return { count, first: null, last: null, error: firstErr }

  const { data: lastRow, error: lastErr } = await db
    .from('shift_blocks')
    .select('block_date')
    .eq('roster_id', rosterId)
    .order('block_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastErr) return { count, first: null, last: null, error: lastErr }

  return { count, first: firstRow?.block_date || null, last: lastRow?.block_date || null, error: null }
}

/**
 * After the new roster's blocks have been tagged, settle every other roster
 * the publish swallowed.
 *
 * 🔴 The new roster's blocks MUST already carry its id before this runs, or
 * the recount below reads the new roster as owning nothing and it supersedes
 * ITSELF. `newRosterId` is excluded from the scan explicitly rather than
 * relying on the caller's ordering, and a missing id refuses outright.
 *
 * Best-effort by design: every failure is collected into `warning` for the
 * route to surface in its existing partial-success shape. Nothing here may
 * roll back a publish that already happened, and nothing here throws.
 *
 * @returns {Promise<{ superseded: string[], shrunk: Array<{id: string, period_start: string, period_end: string}>, warning: string|null }>}
 */
export async function supersedeSwallowedRosters(db, { locationId, newRosterId, periodStart, periodEnd, releasedIds = [] } = {}) {
  const superseded = []
  const shrunk = []
  const warnings = []

  if (!newRosterId) {
    return { superseded, shrunk, warning: 'supersede skipped: no newRosterId' }
  }

  const nowIso = new Date().toISOString()

  try {
    // 1. Stamp the successor on the rows released before the insert. `.is()`
    //    keeps an earlier publish's attribution rather than overwriting it.
    const pending = (releasedIds || []).filter((id) => id && id !== newRosterId)
    if (pending.length > 0) {
      // ROSTER-SUPERSEDE.1 — report the rows the write actually TOUCHED, not
      // the rows it was aimed at. All three filters can legitimately miss (a
      // racing publish flipping the row back, or stamping its own successor
      // first), and reporting a stamp that never landed as a success hides
      // exactly the attribution gap this call exists to close.
      const { data: stamped, error: stampErr } = await db
        .from('rosters')
        .update({ superseded_by: newRosterId })
        .in('id', pending)
        .eq('status', 'superseded')
        .is('superseded_by', null)
        .select('id')
      if (stampErr) {
        warnings.push(`superseded_by stamp failed: ${stampErr.message}`)
      } else {
        const stampedIds = (stamped || []).map((row) => row?.id).filter(Boolean)
        superseded.push(...stampedIds)
        const missed = pending.filter((id) => !stampedIds.includes(id))
        if (missed.length > 0) {
          warnings.push(`superseded_by stamp matched no row for: ${missed.join(', ')}`)
        }
      }
    }

    // 2. Sweep anything still published that overlaps. On a box with mig 602
    //    applied this finds nothing (phase 1 already released the contained
    //    ones and a straddle is a 409); it is the self-healing path for rows
    //    that predate the constraint.
    const { data: overlapping, error: scanErr } = await db
      .from('rosters')
      .select('id, period_start, period_end')
      .eq('location_id', locationId)
      .eq('status', 'published')
      .lte('period_start', periodEnd)
      .gte('period_end', periodStart)
      .neq('id', newRosterId)
    if (scanErr) {
      warnings.push(`overlapping roster scan failed: ${scanErr.message}`)
      return { superseded, shrunk, warning: warnings.join('; ') || null }
    }

    for (const r of overlapping || []) {
      if (r.id === newRosterId) continue
      const { count, first, last, error: ownErr } = await ownedBlockRange(db, r.id)
      if (ownErr) {
        // Reading a failed count as "owns nothing" would supersede a live
        // roster and unpublish its blocks. Leave it alone and say so.
        warnings.push(`block recount failed for roster ${r.id}: ${ownErr.message}`)
        continue
      }

      if (count === 0) {
        const { error: supErr } = await db
          .from('rosters')
          .update({ status: 'superseded', superseded_at: nowIso, superseded_by: newRosterId })
          .eq('id', r.id)
          .eq('status', 'published')
        if (supErr) warnings.push(`supersede failed for roster ${r.id}: ${supErr.message}`)
        else superseded.push(r.id)
        continue
      }

      // Still owns blocks — shrink its period to what it owns. requested_*
      // is the operator's original ask and is never rewritten.
      if (!first || !last) continue
      if (r.period_start === first && r.period_end === last) continue
      const { error: shrinkErr } = await db
        .from('rosters')
        .update({ period_start: first, period_end: last })
        .eq('id', r.id)
        .eq('status', 'published')
      if (shrinkErr) warnings.push(`period shrink failed for roster ${r.id}: ${shrinkErr.message}`)
      else shrunk.push({ id: r.id, period_start: first, period_end: last })
    }
  } catch (e) {
    warnings.push(`supersede threw: ${e?.message || e}`)
  }

  return { superseded, shrunk, warning: warnings.length > 0 ? warnings.join('; ') : null }
}
