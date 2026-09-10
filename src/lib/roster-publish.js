// Roster v2 phase 5 — publish helpers.
//
// projectPublishImpact: server-side function that given a
// location + publish period returns what the month-total
// contractor spend WILL be if this period is published, plus
// the budget delta. Drives the publish modal's "you'll be €X
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
 * Return the (location, contractor staff lookup, blocks-in-month
 * with roster join, current monthly_contractor_budget_eur) needed
 * to evaluate a publish.
 */
async function loadBudgetContext(db, locationId, periodStart) {
  const monthStart = isoFirstOfMonth(periodStart)
  const monthEnd = isoLastOfMonth(periodStart)

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

  // All blocks in the calendar month containing periodStart, with
  // their assignments and roster join. We consider the union of
  // (already-published blocks in the month outside the period)
  // PLUS (all blocks in the period — published or not).
  // ROSTER-FIX.4 — the per-coach overrides ride along: a coach whose window
  // a manager adjusted is paid for THAT window, not the block's.
  const { data: monthBlocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, start_time, end_time, roster_id,
      shift_assignments(profile_id, status, start_time_override, end_time_override),
      rosters:roster_id(id, status)
    `)
    .eq('location_id', locationId)
    .gte('block_date', monthStart)
    .lte('block_date', monthEnd)
  if (blocksErr) throw new Error(`Block lookup failed: ${blocksErr.message}`)

  // ROSTER-FIX.4 — approved leave for the month, in ONE query. A coach on
  // approved leave is not working the shift they are still rostered on, so
  // billing it inflated the projection and could refuse a publish that was
  // actually within budget.
  const { data: leave, error: leaveErr } = await db
    .from('time_off_requests')
    .select('profile_id, start_date, end_date')
    .eq('location_id', locationId)
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
    monthBlocks: monthBlocks || [],
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
 * @returns {{
 *   monthStart, monthEnd,
 *   monthlyBudgetEur: number | null,
 *   alreadyPublishedEur: number,     // outside the period, on a published roster
 *   periodProjectedEur: number,      // about to be published
 *   monthProjectedTotalEur: number,
 *   remainingEur: number | null,
 *   overBudget: boolean,
 *   overrunEur: number,              // 0 if under, positive if over
 *   blockCount: number,
 * }}
 */
export async function projectPublishImpact(db, { locationId, periodStart, periodEnd }) {
  const ctx = await loadBudgetContext(db, locationId, periodStart)
  const { location, monthStart, monthEnd, contractorRateById, leaveByProfile, monthBlocks } = ctx

  let alreadyPublishedEur = 0
  let periodProjectedEur = 0
  let blockCount = 0

  for (const b of monthBlocks) {
    const cost = blockContractorCost(b, contractorRateById, leaveByProfile)
    if (cost === 0) continue
    const inPeriod = b.block_date >= periodStart && b.block_date <= periodEnd
    if (inPeriod) {
      periodProjectedEur += cost
      blockCount++
    } else {
      // Only count if currently on a PUBLISHED roster — drafts
      // don't consume budget until they're published.
      if (b.rosters?.status === 'published') {
        alreadyPublishedEur += cost
      }
    }
  }

  const budget = location?.monthly_contractor_budget_eur != null
    ? Number(location.monthly_contractor_budget_eur)
    : null

  const monthProjectedTotalEur = round2(alreadyPublishedEur + periodProjectedEur)
  const remainingEur = budget != null ? round2(budget - monthProjectedTotalEur) : null
  const overBudget = budget != null && monthProjectedTotalEur > budget
  const overrunEur = overBudget ? round2(monthProjectedTotalEur - budget) : 0

  return {
    monthStart,
    monthEnd,
    monthlyBudgetEur: budget,
    alreadyPublishedEur: round2(alreadyPublishedEur),
    periodProjectedEur: round2(periodProjectedEur),
    monthProjectedTotalEur,
    remainingEur,
    overBudget,
    overrunEur,
    blockCount,
  }
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
 * A STRADDLE still 409s, and deliberately so. Two reasons, either sufficient:
 * mig 602 would reject the insert outright (the un-swallowed half of the
 * older roster keeps overlapping whatever we do to it), and resolving it
 * would mean SHRINKING a roster the operator did not ask to change — moving
 * somebody else's published dates silently is not a thing to do on their
 * behalf. The 409 names the ranges so they can re-publish the right one.
 *
 * Both period bounds are inclusive, and dates are ISO YYYY-MM-DD strings, so
 * string comparison IS date comparison.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role client
 * @param {{ locationId: string, periodStart: string, periodEnd: string, excludeRosterId?: string|null }} opts
 * @returns {Promise<{ conflicts: Array<{id: string, period_start: string, period_end: string}>, error: any }>}
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
  if (error) return { conflicts: [], error }

  // Contained-in-the-new-period is inclusive on both ends, so an exact
  // re-publish falls out as "contained" and is allowed too.
  const conflicts = (data || []).filter((r) => !(r.period_start >= periodStart && r.period_end <= periodEnd))
  return { conflicts, error: null }
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
