// src/lib/labour-month-model.js
//
// LABOUR.1 — owner-only labour against revenue for the current Dublin month.
// Pure: no IO, no clock of its own (nowMs is passed in), and nothing reads the
// host's timezone (tests run under Europe/Dublin and America/Los_Angeles).
//
// Definitions (plan 35-LABOUR.1.md, D1-D13; don't re-derive them elsewhere):
//   revenue   = the Studio scorecard's MRR (shared/studio-kpis.js fetchMrr),
//               "so far" = MRR × the elapsed fraction of the month.
//   employees = annual_salary / 12 a month whatever the roster says, split
//               between studios by published hours; "so far" = × elapsed.
//               The split runs over the person's studios in EVERY organisation
//               (salaryBasisFrom + salaryShares), and each organisation's view
//               is charged only its own studios' share (LABOUR.1 review 1).
//   contractors = published hours × hourly_rate, ADMIN SHIFTS INCLUDED (unlike
//               contractor spend's budget gate: an admin shift is still paid).
//   forecast  = the published roster for the whole month; actual = published
//               shifts that have ended. Drafts are never costed.
//
// PAY NEVER LEAVES THIS MODULE AS A RATE. buildLabourMonth takes each person's
// annual_salary / hourly_rate and returns studio TOTALS, ratios and hours, plus
// the NAMES of people it could not cost. The test stringifies the result and
// greps it for every rate it was given.

import { workingWindow, EMPLOYEE_TYPE } from '@shared/working-time'
import { isLiveAssignment } from './roster'
import { hasRoleAtLocation } from './role-at-location'
import { dublinDayStr, dublinDayRangeMs } from './dublin-time'

export const CONTRACTOR_TYPE = 'contractor'

// Richard's program rule: pay reaches owners only. Masters pass through
// hasRoleAtLocation's bypass. Deliberately NOT ADMIN_ROLES (which has manager).
export const LABOUR_VIEWER_ROLES = Object.freeze(['owner'])

// OWNER REVIEW (LABOUR.1 open question 3): a salaried employee with no
// published hours this month is still paid, so their salary is split equally
// across their studios. Flip to false to leave unrostered salaries out.
export const COUNT_UNROSTERED_SALARIES = true

const MINUTE_MS = 60_000

/**
 * The Dublin calendar month holding `nowMs`.
 * @param {number} nowMs
 */
export function labourMonthWindow(nowMs) {
  const today = dublinDayStr(nowMs)
  const month = today.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const startDate = `${month}-01`
  const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const { startMs, endMs } = dublinDayRangeMs(startDate, endDate)
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
  const monthLabel = new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
  return {
    month, monthLabel, startDate, endDate, startMs, endMs,
    daysInMonth, dayOfMonth: Number(today.slice(8, 10)), elapsedFraction,
  }
}

/**
 * The studios of the ACTIVE organisation where `user` may see labour: owner
 * at that studio (a master everywhere). Ordered by name.
 * @returns {{ id: string, name: string }[]}
 */
export function labourStudiosFor(user) {
  const orgId = user?.activeLocation?.organization_id
  if (!user?.activeLocation?.id || !orgId) return []
  return (user.locations || [])
    .filter((l) => l?.id && l.organization_id === orgId && hasRoleAtLocation(user, l.id, LABOUR_VIEWER_ROLES))
    .map((l) => ({ id: l.id, name: l.name || 'Studio' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The block renders only when the ACTIVE studio is one the viewer owns. */
export function canSeeLabour(user) {
  const activeId = user?.activeLocation?.id
  return !!activeId && labourStudiosFor(user).some((s) => s.id === activeId)
}

/**
 * Flatten shift_blocks (with their embedded roster, template and
 * assignments) to one row per LIVE assignment, in the shape workingWindow
 * reads: override, then the block's own time, then the template's.
 */
export function labourShiftRows(blocks) {
  const rows = []
  for (const b of blocks || []) {
    const tpl = b?.shift_templates || {}
    const published = b?.rosters?.status === 'published'
    for (const a of b?.shift_assignments || []) {
      if (!a?.profile_id || !isLiveAssignment(a)) continue
      rows.push({
        assignment_id: a.id,
        block_id: b.id,
        profile_id: a.profile_id,
        location_id: b.location_id,
        block_date: b.block_date,
        published,
        status: a.status ?? null,
        start_time: b.start_time ?? null,
        end_time: b.end_time ?? null,
        start_time_override: a.start_time_override ?? null,
        end_time_override: a.end_time_override ?? null,
        shift_templates: { start_time: tpl.start_time ?? null, end_time: tpl.end_time ?? null },
      })
    }
  }
  return rows
}

function round1(n) { return Math.round(n * 10) / 10 }

/** An active, undeleted employee with a salary: costed at salary/12. */
export function isSalaried(person) {
  return !!person
    && person.employment_type === EMPLOYEE_TYPE
    && Number(person.annual_salary) > 0
    && person.active !== false
    && !person.deleted_at
}

/**
 * A studio that can carry a salary share: active and not a host-event anchor
 * (mig 388 `is_host_anchor`) — the rule the location pickers use
 * (`/api/locations`: `.eq('active', true).eq('is_host_anchor', false)`).
 */
export function isCountableStudio(loc) {
  return loc?.active === true && !loc?.is_host_anchor
}

/**
 * Each salaried person's split basis ACROSS EVERY ORGANISATION: published
 * minutes per studio this month, and the countable studios they belong to.
 *
 * @param {object} args
 * @param {string[]} args.ids     salaried people (isSalaried)
 * @param {object[]} args.rows    labourShiftRows of THEIR assignments at ANY studio
 * @param {{profile_id:string, location_id:string, locations?:{active?:boolean, is_host_anchor?:boolean}|null}[]} args.links
 *   their profile_locations rows at ANY studio, with the location embedded
 * @returns {Map<string, { minutes: Map<string, number>, studios: Set<string> }>}
 */
export function salaryBasisFrom({ ids, rows, links }) {
  const basis = new Map((ids || []).map((id) => [id, { minutes: new Map(), studios: new Set() }]))
  for (const r of rows || []) {
    const b = basis.get(r?.profile_id)
    if (!b || !r.published) continue
    const w = workingWindow(r)
    if (!w) continue
    b.minutes.set(r.location_id, (b.minutes.get(r.location_id) || 0) + (w.endMs - w.startMs) / MINUTE_MS)
  }
  for (const l of links || []) {
    const b = basis.get(l?.profile_id)
    if (b && l.location_id && isCountableStudio(l.locations)) b.studios.add(l.location_id)
  }
  return basis
}

/**
 * THE salary split rule, in one place (an owner may later pick a "home org"
 * instead; change it here). By published minutes wherever there are any; else
 * equally across the countable studios they belong to (COUNT_UNROSTERED_SALARIES);
 * else nothing — the caller names them as "no studio".
 *
 * @param {{ minutes: Map<string, number>, studios: Set<string> } | undefined} basis
 * @returns {[string, number][]}  [studio id, share]; shares sum to 1, or it is empty
 */
export function salaryShares(basis, { countUnrostered = COUNT_UNROSTERED_SALARIES } = {}) {
  const worked = [...(basis?.minutes || [])].filter(([, m]) => m > 0)
  const total = worked.reduce((t, [, m]) => t + m, 0)
  if (total > 0) return worked.map(([loc, m]) => [loc, m / total])
  if (!countUnrostered) return []
  const locs = [...(basis?.studios || [])]
  return locs.map((loc) => [loc, 1 / locs.length])
}

/** Labour as a % of revenue, one decimal; null when there is no revenue to divide by. */
export function labourPct(costCents, revenueCents) {
  if (costCents == null || !(Number(revenueCents) > 0)) return null
  return Math.round((costCents / revenueCents) * 1000) / 10
}

function uncostedReason(person, type, current) {
  if (!person) return 'unknown_person'
  if (type === EMPLOYEE_TYPE) return current ? 'no_salary' : 'inactive_employee'
  if (type === CONTRACTOR_TYPE) return 'no_rate'
  return 'unknown_type'
}

function emptyAcc() {
  return {
    employees: { forecast: 0, actual: 0 },
    contractors: { forecast: 0, actual: 0 },
    minutes: { forecast: 0, actual: 0 },
  }
}

function shapeStudio({ studio, acc, rev, draftMinutes, elapsed }) {
  const status = rev == null
    ? 'unavailable'
    : (Number(rev.mrrCents) > 0 && Number(rev.recurringMembers) > 0 ? 'tracked' : 'none')
  const mrrCents = status === 'tracked' ? Math.round(Number(rev.mrrCents)) : null
  const revenueToDate = mrrCents != null ? Math.round(mrrCents * elapsed) : null
  const part = (k) => {
    const employees = Math.round(acc.employees[k])
    const contractors = Math.round(acc.contractors[k])
    return { employees_cents: employees, contractors_cents: contractors, cost_cents: employees + contractors, hours: round1(acc.minutes[k] / 60) }
  }
  const forecast = part('forecast')
  const actual = part('actual')
  return {
    location_id: studio.id,
    name: studio.name,
    revenue_status: status,
    mrr_cents: mrrCents,
    recurring_members: status === 'tracked' ? Number(rev.recurringMembers) : null,
    revenue_to_date_cents: revenueToDate,
    forecast,
    actual,
    forecast_pct: labourPct(forecast.cost_cents, mrrCents),
    actual_pct: labourPct(actual.cost_cents, revenueToDate),
    draft_hours: round1(draftMinutes / 60),
  }
}

function totalOf(rows) {
  if (rows.length < 2) return null
  const sum = (list, f) => list.reduce((t, r) => t + f(r), 0)
  const tracked = rows.filter((r) => r.revenue_status === 'tracked')
  const any = tracked.length > 0
  const mrr = any ? sum(tracked, (r) => r.mrr_cents) : null
  const toDate = any ? sum(tracked, (r) => r.revenue_to_date_cents) : null
  const part = (k) => ({
    employees_cents: sum(rows, (r) => r[k].employees_cents),
    contractors_cents: sum(rows, (r) => r[k].contractors_cents),
    cost_cents: sum(rows, (r) => r[k].cost_cents),
    hours: round1(sum(rows, (r) => r[k].hours)),
  })
  return {
    name: 'All studios shown',
    revenue_status: any ? 'tracked' : 'none',
    mrr_cents: mrr,
    recurring_members: any ? sum(tracked, (r) => r.recurring_members) : null,
    revenue_to_date_cents: toDate,
    forecast: part('forecast'),
    actual: part('actual'),
    // Ratios over the studios that HAVE revenue only: Hatch's labour on
    // Stillorgan's revenue would overstate the percentage.
    forecast_pct: labourPct(sum(tracked, (r) => r.forecast.cost_cents), mrr),
    actual_pct: labourPct(sum(tracked, (r) => r.actual.cost_cents), toDate),
    draft_hours: round1(sum(rows, (r) => r.draft_hours)),
    ratio_excludes: rows.filter((r) => r.revenue_status !== 'tracked').map((r) => r.name),
  }
}

/**
 * The owner's view model. TOTALS, RATIOS, HOURS AND NAMES ONLY.
 *
 * @param {object} args
 * @param {ReturnType<typeof labourMonthWindow>} args.period
 * @param {number} args.nowMs
 * @param {{id:string,name:string}[]} args.studios        the studios to show
 * @param {object[]} args.rows                              labourShiftRows over EVERY studio of the organisation
 * @param {Map<string, object>} args.people                 id → { full_name, employment_type, active, deleted_at, annual_salary, hourly_rate }
 * @param {Map<string, Set<string>>} args.memberships       id → the organisation's studios they belong to
 * @param {Map<string, {mrrCents:number, recurringMembers:number}|null>} args.revenue  per studio shown; null = could not be read
 * @param {Map<string, {minutes:Map<string,number>, studios:Set<string>}>} [args.salaryBasis]
 *   salaryBasisFrom over EVERY organisation. Pass it (the data layer always
 *   does): once passed, a salaried person missing from it has no studio. Left
 *   out, the split falls back to this organisation's roster and memberships,
 *   which charges a person linked to several organisations their whole salary
 *   in each (kept only for the single-organisation model tests).
 * @param {boolean} [args.countUnrostered]
 */
export function buildLabourMonth({
  period, nowMs, studios, rows, people, memberships, revenue, salaryBasis,
  countUnrostered = COUNT_UNROSTERED_SALARIES,
}) {
  const shownIds = new Set(studios.map((s) => s.id))

  // Published minutes per person per studio (forecast = all, actual = ended);
  // draft minutes per studio; untimed published shifts at a studio shown.
  const worked = new Map()
  const draftMinutes = new Map()
  let untimed = 0
  for (const r of rows || []) {
    const w = workingWindow(r)
    if (!w) {
      if (r.published && shownIds.has(r.location_id)) untimed += 1
      continue
    }
    const minutes = (w.endMs - w.startMs) / MINUTE_MS
    if (!r.published) {
      draftMinutes.set(r.location_id, (draftMinutes.get(r.location_id) || 0) + minutes)
      continue
    }
    if (!worked.has(r.profile_id)) worked.set(r.profile_id, new Map())
    const cells = worked.get(r.profile_id)
    const cell = cells.get(r.location_id) || { forecast: 0, actual: 0 }
    cell.forecast += minutes
    if (w.endMs <= nowMs) cell.actual += minutes
    cells.set(r.location_id, cell)
  }

  const acc = new Map(studios.map((s) => [s.id, emptyAcc()]))
  const uncosted = []
  const ids = new Set([...worked.keys(), ...(memberships ? memberships.keys() : [])])
  for (const id of ids) {
    const person = people?.get(id) || null
    const cells = worked.get(id) || new Map()
    let workedMinutes = 0
    let workedShownMinutes = 0
    for (const [loc, c] of cells) {
      workedMinutes += c.forecast
      const a = acc.get(loc)
      if (!a) continue
      a.minutes.forecast += c.forecast
      a.minutes.actual += c.actual
      workedShownMinutes += c.forecast
    }
    const type = person?.employment_type ?? null
    const rate = Number(person?.hourly_rate) || 0
    const current = !!person && person.active !== false && !person.deleted_at

    if (isSalaried(person)) {
      const monthlyCents = (Number(person.annual_salary) * 100) / 12
      const basis = salaryBasis
        ? salaryBasis.get(id)
        : { minutes: new Map([...cells].map(([loc, c]) => [loc, c.forecast])), studios: memberships?.get(id) || new Set() }
      const shares = salaryShares(basis, { countUnrostered })
      // Nowhere to charge it (no published hours and no countable studio): say so.
      // With the owner switch off an unrostered salary is left out by choice.
      if (shares.length === 0 && (countUnrostered || workedMinutes > 0)) {
        uncosted.push({ name: person.full_name || 'Unknown person', reason: 'no_studio', hours: round1(workedShownMinutes / 60) })
        continue
      }
      for (const [loc, share] of shares) {
        const a = acc.get(loc)
        if (!a) continue // another organisation's studio: its owner sees that share
        a.employees.forecast += monthlyCents * share
        a.employees.actual += monthlyCents * share * period.elapsedFraction
      }
      continue
    }

    if (type === CONTRACTOR_TYPE && rate > 0) {
      for (const [loc, c] of cells) {
        const a = acc.get(loc)
        if (!a) continue
        a.contractors.forecast += (c.forecast / 60) * rate * 100
        a.contractors.actual += (c.actual / 60) * rate * 100
      }
      continue
    }

    if (workedShownMinutes <= 0) continue // did not work here: nothing is missing
    uncosted.push({ name: person?.full_name || 'Unknown person', reason: uncostedReason(person, type, current), hours: round1(workedShownMinutes / 60) })
  }

  const studioRows = studios.map((s) => shapeStudio({
    studio: s,
    acc: acc.get(s.id),
    rev: revenue?.get(s.id) ?? null,
    draftMinutes: draftMinutes.get(s.id) || 0,
    elapsed: period.elapsedFraction,
  }))

  return {
    month: period.month,
    month_label: period.monthLabel,
    day_of_month: period.dayOfMonth,
    days_in_month: period.daysInMonth,
    studios: studioRows,
    total: totalOf(studioRows),
    uncosted: uncosted.sort((x, y) => x.name.localeCompare(y.name)),
    untimed_shifts: untimed,
  }
}
