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
