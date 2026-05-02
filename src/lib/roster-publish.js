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

import { shiftHours } from './payroll'

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
  const { data: monthBlocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, start_time, end_time, roster_id,
      shift_assignments(profile_id),
      rosters:roster_id(id, status)
    `)
    .eq('location_id', locationId)
    .gte('block_date', monthStart)
    .lte('block_date', monthEnd)
  if (blocksErr) throw new Error(`Block lookup failed: ${blocksErr.message}`)

  return {
    location: loc,
    monthStart,
    monthEnd,
    contractorRateById,
    monthBlocks: monthBlocks || [],
  }
}

function blockContractorCost(block, contractorRateById) {
  const hours = shiftHours({
    start_time: block.start_time,
    end_time: block.end_time,
    shift_templates: { start_time: block.start_time, end_time: block.end_time },
  })
  let cost = 0
  for (const a of block.shift_assignments || []) {
    const rate = contractorRateById[a.profile_id] || 0
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
  const { location, monthStart, monthEnd, contractorRateById, monthBlocks } = ctx

  let alreadyPublishedEur = 0
  let periodProjectedEur = 0
  let blockCount = 0

  for (const b of monthBlocks) {
    const cost = blockContractorCost(b, contractorRateById)
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

function round2(n) { return Math.round(n * 100) / 100 }
