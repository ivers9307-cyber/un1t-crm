// SCHEDULE-SPEND-AGG.1 — server-side contractor-spend aggregation.
//
// summarizeMonth (roster-summary.js) needs every holder's pay to compute
// contractor euro spend, which is HR-sensitive — `/api/staff` withholds rates
// from non-admin roles like head_coach. So the transform runs HERE with the
// service-role client and returns AGGREGATE figures only — no per-coach value
// crosses the wire. Drives /api/schedule/contractor-spend (MANAGER_ROLES at
// the location), so a head coach sees totals and over-budget signals without
// ever being granted anyone's rate.
//
// CONTRACTORSPEND.1 (27 Sep 2026):
//   - the month is monthBounds(referenceDate): string arithmetic on the Dublin
//     calendar date the route validated. It was parsed into a Date here AND in
//     summarizeMonth, and west of UTC the two disagreed (EUR 0);
//   - pay is read for the HOLDERS of the month's shifts (loadHolderPay:
//     profiles by named columns + profile_compensation), not for this studio's
//     members from the deprecated profiles pay columns — a contractor from the
//     sibling studio who covered a class here was priced at EUR 0;
//   - the block read carries roster status (published vs not) and pages.
// Every read failure throws; the route answers 500 and the panel says
// "Could not be loaded" rather than showing EUR 0.
//
// FTECOSTVIS.1 (Richard, 28 Sep 2026: "keep the cost hidden") — one figure
// here is salary-derived: fteImplicitCostEur, rostered FTE hours × annual_salary
// / 52 / contracted_hours_per_week (implicitHourlyRate). With one employee on
// the month's shifts it is that person's pay. It goes to owner / manager /
// master AT the studio only; the route hands everyone else
// contractorSpendOnly(), an ALLOWLIST, so a figure added to summarizeMonth
// later stays hidden from head coaches until someone classifies it below.

import { summarizeMonth } from './roster-summary'
import { monthBounds } from '@shared/roster-month'
import { selectAll } from './select-all'
import { loadHolderPay, liveHolderIds } from './shift-holder-pay'

/**
 * Monthly contractor spend totals for `locationId` in the month holding
 * `referenceDate`. Returns summarizeMonth's shape — aggregate only.
 *
 * Auth is the caller's responsibility (MANAGER_ROLES at the location).
 *
 * @param {object} args
 * @param {object} args.db            service-role Supabase client
 * @param {string} args.locationId    uuid
 * @param {string} args.referenceDate YYYY-MM-DD inside the target month
 */
export async function computeMonthlyContractorSpend({ db, locationId, referenceDate }) {
  const { monthStartIso, monthEndIso } = monthBounds(referenceDate)

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

  // Every block at this studio in the month, with its roster status, template
  // times + kind, and assignments. Paged: PostgREST caps a select at 1,000 rows.
  const blocks = await selectAll((from, to) => db
    .from('shift_blocks')
    .select('id, location_id, block_date, start_time, end_time, template_id, rosters:roster_id ( status ), shift_assignments(id, profile_id, start_time_override, end_time_override, status), shift_templates(start_time, end_time, kind)')
    .eq('location_id', locationId)
    .gte('block_date', monthStartIso)
    .lte('block_date', monthEndIso)
    .order('id', { ascending: true })
    .range(from, to))

  // Pay for whoever holds those shifts — consumed in-memory, never returned.
  const pay = await loadHolderPay(db, liveHolderIds(blocks))

  return summarizeMonth({
    blocks,
    pay,
    referenceDate,
    monthlyBudgetEur: loc.monthly_contractor_budget_eur,
  })
}

/**
 * FTECOSTVIS.1 — the spend figures every MANAGER_ROLES caller at the studio
 * may see: contractor pay (hours × hourly_rate) and the budget built on it.
 * Every key computeMonthlyContractorSpend returns is in exactly one of this
 * list and SALARY_DERIVED_SPEND_KEYS (pinned in roster-summary-server.test.js).
 */
export const CONTRACTOR_SPEND_KEYS = Object.freeze([
  'monthStartIso', 'monthEndIso',
  'contractorCostEur', 'unpublishedContractorCostEur', 'projectedContractorCostEur',
  'monthlyBudgetEur', 'remainingEur', 'overBudget', 'projectedOverBudget', 'utilisationPct',
])

/** FTECOSTVIS.1 — figures computed from a salary: owner / manager / master at the studio only. */
export const SALARY_DERIVED_SPEND_KEYS = Object.freeze(['fteImplicitCostEur'])

/**
 * FTECOSTVIS.1 — the spend as a head coach receives it: only the keys in
 * CONTRACTOR_SPEND_KEYS, copied. Anything else (the FTE labour total, or a key
 * nobody has classified yet) is left behind.
 * @param {object|null|undefined} spend  computeMonthlyContractorSpend's result
 * @returns {object}
 */
export function contractorSpendOnly(spend) {
  const out = {}
  if (!spend) return out
  for (const k of CONTRACTOR_SPEND_KEYS) {
    if (Object.hasOwn(spend, k)) out[k] = spend[k]
  }
  return out
}
