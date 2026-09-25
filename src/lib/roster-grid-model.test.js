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
