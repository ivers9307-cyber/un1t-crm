// WORKTIME.1 — working-time advisories for employees: 11 hours between working
// days, 48 hours in a Monday-to-Sunday week, every studio of the organisation.
// Pure: no clock, no database. Run under TZ=Europe/Dublin AND a US zone; the
// rules must not move with the host.

import { describe, it, expect } from 'vitest'
import {
  MIN_REST_HOURS, MAX_WEEK_HOURS, EMPLOYEE_TYPE,
  workingWindow, restGapViolations, weekHoursOver,
  workingTimeAdvisories, candidateWorkingTime,
  hoursMinutesLabel, longWeeksHeadline, restGapsHeadline,
} from './working-time.js'

const HOUR = 60 * 60 * 1000

// One assignment, in the flat shape the reader returns. The block id is
// derived from person + date + start so a test can name it.
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  profile_id,
  block_id: `${profile_id}-${block_date}-${start_time}`,
  block_date,
  start_time,
  end_time,
  location_id: 'loc1',
  location_name: 'Studio North',
  name: 'Class',
  status: 'scheduled',
  ...over,
})

describe('workingWindow', () => {
  it('resolves the window override, then block, then template', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00:00', '12:00:00')))
      .toMatchObject({ profile_id: 'p1', date: '2026-09-22', start: '09:00', end: '12:00' })
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { start_time_override: '10:15', end_time_override: '12:30:00' })))
      .toMatchObject({ start: '10:15', end: '12:30' })
    expect(workingWindow(S('p1', '2026-09-22', null, null, { shift_templates: { start_time: '07:00', end_time: '08:30' } })))
      .toMatchObject({ start: '07:00', end: '08:30' })
  })

  it('is a real instant: 09:00 in September is 08:00 UTC, in November 09:00 UTC', () => {
    const sep = workingWindow(S('p1', '2026-09-22', '09:00', '12:00'))
    expect(sep.startMs).toBe(Date.UTC(2026, 8, 22, 8, 0))
    expect(sep.endMs - sep.startMs).toBe(3 * HOUR)
    expect(workingWindow(S('p1', '2026-11-03', '09:00', '12:00')).startMs).toBe(Date.UTC(2026, 10, 3, 9, 0))
  })

  it('a window through a clock change is its real length (25 Oct 2026 back, 29 Mar 2026 forward)', () => {
    const back = workingWindow(S('p1', '2026-10-25', '00:30', '03:30'))
    expect(back.startMs).toBe(Date.UTC(2026, 9, 24, 23, 30)) // 00:30 IST
    expect(back.endMs - back.startMs).toBe(4 * HOUR)
    const fwd = workingWindow(S('p1', '2026-03-29', '00:30', '03:30'))
    expect(fwd.endMs - fwd.startMs).toBe(2 * HOUR)
  })

  it('an end before the start runs into the next day, and the shift stays on its block date', () => {
    const w = workingWindow(S('p1', '2026-09-22', '22:00', '02:00'))
    expect(w.date).toBe('2026-09-22')
    expect(w.endMs).toBe(Date.UTC(2026, 8, 23, 1, 0)) // 02:00 IST on the 23rd
    expect(w.endMs - w.startMs).toBe(4 * HOUR)
  })

  it('is null for a cancelled row, no person, an unreadable date or time, or zero length', () => {
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '12:00', { status: 'cancelled' }))).toBeNull()
    expect(workingWindow(S(null, '2026-09-22', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '22/09/2026', '09:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '9am', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '25:00', '12:00'))).toBeNull()
    expect(workingWindow(S('p1', '2026-09-22', '09:00', '09:00'))).toBeNull()
    expect(workingWindow(null)).toBeNull()
  })
})
