// PAYROLL24.1 — every reader that turns a shift's times into hours reads
// '24:00' the same way: midnight at the END of the block's day.
//
// Before this PR payroll.timeToHours refused hour 24, so payroll, week cost,
// contractor spend, the publish budget gate, invoices and every report counted
// a 22:00-24:00 shift as 0 hours while the Today dashboards (shared/), the
// published-vs-now view and the working-time rules said 2. Five readers, one
// answer; this file fails the day one of them drifts.
//
// Dates avoid the clock changes on purpose: workingWindow measures REAL time,
// so 00:00-24:00 on 25 Oct is 25 hours there (right for rest; not a
// wall-clock parity case).
//
// Lives in src/lib (not shared/) so it is not a bundle path: no OTA.

import { describe, it, expect } from 'vitest'
import { shiftHours } from './payroll'
import { windowHours } from './roster-compare'
import { shiftDurationHours as rosterMonthHours } from '@shared/roster-month'
import { shiftDurationHours as dashboardHours } from '@shared/dashboard-data'
import { workingWindow } from '@shared/working-time'

const DATE = '2026-05-05' // a Tuesday, nowhere near a clock change

function allReaders(start, end) {
  const row = { profile_id: 'p1', block_date: DATE, start_time: start, end_time: end }
  const w = workingWindow(row)
  return {
    payroll: shiftHours(row),
    rosterMonth: rosterMonthHours(row),
    dashboard: dashboardHours(row),
    compare: windowHours({ start, end }),
    workingTime: w ? (w.endMs - w.startMs) / 3_600_000 : null,
  }
}

describe('every hours reader agrees on a 24:00 end (PAYROLL24.1)', () => {
  const CASES = [
    ['22:00', '24:00', 2],
    ['22:00:00', '24:00:00', 2],
    ['18:30:00', '24:00:00', 5.5],
    ['00:00', '24:00', 24],
    ['22:00', '00:00', 2], // the other spelling of the same midnight
    ['06:00:00', '07:30:00', 1.5], // an ordinary shift, as a control
  ]

  for (const [start, end, hours] of CASES) {
    it(`${start}-${end} is ${hours}h everywhere`, () => {
      expect(allReaders(start, end)).toEqual({
        payroll: hours, rosterMonth: hours, dashboard: hours, compare: hours, workingTime: hours,
      })
    })
  }

  // Decision D4. A 24:00 START (only reachable through a hand-written override:
  // shift_blocks_time_order forbids it on a block) is that same midnight in
  // payroll, both shared/ readers and roster-compare. workingWindow alone calls
  // it untimed, and the screens that use it say "not counted" rather than 0.
  // If workingWindow is ever aligned (an OTA), fold this into CASES.
  it('KNOWN_DIFFERENCE: a 24:00 start is 2h everywhere except workingWindow, which calls it untimed', () => {
    expect(allReaders('24:00', '02:00')).toEqual({
      payroll: 2, rosterMonth: 2, dashboard: 2, compare: 2, workingTime: null,
    })
  })
})
