// SCHEDULE-SPEND-AGG.1 — server-side contractor-spend aggregation.
//
// summarizeMonth (roster-summary.js) is a pure transform that runs
// client-side today. It needs every coach's hourly_rate to compute
// contractor euro spend, which is HR-sensitive — `/api/staff`
// intentionally withholds rates from non-admin roles like
// head_coach. Result: head_coach reads the panel and sees a flat
// €0 contractor spend, with no signal when the month is over
// budget.
//
// This helper runs the same transform server-side with full pay
// data (service-role bypasses RLS) and returns AGGREGATE figures
// only — no per-coach euro values cross the wire. Drives the
// /api/schedule/contractor-spend endpoint, which is gated to
// MANAGER_ROLES so head_coach can see totals + over-budget
// signals without ever being granted visibility of individual
// rates.

import { summarizeMonth } from './roster-summary'

/**
 * Resolve the calendar-month boundary dates for the month
 * containing `referenceDate`. Mirrors summarizeMonth's own internal
 * calc so we can scope the block fetch tightly.
 */
function monthBoundsIso(referenceDate) {
  const ref = new Date(referenceDate + 'T00:00:00')
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1)
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0)
  return { startIso: toIso(start), endIso: toIso(end) }
}

function toIso(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Fetch the inputs and compute monthly contractor spend totals for
 * `locationId` at `referenceDate`. Returns the same shape
 * summarizeMonth produces — already aggregate-only.
 *
 * Auth is the caller's responsibility (MANAGER_ROLES + location
 * membership). This helper trusts its inputs.
 *
 * @param {object} args
 * @param {object} args.db            service-role Supabase client
 * @param {string} args.locationId    uuid
 * @param {string} args.referenceDate ISO date YYYY-MM-DD inside the target month
 */
export async function computeMonthlyContractorSpend({ db, locationId, referenceDate }) {
  const { startIso, endIso } = monthBoundsIso(referenceDate)

  // Location budget (null = not configured).
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, monthly_contractor_budget_eur')
    .eq('id', locationId)
    .single()
  if (locErr || !loc) {
    const err = new Error('Location not found')
    err.code = 'LOCATION_NOT_FOUND'
    throw err
  }

  // Blocks for the calendar month — same shape summarizeMonth expects.
  const { data: blocks, error: blocksErr } = await db
    .from('shift_blocks')
    .select(`
      id, location_id, block_date, start_time, end_time,
      shift_template_id, max_coaches,
      shift_assignments(profile_id, start_time_override, end_time_override, status),
      shift_templates(start_time, end_time)
    `)
    .eq('location_id', locationId)
    .gte('block_date', startIso)
    .lte('block_date', endIso)
  if (blocksErr) throw new Error(blocksErr.message)

  // Staff assigned to this location with FULL pay fields — service-
  // role bypasses the privacy-shaped slim payload `/api/staff` serves
  // to non-admin roles. Per-coach figures NEVER leave this helper;
  // they're consumed in-memory by summarizeMonth.
  const { data: links, error: linksErr } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
  if (linksErr) throw new Error(linksErr.message)
  const profileIds = (links || []).map((l) => l.profile_id)

  let staff = []
  if (profileIds.length > 0) {
    const { data: profiles, error: profilesErr } = await db
      .from('profiles')
      .select(`
        id, full_name, active, employment_type,
        contracted_hours_per_week, hourly_rate, annual_salary, overtime_rate
      `)
      .in('id', profileIds)
    if (profilesErr) throw new Error(profilesErr.message)
    staff = profiles || []
  }

  return summarizeMonth({
    blocks: blocks || [],
    staff,
    referenceDate,
    monthlyBudgetEur: loc.monthly_contractor_budget_eur,
  })
}
