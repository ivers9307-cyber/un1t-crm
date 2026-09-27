// ATTENDREPORT.1 (follow-ups C4) — the attendance report's rules. The route
// (src/app/api/attendance/route.js) only reads; everything it answers is
// decided here. Fixtures are 15 Jul 2026 (BST, UTC+1) unless a test says
// otherwise. No real names: the repo is public.

import { describe, it, expect } from 'vitest'
import {
  buildAttendanceReport, parseAttendanceQuery, defaultAttendancePeriod,
  attendanceCsv, ATTENDANCE_CSV_HEADER, DEFAULT_WINDOW_DAYS,
} from './attendance-report'
import { compareSnapshot } from './roster-compare'

function asg(id, { date = '2026-07-15', start = '07:00:00', end = '08:00:00', profileId = 'p-a', name = 'Coach A', ...rest } = {}) {
  return {
    id, profile_id: profileId, status: 'scheduled', arrived_at: null, arrival_source: null,
    start_time_override: null, end_time_override: null,
    block: { id: `blk-${id}`, location_id: 'loc1', block_date: date, start_time: start, end_time: end },
    profile: { id: profileId, full_name: name, email: null, role: 'staff' },
    ...rest,
  }
}
function report(assignments, { now = '2026-07-15T12:00:00Z', tz = 'Europe/Dublin', events = [] } = {}) {
  return buildAttendanceReport({ assignments, events, tz, nowMs: Date.parse(now) })
}
const rowOf = (res, id) => res.rows.find((r) => r.assignment_id === id)

describe("lateness is judged from the coach's effective start (D1)", () => {
  it('a later adjusted start: 07:50 is 10 minutes early, not 50 late', () => {
    const res = report([asg('a1', { end: '10:00:00', start_time_override: '08:00:00', arrived_at: '2026-07-15T06:50:00Z' })])
    expect(rowOf(res, 'a1')).toMatchObject({
      status: 'on_time', minutes_late: -10,
      scheduled_at: '2026-07-15T07:00:00.000Z',
      scheduled_start: '07:00:00', effective_start: '08:00:00', start_adjusted: true,
      paid_start_override: '08:00:00', actual_start: '07:50:00',
    })
  })

  it('an earlier adjusted start: 06:45 is 15 late', () => {
    const res = report([asg('a1', { start_time_override: '06:30:00', arrived_at: '2026-07-15T05:45:00Z' })])
    expect(rowOf(res, 'a1')).toMatchObject({ status: 'late', minutes_late: 15, scheduled_at: '2026-07-15T05:30:00.000Z' })
  })

  it('no override: the block start, with the 60s grace', () => {
    expect(rowOf(report([asg('a1', { arrived_at: '2026-07-15T06:00:20Z' })]), 'a1'))
      .toMatchObject({ status: 'on_time', minutes_late: 0, start_adjusted: false, effective_start: '07:00:00' })
    expect(rowOf(report([asg('a1', { arrived_at: '2026-07-15T06:02:00Z' })]), 'a1'))
      .toMatchObject({ status: 'late', minutes_late: 2 })
  })

  it('an override equal to the block start is not adjusted', () => {
    expect(rowOf(report([asg('a1', { start_time_override: '07:00' })]), 'a1').start_adjusted).toBe(false)
  })

  it('the override is never an arrival', () => {
    expect(rowOf(report([asg('a1', { start_time_override: '07:30:00' })]), 'a1'))
      .toMatchObject({ arrival_at: null, actual_start: null, status: 'no_show', minutes_late: null })
  })
})

describe('pending and no-show use the effective end (D2)', () => {
  it('an extended end keeps it pending', () => {
    const a = asg('a1', { end_time_override: '09:00:00' })
    expect(rowOf(report([a], { now: '2026-07-15T07:30:00Z' }), 'a1').status).toBe('pending')
    expect(rowOf(report([a], { now: '2026-07-15T08:01:00Z' }), 'a1').status).toBe('no_show')
  })

  it('an override end after midnight wraps to the next day', () => {
    const a = asg('a1', { start: '20:00:00', end: '21:00:00', end_time_override: '00:30:00' })
    expect(rowOf(report([a], { now: '2026-07-15T22:59:00Z' }), 'a1')).toMatchObject({ status: 'pending', effective_end: '00:30:00' })
    expect(rowOf(report([a], { now: '2026-07-15T23:31:00Z' }), 'a1').status).toBe('no_show')
  })
})

// Two fixtures where the block rule and an effective-window rule disagree.
const CARRY_BLOCK_NOT_EFFECTIVE = [
  asg('a1', { start: '07:00:00', end: '08:00:00', end_time_override: '07:30:00', arrived_at: '2026-07-15T05:55:00Z' }),
  asg('a2', { start: '08:45:00', end: '09:45:00' }), // 45 min after the BLOCK end, 75 after the adjusted end
]
const CARRY_EFFECTIVE_NOT_BLOCK = [
  asg('a1', { start: '07:00:00', end: '08:00:00', arrived_at: '2026-07-15T05:55:00Z' }),
  asg('a2', { start: '09:30:00', end: '10:30:00', start_time_override: '08:30:00' }), // 90 min after by block, 30 by override
]

describe('the back-to-back carry stays on block times (D3)', () => {
  it('the block gap carries even when the adjusted end would not', () => {
    expect(rowOf(report(CARRY_BLOCK_NOT_EFFECTIVE), 'a2')).toMatchObject({
      arrival_inferred: true, status: 'on_time', minutes_late: null, actual_start: '06:55:00',
    })
  })

  it('the adjusted start does not create a carry the block gap would not', () => {
    expect(rowOf(report(CARRY_EFFECTIVE_NOT_BLOCK), 'a2')).toMatchObject({ arrival_inferred: false, status: 'no_show' })
  })

  it('the compare view agrees on the same fixtures', () => {
    // roster-compare.js measures the carry "as the attendance report does".
    // Feed it the same rows as live blocks and compare arrival_inferred.
    function compareInferred(assignments) {
      const blocks = new Map()
      for (const a of assignments) {
        const b = a.block
        if (!blocks.has(b.id)) {
          blocks.set(b.id, {
            id: b.id, template_id: `t-${b.id}`, block_date: b.block_date, start_time: b.start_time, end_time: b.end_time,
            min_coaches: 1, max_coaches: 1, briefing: null, shift_templates: { name: 'Class', kind: 'class' }, shift_assignments: [],
          })
        }
        blocks.get(b.id).shift_assignments.push({
          id: a.id, profile_id: a.profile_id, status: a.status, arrived_at: a.arrived_at,
          start_time_override: a.start_time_override, end_time_override: a.end_time_override,
          profiles: { full_name: a.profile.full_name },
        })
      }
      const out = compareSnapshot({
        snapshot: { v: 1, period_start: '2026-07-15', period_end: '2026-07-15', blocks: [] },
        currentBlocks: [...blocks.values()],
        nowMs: Date.parse('2026-07-15T12:00:00Z'),
        tz: 'Europe/Dublin',
      })
      const map = {}
      for (const b of out.blocks) for (const c of b.coaches) map[`${b.date} ${b.current.start}`] = c.arrival_inferred
      return map
    }
    for (const fixture of [CARRY_BLOCK_NOT_EFFECTIVE, CARRY_EFFECTIVE_NOT_BLOCK]) {
      const mine = Object.fromEntries(report(fixture).rows.map((r) => [`${r.block_date} ${r.scheduled_start.slice(0, 5)}`, r.arrival_inferred]))
      expect(mine).toEqual(compareInferred(fixture))
    }
  })
})

describe('clock changes and zones (D5, D9)', () => {
  it('the spring-forward day (BST)', () => {
    const r = rowOf(report([asg('a1', { date: '2026-03-29', arrived_at: '2026-03-29T06:00:20Z' })], { now: '2026-03-29T12:00:00Z' }), 'a1')
    expect(r).toMatchObject({ scheduled_at: '2026-03-29T06:00:00.000Z', status: 'on_time', minutes_late: 0 })
  })

  it('the clocks-back day (GMT), with an adjusted start', () => {
    const r = rowOf(report([asg('a1', { date: '2026-10-25', end: '10:00:00', start_time_override: '08:00:00', arrived_at: '2026-10-25T08:05:00Z' })],
      { now: '2026-10-25T12:00:00Z' }), 'a1')
    expect(r).toMatchObject({ scheduled_at: '2026-10-25T08:00:00.000Z', status: 'late', minutes_late: 5, actual_start: '08:05:00' })
  })

  it('a Los Angeles studio, including its change day', () => {
    const tz = 'America/Los_Angeles'
    expect(rowOf(report([asg('a1', { arrived_at: '2026-07-15T14:03:00Z' })], { tz, now: '2026-07-15T20:00:00Z' }), 'a1'))
      .toMatchObject({ scheduled_at: '2026-07-15T14:00:00.000Z', minutes_late: 3, actual_start: '07:03:00' })
    expect(rowOf(report([asg('a1', { date: '2026-03-08', arrived_at: '2026-03-08T13:58:00Z' })], { tz, now: '2026-03-08T20:00:00Z' }), 'a1'))
      .toMatchObject({ scheduled_at: '2026-03-08T14:00:00.000Z', status: 'on_time', minutes_late: -2 })
  })

  it('an unknown timezone falls back to Dublin, never UTC', () => {
    expect(rowOf(report([asg('a1')], { tz: null }), 'a1').scheduled_at).toBe('2026-07-15T06:00:00.000Z')
  })
})

describe('rows, sources and the summary', () => {
  it('sources are the matched events plus the row\'s own arrival_source, sorted', () => {
    const a = asg('a1', { arrived_at: '2026-07-15T05:58:00Z', arrival_source: 'geofence' })
    const res = report([a], { events: [
      { matched_assignment_id: 'a1', source: 'unifi_access' },
      { matched_assignment_id: 'a1', source: 'geofence' },
      { matched_assignment_id: 'other', source: 'protect' },
    ] })
    expect(rowOf(res, 'a1').sources).toEqual(['geofence', 'unifi_access'])
    expect(rowOf(report([asg('a2')]), 'a2').sources).toEqual([])
  })

  it('rows: newest day first, then effective start, then name', () => {
    const res = report([
      asg('a1', { date: '2026-07-14', start: '07:00:00' }),
      asg('a2', { date: '2026-07-15', start: '09:00:00' }),
      asg('a3', { date: '2026-07-15', start: '07:00:00', profileId: 'p-b', name: 'Coach B' }),
      asg('a4', { date: '2026-07-15', start: '07:00:00' }),
      asg('a5', { date: '2026-07-15', start: '10:00:00', end: '11:00:00', start_time_override: '06:30:00' }),
    ], { now: '2026-07-16T12:00:00Z' })
    expect(res.rows.map((r) => r.assignment_id)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1'])
  })

  it('a row without a block is left out, and the summary counts what is shown', () => {
    const res = report([
      asg('a1', { arrived_at: '2026-07-15T05:58:00Z' }),
      asg('a2', { arrived_at: '2026-07-15T06:10:00Z' }),
      asg('a3', { profileId: 'p-b', name: 'Coach B' }), // another coach: nothing to carry onto it
      asg('a4', { date: '2026-07-16' }),
      { ...asg('a5'), block: null },
    ])
    expect(res.rows).toHaveLength(4)
    expect(res.summary).toEqual({ total: 4, on_time: 1, late: 1, no_show: 1, pending: 1 })
  })
})

describe('parseAttendanceQuery (D6)', () => {
  const q = (s) => parseAttendanceQuery(new URLSearchParams(s), '2026-07-15')
  const UUID = 'b0000000-0000-0000-0000-000000000001'

  it('defaults to the 14 days before today and today', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(14)
    expect(q('')).toEqual({ from: '2026-07-01', to: '2026-07-15', profileId: null })
    expect(q('from=&to=')).toEqual({ from: '2026-07-01', to: '2026-07-15', profileId: null })
  })

  it('a `to` alone moves the default `from` with it; a `from` alone ends today', () => {
    expect(q('to=2026-06-30')).toMatchObject({ from: '2026-06-16', to: '2026-06-30' })
    expect(q('from=2026-07-10')).toMatchObject({ from: '2026-07-10', to: '2026-07-15' })
  })

  it('refuses a date the calendar does not have, or the wrong shape', () => {
    for (const s of ['from=2026-02-30&to=2026-03-06', 'from=2026-04-01&to=2026-04-31', 'from=2026-13-01&to=2026-13-02',
      'from=2026-7-01&to=2026-07-15', 'to=2026-02-30', 'to=nope']) {
      expect(q(s)).toEqual({ error: 'from and to must be real dates, YYYY-MM-DD' })
    }
  })

  it('refuses a reversed period and more than 366 days', () => {
    expect(q('from=2026-07-15&to=2026-07-01')).toEqual({ error: 'to must be on or after from' })
    expect(q('from=2026-01-01&to=2027-01-02')).toEqual({ error: 'A report can cover at most 366 days' })
    expect(q('from=2026-01-01&to=2027-01-01')).toMatchObject({ from: '2026-01-01', to: '2027-01-01' })
  })

  it('takes one coach by UUID and refuses anything else', () => {
    expect(q(`profile_id=${UUID}`).profileId).toBe(UUID)
    expect(q('profile_id=abc')).toEqual({ error: 'profile_id must be a UUID' })
  })
})

describe("the page's default period and CSV (D6, D10)", () => {
  it('defaultAttendancePeriod counts back across a month end', () => {
    expect(defaultAttendancePeriod('2026-03-01')).toEqual({ from: '2026-02-15', to: '2026-03-01' })
  })

  it('the CSV leads with the effective start and keeps the rostered one beside it', () => {
    const res = report([
      asg('a1', { end: '10:00:00', start_time_override: '08:00:00', arrived_at: '2026-07-15T06:50:00Z', name: 'Coach, A' }),
      asg('a2', { start: '08:45:00', end: '09:45:00', profileId: 'p-b', name: 'Coach B' }),
    ])
    const lines = attendanceCsv(res.rows).split('\n')
    expect(lines[0]).toBe(ATTENDANCE_CSV_HEADER.join(','))
    expect(ATTENDANCE_CSV_HEADER).toEqual(['Date', 'Staff', 'Role', 'Scheduled start', 'Rostered start', 'Actual start', 'On site (inferred)', 'Status', 'Minutes late'])
    expect(lines).toContain('2026-07-15,"Coach, A",staff,08:00:00,07:00:00,07:50:00,,on_time,-10')
    expect(lines).toContain('2026-07-15,Coach B,staff,08:45:00,08:45:00,,,no_show,')
  })
})
