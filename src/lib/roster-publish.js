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

import { shiftHours } from './payroll'
import { liveAssignments } from './roster'
import { staffingGaps } from './roster-staffing'
import { dublinTodayStr } from './dublin-time'
import { leaveScopeOrFilter } from './time-off-leave'

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
 */
async function loadBudgetContext(db, locationId, periodStart, periodEnd = periodStart) {
  const monthStart = isoFirstOfMonth(periodStart)
  const monthEnd = isoLastOfMonth(periodEnd > periodStart ? periodEnd : periodStart)

  // Location budget snapshot.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, monthly_contractor_budget_eur')
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
        shift_assignments(profile_id, status, start_time_override, end_time_override),
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

  // ROSTER-FIX.4 — approved leave for the months, in ONE query. A coach on
  // approved leave is not working the shift they are still rostered on, so
  // billing it inflated the projection and could refuse a publish that was
  // actually within budget.
  // LEAVE.2 — leave covers the person: a coach here who filed leave from
  // another studio is still not working this studio's shifts.
  const { data: leave, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date')
    .or(leaveScopeOrFilter([locationId], (links || []).map((l) => l.profile_id)))
    .eq('status', 'approved')
    .lte('start_date', monthEnd)
    .gte('end_date', monthStart)
  if (leaveErr) throw new Error(`Leave lookup failed: ${leaveErr.message}`)

  const leaveByProfile = new Map()
  for (const row of leave || []) {
    if (!leaveByProfile.has(row.profile_id)) leaveByProfile.set(row.profile_id, [])
    leaveByProfile.get(row.profile_id).push(row)
  }

  return {
    location: loc,
    monthStart,
    monthEnd,
    contractorRateById,
    leaveByProfile,
    monthBlocks,
  }
}

/**
 * Is this coach on approved leave on this date? Both ends inclusive —
 * time_off_requests.end_date is documented inclusive (mig 011). Dates are
 * ISO YYYY-MM-DD strings, so string comparison IS date comparison.
 */
function isOnLeave(leaveByProfile, profileId, dateIso) {
  const rows = leaveByProfile?.get(profileId)
  if (!rows) return false
  return rows.some((r) => r.start_date <= dateIso && r.end_date >= dateIso)
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
 *   months: Array<{
 *     monthStart, monthEnd, monthlyBudgetEur, alreadyPublishedEur,
 *     periodProjectedEur, monthProjectedTotalEur, remainingEur,
 *     overBudget, overrunEur, blockCount,
 *   }>,
 * }}
 */
export async function projectPublishImpact(db, { locationId, periodStart, periodEnd, todayIso = dublinTodayStr() }) {
  const ctx = await loadBudgetContext(db, locationId, periodStart, periodEnd)
  const { location, contractorRateById, leaveByProfile, monthBlocks } = ctx

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
 * @param {Array<{id: string, period_start: string, period_end: string, trim_to: {period_start: string, period_end: string}}>} trims
 * @returns {Promise<{ trimmed: Array<{id: string, period_start: string, period_end: string, trim_to: object}>, error: any }>}
 */
export async function trimPublishedRosters(db, trims) {
  const targets = (trims || []).filter((t) => t?.id && t?.trim_to?.period_start && t?.trim_to?.period_end)
  if (targets.length === 0) return { trimmed: [], error: null }

  const trimmed = []
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
    if (!updErr && (touched || []).length === 0) {
      const { error: restoreErr } = await restoreRosterPeriods(db, trimmed)
      const stale = new Error(`roster ${t.id} changed since it was read, so it was not trimmed`)
      if (restoreErr) {
        return { trimmed: [], error: withRestoreFailure(stale, restoreErr, trimmed.map((x) => x.id)) }
      }
      return { trimmed: [], error: stale }
    }
    if (updErr) {
      const { error: restoreErr } = await restoreRosterPeriods(db, trimmed)
      if (restoreErr) {
        return { trimmed: [], error: withRestoreFailure(updErr, restoreErr, trimmed.map((x) => x.id)) }
      }
      return { trimmed: [], error: updErr }
    }
    trimmed.push(t)
  }
  return { trimmed, error: null }
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
 * The blocks a roster still owns: how many, and the first/last date. Three
 * cheap queries rather than one `select('block_date')` because the 1,000-row
 * select cap would silently truncate min/max on a long period (CLAUDE.md).
 *
 * @returns {Promise<{ count: number, first: string|null, last: string|null, error: any }>}
 */
async function ownedBlockRange(db, rosterId) {
  const { count, error: countErr } = await db
    .from('shift_blocks')
    .select('id', { count: 'exact', head: true })
    .eq('roster_id', rosterId)
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
