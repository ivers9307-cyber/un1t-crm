// src/lib/roster-grid-model.test.js
// GRID.1 — every decision the coach-by-day grid makes, pure. Run under
// TZ=Europe/Dublin AND America/Los_Angeles: no day, total or balance may move
// with the host's clock.

import { describe, it, expect } from 'vitest'
import {
  ROSTER_LAYOUTS, DEFAULT_ROSTER_LAYOUT, rosterLayoutStorageKey, loadRosterLayout, saveRosterLayout,
  gridWeekDays, buildRosterGrid, adminBalanceLabel, restGapTitle, untimedLabel, GRID_COPY,
} from './roster-grid-model'

const HERE = 'loc-north'
const SOUTH = 'loc-south'
const WEEK = '2026-09-21' // a Monday

// One shift in GET /api/schedule/grid's flat shape.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  assignment_id: `${profile_id}-${block_date}-${start_time}`,
  profile_id,
  block_id: `b-${profile_id}-${block_date}-${start_time}`,
  block_date,
  location_id: HERE,
  location_name: 'Studio North',
  here: true,
  kind: 'class',
  name: 'Strength',
  status: 'scheduled',
  start_time,
  end_time,
  start_time_override: null,
  end_time_override: null,
  shift_templates: { start_time, end_time },
  ...over,
})
const SOUTH_SHIFT = { location_id: SOUTH, location_name: 'Studio South', here: false }
const M = (profile_id, full_name, employment_type, contracted_hours, over = {}) => ({
  profile_id, full_name, employment_type, contracted_hours, member: true, ...over,
})

// The main fixture (Tasks 2-4). Every sum is worked out in the test that uses it.
const MEMBERS = [
  M('p-emp', 'Alex Example', 'fte', 39),
  M('p-con', 'Jordan Sample', 'contractor', null),
  M('p-over', 'Max Beta', 'fte', 1),
  M('p-nocon', 'Sam Demo', 'fte', null),
  M('p-gone', 'Toby Beta', 'fte', 20, { member: false }),
]
const SHIFTS = [
  S('p-emp', '2026-09-21', '09:00:00', '12:00:00'),
  S('p-emp', '2026-09-21', '06:30:00', '07:30:00'),
  S('p-emp', '2026-09-22', '18:00:00', '20:00:00', { ...SOUTH_SHIFT, name: 'Evening' }),
  S('p-emp', '2026-09-23', '13:00:00', '14:30:00', { kind: 'admin', name: 'Front desk' }),
  S('p-emp', '2026-09-25', '12:00:00', '13:00:00'),
  S('p-emp', '2026-09-20', '10:00:00', '11:00:00'), // the Sunday before: rest gaps only
  S('p-emp', '2026-09-28', '10:00:00', '11:00:00'), // the Monday after: likewise
  S('p-emp', '2026-09-24', '09:00:00', '10:00:00', { status: 'cancelled' }),
  S('p-con', '2026-09-24', '17:00:00', '18:00:00'),
  S('p-over', '2026-09-25', '06:00:00', '07:30:00'),
  S('p-nocon', '2026-09-24', '07:00:00', '08:00:00'),
  S('p-nocon', '2026-09-26', null, null),
  S('p-gone', '2026-09-22', '10:00:00', '11:00:00'),
]
const GRID = { week_start: WEEK, week_end: '2026-09-27', members: MEMBERS, shifts: SHIFTS, cross_studio_checked: true }
const rowOf = (model, id) => model.rows.find((r) => r.profile_id === id)

describe('gridWeekDays', () => {
  it('is the Monday-to-Sunday week holding any day of it', () => {
    const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    expect(gridWeekDays('2026-09-24')).toEqual(week)
    expect(gridWeekDays('2026-09-21')).toEqual(week)
    expect(gridWeekDays('2026-09-27')).toEqual(week)
  })

  it('crosses a month and a year end', () => {
    expect(gridWeekDays('2026-12-31')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
  })

  it('has seven days in both clock-change weeks (Sun 29 Mar and Sun 25 Oct 2026)', () => {
    expect(gridWeekDays('2026-03-29')).toEqual(['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29'])
    expect(gridWeekDays('2026-10-25')).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])
  })

  it('is empty for a date the calendar does not have', () => {
    expect(gridWeekDays('2026-02-30')).toEqual([])
    expect(gridWeekDays('24/09/2026')).toEqual([])
    expect(gridWeekDays(null)).toEqual([])
  })
})

describe('roster layout preference', () => {
  const store = () => {
    const m = new Map()
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } }
  }

  it('is kept per viewer', () => {
    expect(rosterLayoutStorageKey('u1')).toBe('un1t.schedule.layout.u1')
    expect(rosterLayoutStorageKey(null)).toBe('un1t.schedule.layout.anon')
  })

  it('is Days when nothing, or junk, is stored, or there is no storage at all', () => {
    const s = store()
    expect(loadRosterLayout(s, 'u1')).toBe('days')
    s.setItem('un1t.schedule.layout.u1', 'month')
    expect(loadRosterLayout(s, 'u1')).toBe('days')
    expect(loadRosterLayout(null, 'u1')).toBe('days')
    expect(DEFAULT_ROSTER_LAYOUT).toBe('days')
    expect(ROSTER_LAYOUTS).toEqual(['days', 'coaches'])
  })

  it('reads back what was saved, for that viewer only', () => {
    const s = store()
    expect(saveRosterLayout(s, 'u1', 'coaches')).toBe(true)
    expect(loadRosterLayout(s, 'u1')).toBe('coaches')
    expect(loadRosterLayout(s, 'u2')).toBe('days')
  })

  it('never throws: storage that refuses reads is Days, and a refused save answers false', () => {
    const refusing = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
    }
    expect(loadRosterLayout(refusing, 'u1')).toBe('days')
    expect(saveRosterLayout(refusing, 'u1', 'coaches')).toBe(false)
    expect(saveRosterLayout(null, 'u1', 'coaches')).toBe(false)
  })

  it('refuses to save a layout that does not exist', () => {
    const s = store()
    expect(saveRosterLayout(s, 'u1', 'month')).toBe(false)
    expect(s.m.size).toBe(0)
  })
})

describe('buildRosterGrid — rows, cells and week totals', () => {
  const build = () => buildRosterGrid({ weekStart: WEEK, grid: GRID })

  it('one row per person: the team by name, then anyone no longer on it', () => {
    const g = build()
    expect(g.days).toEqual(gridWeekDays(WEEK))
    expect(g.rows.map((r) => r.full_name)).toEqual(['Alex Example', 'Jordan Sample', 'Max Beta', 'Sam Demo', 'Toby Beta'])
    expect(g.rows.map((r) => r.member)).toEqual([true, true, true, true, false])
    expect(g.checked).toBe(true)
  })

  it("a cell holds this studio's shifts as chips, earliest first, and the other studio's as markers", () => {
    const [mon, tue, wed] = rowOf(build(), 'p-emp').cells
    expect(mon.date).toBe('2026-09-21')
    expect(mon.here.map((c) => c.time)).toEqual(['6:30–7:30am', '9am–12pm'])
    expect(mon.here[1]).toMatchObject({
      block_id: 'b-p-emp-2026-09-21-09:00:00', here: true, kind: 'class', name: 'Strength', minutes: 180,
    })
    expect(mon.elsewhere).toEqual([])
    expect(tue.here).toEqual([])
    expect(tue.elsewhere).toHaveLength(1)
    expect(tue.elsewhere[0]).toMatchObject({ here: false, location_name: 'Studio South', name: 'Evening', time: '6–8pm', minutes: 120 })
    expect(wed.here[0]).toMatchObject({ kind: 'admin', name: 'Front desk', time: '1–2:30pm', minutes: 90 })
  })

  it('the week total is every studio together, split into here, elsewhere, class and placed admin', () => {
    // Class: 60 + 180 (Mon) + 120 (Tue, Studio South) + 60 (Fri) = 420. Admin: 90 (Wed).
    expect(rowOf(build(), 'p-emp').totals).toEqual({
      minutes: 510, here_minutes: 390, elsewhere_minutes: 120, class_minutes: 420, admin_minutes: 90, untimed: 0,
    })
  })

  it('only the seven days count: the Sunday before and the Monday after are never shown or totalled', () => {
    const chips = rowOf(build(), 'p-emp').cells.flatMap((c) => [...c.here, ...c.elsewhere])
    expect(chips.map((c) => c.date).sort()).toEqual(['2026-09-21', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-25'])
  })

  it('a cancelled assignment is not a shift', () => {
    expect(rowOf(build(), 'p-emp').cells[3].here).toEqual([])
  })

  it('a shift with no usable times is shown, not counted, and counted as untimed', () => {
    const g = build()
    const sam = rowOf(g, 'p-nocon')
    expect(sam.cells[5].here).toHaveLength(1)
    expect(sam.cells[5].here[0]).toMatchObject({ minutes: null, time: 'No times' })
    expect(sam.totals.minutes).toBe(60)
    expect(sam.totals.untimed).toBe(1)
    expect(g.untimed).toBe(1)
    expect(untimedLabel(1)).toBe('1 shift without times, not counted')
    expect(untimedLabel(2)).toBe('2 shifts without times, not counted')
  })

  it('the effective window counts: an override beats the block (a geofence arrival included)', () => {
    const g = buildRosterGrid({
      weekStart: WEEK,
      grid: { ...GRID, members: [M('p1', 'Alex Example', 'fte', 10)], shifts: [S('p1', WEEK, '09:00:00', '12:00:00', { start_time_override: '09:40:00' })] },
    })
    expect(g.rows[0].totals.minutes).toBe(140)
    expect(g.rows[0].cells[0].here[0].time).toBe('9:40am–12pm')
  })

  it('other studios unread: checked is false, so nobody reads the totals as complete', () => {
    expect(buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, cross_studio_checked: false } }).checked).toBe(false)
    expect(GRID_COPY.crossStudioUnchecked).toMatch(/this studio only/)
    expect(GRID_COPY.leaveMissing).toMatch(/nobody is shown on leave/)
    expect(GRID_COPY.availabilityMissing).toMatch(/nobody is shown as unavailable/)
  })

  it('nothing to build: no grid, a malformed one, or a date the calendar does not have', () => {
    expect(buildRosterGrid({ weekStart: WEEK, grid: null })).toEqual({ days: gridWeekDays(WEEK), rows: [], checked: false, untimed: 0 })
    expect(buildRosterGrid({ weekStart: WEEK, grid: { members: 'x', shifts: [] } }).rows).toEqual([])
    expect(buildRosterGrid({ weekStart: '2026-02-30', grid: GRID }).rows).toEqual([])
  })
})

describe('buildRosterGrid — the clock-change weeks', () => {
  it('autumn (Sun 25 Oct 2026): Sunday is in the week, a normal shift is its length, a shift over the change its REAL length', () => {
    const g = buildRosterGrid({
      weekStart: '2026-10-21',
      grid: {
        ...GRID,
        members: [M('p1', 'Alex Example', 'fte', 40)],
        shifts: [
          S('p1', '2026-10-25', '09:00:00', '12:00:00'),
          S('p1', '2026-10-25', '00:30:00', '03:30:00'), // 00:30 IST to 03:30 GMT: four real hours
          S('p1', '2026-10-26', '09:00:00', '10:00:00'), // the Monday after: not this week
        ],
      },
    })
    expect(g.days[0]).toBe('2026-10-19')
    expect(g.days[6]).toBe('2026-10-25')
    expect(g.rows[0].cells[6].here.map((c) => c.minutes)).toEqual([240, 180])
    expect(g.rows[0].totals.minutes).toBe(420)
  })

  it('spring (Sun 29 Mar 2026): the short night is two real hours', () => {
    const g = buildRosterGrid({
      weekStart: '2026-03-23',
      grid: {
        ...GRID,
        members: [M('p1', 'Alex Example', 'fte', 40)],
        shifts: [S('p1', '2026-03-29', '09:00:00', '12:00:00'), S('p1', '2026-03-29', '00:30:00', '03:30:00')],
      },
    })
    expect(g.days[6]).toBe('2026-03-29')
    expect(g.rows[0].cells[6].here.map((c) => c.minutes)).toEqual([120, 180])
    expect(g.rows[0].totals.minutes).toBe(300)
  })
})

describe('admin balance: contract − class − placed admin, employees only, hours only', () => {
  const build = () => buildRosterGrid({ weekStart: WEEK, grid: GRID })
  const one = (member, shifts = []) => buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, members: [member], shifts } }).rows[0]

  it('an employee under contract has the rest to place, every studio counted', () => {
    const alex = rowOf(build(), 'p-emp')
    expect(alex.isEmployee).toBe(true)
    expect(alex.contractMinutes).toBe(2340)
    // 2340 − 420 class − 90 placed admin = 1830.
    expect(alex.balance).toEqual({ minutes: 1830, state: 'to_place' })
    expect(adminBalanceLabel(alex)).toEqual({
      text: '30h 30m',
      tone: 'to_place',
      srText: '30h 30m of admin to place',
      title: '39h contract − 7h class − 1h 30m placed admin = 30h 30m to place',
    })
  })

  it('over contract is a negative balance, shown with a minus and said in words', () => {
    const max = rowOf(build(), 'p-over')
    expect(max.balance).toEqual({ minutes: -30, state: 'over' })
    expect(adminBalanceLabel(max)).toEqual({
      text: '−30m',
      tone: 'over',
      srText: '30m over contract',
      title: '1h contract − 1h 30m class − 0m placed admin = 30m over contract',
    })
  })

  it('exactly on contract is met, and a half-hour contract is kept to the minute', () => {
    const met = one(M('p1', 'Alex Example', 'fte', 1.5), [S('p1', WEEK, '09:00:00', '10:30:00')])
    expect(met.balance).toEqual({ minutes: 0, state: 'met' })
    expect(adminBalanceLabel(met)).toMatchObject({ text: '0h', tone: 'met', srText: 'contract met' })
    const half = one(M('p1', 'Alex Example', 'fte', '37.5'))
    expect(half.contractMinutes).toBe(2250)
    expect(adminBalanceLabel(half).text).toBe('37h 30m')
  })

  it('an employee with no contracted hours (null or 0) has no balance, and says why', () => {
    const sam = rowOf(build(), 'p-nocon')
    expect(sam.balance).toBeNull()
    expect(adminBalanceLabel(sam)).toMatchObject({ text: 'No contract hours', tone: 'none' })
    const zero = one(M('p1', 'Alex Example', 'fte', 0))
    expect(zero.contractMinutes).toBeNull()
    expect(zero.balance).toBeNull()
  })

  it('a contractor never has a balance, even if hours were sent', () => {
    expect(adminBalanceLabel(rowOf(build(), 'p-con'))).toMatchObject({ text: 'Contractor', tone: 'none' })
    const sent = one(M('p1', 'Jordan Sample', 'contractor', 40))
    expect(sent.isEmployee).toBe(false)
    expect(sent.contractMinutes).toBeNull()
    expect(sent.balance).toBeNull()
  })

  it('an unreadable employment type is neither: no contract, no balance, a dash', () => {
    const x = one(M('p1', 'Alex Example', null, 39))
    expect(x.isEmployee).toBe(false)
    expect(x.balance).toBeNull()
    expect(adminBalanceLabel(x).text).toBe('—')
  })

  it('someone no longer on the team keeps a balance for the week they were rostered', () => {
    // 1200 − 60 = 1140.
    expect(rowOf(build(), 'p-gone').balance).toEqual({ minutes: 1140, state: 'to_place' })
  })
})
