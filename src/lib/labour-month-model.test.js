// src/lib/labour-month-model.test.js
// LABOUR.1 — every rule the labour-against-revenue block applies. Pure.
// Run under TZ=Europe/Dublin AND TZ=America/Los_Angeles: no month edge,
// elapsed fraction or hour may move with the host's clock.

import { describe, it, expect } from 'vitest'
import {
  labourMonthWindow, labourStudiosFor, canSeeLabour,
  labourShiftRows, labourPct, buildLabourMonth,
  COUNT_UNROSTERED_SALARIES, LABOUR_VIEWER_ROLES,
} from './labour-month-model'

const HOUR = 3_600_000
const ORG = 'org-un1t'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const CARS = 'loc-cars'
const LOCS = [
  { id: STILL, name: 'UN1T Stillorgan', organization_id: ORG },
  { id: HATCH, name: 'UN1T Hatch Street', organization_id: ORG },
  { id: CARS, name: 'CCF Autos', organization_id: 'org-ccf' },
]

describe('labourMonthWindow', () => {
  it('is the Dublin month holding now, with the elapsed fraction in real time', () => {
    // 00:00 Dublin (IST) on Wed 16 Sep 2026 = 23:00 UTC on the 15th.
    const w = labourMonthWindow(Date.UTC(2026, 8, 15, 23, 0))
    expect(w).toMatchObject({
      month: '2026-09', monthLabel: 'September 2026',
      startDate: '2026-09-01', endDate: '2026-09-30',
      daysInMonth: 30, dayOfMonth: 16,
      startMs: Date.UTC(2026, 7, 31, 23, 0), endMs: Date.UTC(2026, 8, 30, 23, 0),
    })
    expect(w.elapsedFraction).toBe(0.5)
  })

  it('takes the Dublin date, not the UTC one, at a month edge', () => {
    // 23:30 UTC on 31 Aug = 00:30 on 1 Sep in Dublin.
    const w = labourMonthWindow(Date.UTC(2026, 7, 31, 23, 30))
    expect(w.month).toBe('2026-09')
    expect(w.dayOfMonth).toBe(1)
  })

  it('is 31 days and one hour long in October 2026 (clocks go back on the 25th)', () => {
    const w = labourMonthWindow(Date.UTC(2026, 9, 10, 12, 0))
    expect(w.endMs - w.startMs).toBe((31 * 24 + 1) * HOUR)
  })

  it('knows February 2027 has 28 days, and crosses a year end', () => {
    expect(labourMonthWindow(Date.UTC(2027, 1, 10, 12)).endDate).toBe('2027-02-28')
    const dec = labourMonthWindow(Date.UTC(2026, 11, 31, 22))
    expect([dec.month, dec.endDate, dec.monthLabel]).toEqual(['2026-12', '2026-12-31', 'December 2026'])
  })

  it('is 0 at the first instant of the month and 1 at its end', () => {
    expect(labourMonthWindow(Date.UTC(2026, 7, 31, 23, 0)).elapsedFraction).toBe(0)
    expect(labourMonthWindow(Date.UTC(2026, 8, 30, 22, 59, 59)).elapsedFraction).toBeCloseTo(1, 5)
  })
})

describe('labourStudiosFor / canSeeLabour (owner only, by role at the studio)', () => {
  const user = (rolesByLocation, over = {}) => ({
    profileRole: 'staff', rolesByLocation, locations: LOCS.slice(0, 2), activeLocation: LOCS[0], ...over,
  })

  it('an owner at both studios sees both, by name', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'owner' }, { profileRole: 'owner' })
    expect(labourStudiosFor(u)).toEqual([
      { id: HATCH, name: 'UN1T Hatch Street' },
      { id: STILL, name: 'UN1T Stillorgan' },
    ])
    expect(canSeeLabour(u)).toBe(true)
  })

  it('an owner at one studio and staff at the other sees only the one', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'staff' }, { profileRole: 'owner' })
    expect(labourStudiosFor(u).map((s) => s.id)).toEqual([STILL])
  })

  it('is not shown while the active studio is one they do not own', () => {
    const u = user({ [STILL]: 'owner', [HATCH]: 'staff' }, { profileRole: 'owner', activeLocation: LOCS[1] })
    expect(canSeeLabour(u)).toBe(false)
  })

  it('a manager sees nothing, even with the Business dashboard granted', () => {
    const u = user({ [STILL]: 'manager', [HATCH]: 'manager' }, { profileRole: 'manager', permissions: { dashboard_business: true } })
    expect(labourStudiosFor(u)).toEqual([])
    expect(canSeeLabour(u)).toBe(false)
  })

  it('a master sees every studio of the active organisation and no other', () => {
    const u = user({}, { profileRole: 'master', locations: LOCS })
    expect(labourStudiosFor(u).map((s) => s.id)).toEqual([HATCH, STILL])
  })

  it('nothing without an active studio', () => {
    expect(labourStudiosFor(user({ [STILL]: 'owner' }, { activeLocation: null }))).toEqual([])
    expect(canSeeLabour(null)).toBe(false)
  })

  it('the viewer set is owners (master passes through hasRoleAtLocation)', () => {
    expect(LABOUR_VIEWER_ROLES).toEqual(['owner'])
  })
})
// ── The money ──────────────────────────────────────────────────────────────
//
// Fixture, worked by hand. NOW = 00:00 Dublin on 16 Sep 2026, so exactly half
// of September has elapsed (15 of 30 days, no clock change in September).
//
//   Alex  (employee, €36,000/yr = €3,000/month): 3h Stillorgan 1 Sep (ended),
//         1h Hatch 20 Sep (upcoming) → 75% / 25% → €2,250 / €750 forecast,
//         half of each so far.
//   Max   (employee, €24,000/yr = €2,000/month): no shifts, belongs to both
//         studios → €1,000 each forecast, €500 each so far.
//   Jordan (contractor, €30/h): 2h ADMIN Stillorgan 2 Sep (ended), 1h 22 Sep
//         (upcoming), 1h on a DRAFT block, 1 cancelled → €90 forecast, €60 so far.
//   Casey (contractor, €27.13/h, DEACTIVATED since): 22:00-24:00 Hatch 3 Sep
//         → 2h → €54.26 forecast and so far.
//   Sam   (employee, no salary): 1h Stillorgan 4 Sep → named, not costed.
//   Olive (employee, no salary, no shifts) → nothing, not named.
//
// Stillorgan: forecast €3,250 + €90 = €3,340 on MRR €10,000 → 33.4%;
//   so far €1,625 + €60 = €1,685 on €5,000 of revenue to date → 33.7%.
// Hatch: forecast €1,750 + €54.26 = €1,804.26; so far €875 + €54.26 = €929.26;
//   no recurring revenue → no ratio.

const NOW = Date.UTC(2026, 8, 15, 23, 0)
const PERIOD = labourMonthWindow(NOW)

let seq = 0
const A = (profile_id, over = {}) => ({
  id: `a${++seq}`, profile_id, start_time_override: null, end_time_override: null, status: 'scheduled', ...over,
})
const B = (location_id, block_date, start_time, end_time, assignments, { published = true, kind = 'class' } = {}) => ({
  id: `b${++seq}`, location_id, block_date, start_time, end_time,
  rosters: published ? { status: 'published' } : { status: 'draft' },
  shift_templates: { start_time, end_time, kind },
  shift_assignments: assignments,
})

const BLOCKS = [
  B(STILL, '2026-09-01', '09:00:00', '12:00:00', [A('p-alex')]),
  B(HATCH, '2026-09-20', '09:00:00', '10:00:00', [A('p-alex')]),
  B(STILL, '2026-09-02', '17:00:00', '19:00:00', [A('p-jordan')], { kind: 'admin' }),
  B(STILL, '2026-09-22', '17:00:00', '18:00:00', [A('p-jordan')]),
  B(STILL, '2026-09-29', '10:00:00', '11:00:00', [A('p-jordan')], { published: false }),
  B(STILL, '2026-09-05', '09:00:00', '10:00:00', [A('p-jordan', { status: 'cancelled' })]),
  B(HATCH, '2026-09-03', '22:00:00', '24:00:00', [A('p-casey')]),
  B(STILL, '2026-09-04', '07:00:00', '08:00:00', [A('p-sam')]),
]

const P = (full_name, employment_type, pay = {}, over = {}) => ({
  full_name, employment_type, active: true, deleted_at: null,
  annual_salary: null, hourly_rate: null, ...pay, ...over,
})
const PEOPLE = new Map([
  ['p-alex', P('Alex Example', 'fte', { annual_salary: 36000 })],
  ['p-max', P('Max Beta', 'fte', { annual_salary: 24000 })],
  ['p-jordan', P('Jordan Sample', 'contractor', { hourly_rate: 30 })],
  ['p-casey', P('Casey Demo', 'contractor', { hourly_rate: 27.13 }, { active: false })],
  ['p-sam', P('Sam Demo', 'fte')],
  ['p-olive', P('Olive Owner', 'fte')],
])
const MEMBERSHIPS = new Map([
  ['p-alex', new Set([STILL, HATCH])],
  ['p-max', new Set([STILL, HATCH])],
  ['p-jordan', new Set([STILL])],
  ['p-sam', new Set([STILL])],
  ['p-olive', new Set([STILL])],
])
const REVENUE = new Map([
  [STILL, { mrrCents: 1_000_000, recurringMembers: 191, yieldCents: 5236 }],
  [HATCH, { mrrCents: 0, recurringMembers: 0, yieldCents: null }],
])
const BOTH = [{ id: STILL, name: 'UN1T Stillorgan' }, { id: HATCH, name: 'UN1T Hatch Street' }]

const build = (over = {}) => buildLabourMonth({
  period: PERIOD, nowMs: NOW, studios: BOTH, rows: labourShiftRows(BLOCKS),
  people: PEOPLE, memberships: MEMBERSHIPS, revenue: REVENUE, ...over,
})
const rowOf = (vm, id) => vm.studios.find((s) => s.location_id === id)

describe('labourShiftRows', () => {
  it('keeps live assignments only, with the published flag and the block times', () => {
    const rows = labourShiftRows(BLOCKS)
    expect(rows).toHaveLength(7) // 8 assignments, one cancelled
    expect(rows.filter((r) => !r.published)).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      profile_id: 'p-alex', location_id: STILL, block_date: '2026-09-01', published: true,
      start_time: '09:00:00', end_time: '12:00:00',
      shift_templates: { start_time: '09:00:00', end_time: '12:00:00' },
    })
  })

  it('a block with no roster is not published', () => {
    const [row] = labourShiftRows([{ ...BLOCKS[0], rosters: null }])
    expect(row.published).toBe(false)
  })
})

describe('labourPct', () => {
  it('one decimal place, and never against no revenue', () => {
    expect(labourPct(334_000, 1_000_000)).toBe(33.4)
    expect(labourPct(0, 1_000_000)).toBe(0)
    expect(labourPct(334_000, 0)).toBe(null)
    expect(labourPct(334_000, null)).toBe(null)
  })
})

describe('buildLabourMonth', () => {
  it('the month header', () => {
    const vm = build()
    expect(vm).toMatchObject({ month: '2026-09', month_label: 'September 2026', day_of_month: 16, days_in_month: 30, untimed_shifts: 0 })
  })

  it('Stillorgan row: salaries by hours and pro-rated, contractors per hour (admin included), ratios on MRR', () => {
    expect(rowOf(build(), STILL)).toEqual({
      location_id: STILL, name: 'UN1T Stillorgan',
      revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
      forecast: { employees_cents: 325_000, contractors_cents: 9_000, cost_cents: 334_000, hours: 7 },
      actual: { employees_cents: 162_500, contractors_cents: 6_000, cost_cents: 168_500, hours: 6 },
      forecast_pct: 33.4, actual_pct: 33.7,
      draft_hours: 1,
    })
  })

  it('Hatch row: labour shown, no revenue tracked, so no ratio; 24:00 is midnight; a deactivated contractor is still paid', () => {
    expect(rowOf(build(), HATCH)).toEqual({
      location_id: HATCH, name: 'UN1T Hatch Street',
      revenue_status: 'none', mrr_cents: null, recurring_members: null, revenue_to_date_cents: null,
      forecast: { employees_cents: 175_000, contractors_cents: 5_426, cost_cents: 180_426, hours: 3 },
      actual: { employees_cents: 87_500, contractors_cents: 5_426, cost_cents: 92_926, hours: 2 },
      forecast_pct: null, actual_pct: null,
      draft_hours: 0,
    })
  })

  it('total: sums every studio shown, ratios over studios with revenue only, and names the rest', () => {
    expect(build().total).toEqual({
      name: 'All studios shown',
      revenue_status: 'tracked', mrr_cents: 1_000_000, recurring_members: 191, revenue_to_date_cents: 500_000,
      forecast: { employees_cents: 500_000, contractors_cents: 14_426, cost_cents: 514_426, hours: 10 },
      actual: { employees_cents: 250_000, contractors_cents: 11_426, cost_cents: 261_426, hours: 8 },
      forecast_pct: 33.4, actual_pct: 33.7,
      draft_hours: 1,
      ratio_excludes: ['UN1T Hatch Street'],
    })
  })

  it('uncosted: someone who worked with no salary is named with their hours; no-one who did not work is', () => {
    expect(build().uncosted).toEqual([{ name: 'Sam Demo', reason: 'no_salary', hours: 1 }])
  })

  it('no pay value, and no pay column name, reaches the view model', () => {
    const json = JSON.stringify(build())
    for (const leak of ['36000', '24000', '27.13', '2713', 'annual_salary', 'hourly_rate', 'overtime_rate']) {
      expect(json).not.toContain(leak)
    }
  })

  it('a single studio shown: no total, and the other studio\'s salary share stays out of it', () => {
    const vm = build({ studios: [BOTH[0]] })
    expect(vm.total).toBe(null)
    expect(vm.studios).toHaveLength(1)
    expect(rowOf(vm, STILL).forecast.cost_cents).toBe(334_000) // the same split as with both shown
  })

  it('an unrostered salary is left out when the owner switch is off', () => {
    expect(COUNT_UNROSTERED_SALARIES).toBe(true)
    const vm = build({ countUnrostered: false })
    expect(rowOf(vm, STILL).forecast.employees_cents).toBe(225_000) // Alex only
    expect(rowOf(vm, HATCH).forecast.employees_cents).toBe(75_000)
  })

  it('revenue that could not be read: labour shown, ratio blank, left out of the total ratio', () => {
    const vm = build({ revenue: new Map([[STILL, null], [HATCH, REVENUE.get(HATCH)]]) })
    expect(rowOf(vm, STILL)).toMatchObject({ revenue_status: 'unavailable', mrr_cents: null, forecast_pct: null, actual_pct: null })
    expect(vm.total).toMatchObject({ revenue_status: 'none', mrr_cents: null, forecast_pct: null, actual_pct: null })
    expect(vm.total.ratio_excludes).toEqual(['UN1T Stillorgan', 'UN1T Hatch Street'])
  })

  it('no "so far" ratio at the first instant of the month (no revenue to date yet)', () => {
    const start = Date.UTC(2026, 7, 31, 23, 0)
    const vm = build({ period: labourMonthWindow(start), nowMs: start })
    expect(rowOf(vm, STILL)).toMatchObject({ revenue_to_date_cents: 0, actual_pct: null, forecast_pct: 33.4 })
  })

  it('a shift in progress counts toward the forecast only', () => {
    const now = Date.UTC(2026, 8, 16, 8, 30) // 09:30 Dublin
    const rows = labourShiftRows([B(STILL, '2026-09-16', '09:00:00', '11:00:00', [A('p-jordan')])])
    const vm = build({ period: labourMonthWindow(now), nowMs: now, rows, memberships: new Map() })
    expect(rowOf(vm, STILL).forecast).toMatchObject({ contractors_cents: 6_000, hours: 2 })
    expect(rowOf(vm, STILL).actual).toMatchObject({ contractors_cents: 0, hours: 0 })
  })

  it('autumn clock change: 00:30-03:30 on 25 Oct 2026 is four real hours', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0)
    const rows = labourShiftRows([B(HATCH, '2026-10-25', '00:30:00', '03:30:00', [A('p-casey')])])
    const vm = build({ period: labourMonthWindow(now), nowMs: now, rows, memberships: new Map() })
    expect(rowOf(vm, HATCH).forecast).toMatchObject({ contractors_cents: 10_852, hours: 4 })
  })

  it('a deactivated employee who worked is named, not salaried', () => {
    const people = new Map([...PEOPLE, ['p-alex', { ...PEOPLE.get('p-alex'), active: false }]])
    const vm = build({ people })
    expect(vm.uncosted).toContainEqual({ name: 'Alex Example', reason: 'inactive_employee', hours: 4 })
    expect(rowOf(vm, STILL).forecast.employees_cents).toBe(100_000) // Max only
  })

  it('a contractor with no rate, an unknown type and a missing profile are named', () => {
    const people = new Map([...PEOPLE,
      ['p-jordan', { ...PEOPLE.get('p-jordan'), hourly_rate: null }],
      ['p-sam', { ...PEOPLE.get('p-sam'), employment_type: null }],
    ])
    people.delete('p-casey')
    const vm = build({ people })
    expect(vm.uncosted).toEqual([
      { name: 'Jordan Sample', reason: 'no_rate', hours: 3 },
      { name: 'Sam Demo', reason: 'unknown_type', hours: 1 },
      { name: 'Unknown person', reason: 'unknown_person', hours: 2 },
    ])
  })

  it('a published shift with no usable times is counted as untimed, never costed', () => {
    const rows = labourShiftRows([{ ...B(STILL, '2026-09-01', null, null, [A('p-jordan')]), shift_templates: null }])
    const vm = build({ rows, memberships: new Map() })
    expect(vm.untimed_shifts).toBe(1)
    expect(rowOf(vm, STILL).forecast.cost_cents).toBe(0)
  })
})
