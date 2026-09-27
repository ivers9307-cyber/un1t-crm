// src/lib/contractor-invoices-scheduled.test.js
// INVOICEHOURS.1 — the contractor invoice review's "scheduled hours": live
// assignments on PUBLISHED rosters only (the LABOUR.1 rule), hours by payroll's
// shiftHours, unpublished hours tallied apart. Pure string arithmetic, so every
// case runs under Dublin and a US zone.

import { describe, it, expect, afterEach } from 'vitest'
import { scheduledFromAssignments } from './contractor-invoices'
import { shiftHours, timeToHours } from './payroll'

const realTz = process.env.TZ
afterEach(() => { process.env.TZ = realTz })

// One shift_assignments row as the read returns it: the assignment's own
// fields plus its block, the block's roster status and its template times.
function row({
  status = 'scheduled', roster = 'published', date = '2026-10-12',
  start = '09:00:00', end = '17:00:00', so = null, eo = null,
  tpl = { start_time: '09:00:00', end_time: '17:00:00' },
} = {}) {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    status,
    start_time_override: so,
    end_time_override: eo,
    shift_blocks: {
      block_date: date,
      start_time: start,
      end_time: end,
      location_id: 'locA',
      rosters: roster == null ? null : { status: roster },
      shift_templates: tpl,
    },
  }
}

// PAYROLL24.1 (A1) teaches timeToHours that '24:00' is midnight. Until it is
// on main, '24:00' reads as 0 h in payroll AND here (D5: the review never
// disagrees with payroll); the "2 h" case switches itself on when A1 lands.
const payrollKnowsMidnight = timeToHours('24:00') === 24

for (const tz of ['Europe/Dublin', 'America/Los_Angeles']) {
  describe(`scheduledFromAssignments (TZ=${tz})`, () => {
    it('counts live assignments on a published roster, override first', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ so: '09:00:00', eo: '13:00:00' }),                    // 4h (override)
        row({ start: '07:00:00', end: '08:30:00', tpl: null }),     // 1.5h (block's own time)
      ])
      expect(out).toEqual({
        scheduled_hours: 5.5, shift_count: 2,
        unpublished_hours: 0, unpublished_shift_count: 0,
      })
    })

    it('a cancelled assignment counts nowhere', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ status: 'cancelled' }),
        row({ status: 'cancelled', roster: 'draft' }),
      ])
      expect(out).toEqual({
        scheduled_hours: 0, shift_count: 0,
        unpublished_hours: 0, unpublished_shift_count: 0,
      })
    })

    it('a swapped shift counts for the contractor who holds it', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ status: 'swapped', start: '18:00:00', end: '19:00:00', tpl: null })])
      expect(out.scheduled_hours).toBe(1)
      expect(out.shift_count).toBe(1)
    })

    it('a legacy row with no status counts', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ status: null })])
      expect(out.scheduled_hours).toBe(8)
    })

    it('no roster, draft and superseded are not scheduled; their hours are tallied apart', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([
        row({ roster: null, start: '09:00:00', end: '10:00:00', tpl: null }),
        row({ roster: 'draft', start: '10:00:00', end: '11:00:00', tpl: null }),
        row({ roster: 'superseded', start: '11:00:00', end: '12:30:00', tpl: null }),
        row({ start: '13:00:00', end: '15:00:00', tpl: null }),     // published, 2h
      ])
      expect(out).toEqual({
        scheduled_hours: 2, shift_count: 1,
        unpublished_hours: 3.5, unpublished_shift_count: 3,
      })
    })

    it('an admin shift counts (contractors invoice it)', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({
        start: '08:00:00', end: '12:00:00',
        tpl: { start_time: '08:00:00', end_time: '12:00:00', kind: 'admin' },
      })])
      expect(out.scheduled_hours).toBe(4)
    })

    it('a shift ending 24:00 is priced exactly as payroll prices it (D5)', () => {
      process.env.TZ = tz
      const r = row({ start: '22:00:00', end: '24:00:00', tpl: null })
      const out = scheduledFromAssignments([r])
      expect(out.scheduled_hours).toBe(shiftHours({
        start_time: '22:00:00', end_time: '24:00:00', shift_templates: {},
      }))
    })

    it.runIf(payrollKnowsMidnight)('22:00-24:00 is 2 h (needs A1 PAYROLL24.1)', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([row({ start: '22:00:00', end: '24:00:00', tpl: null })])
      expect(out.scheduled_hours).toBe(2)
    })

    it('the October clock change: a day shift is its wall-clock length, and so is a night one (D5)', () => {
      process.env.TZ = tz
      // Clocks go back 02:00 -> 01:00 on Sunday 25 Oct 2026.
      expect(scheduledFromAssignments([row({ date: '2026-10-25' })]).scheduled_hours).toBe(8)
      expect(scheduledFromAssignments([row({
        date: '2026-10-25', start: '00:30:00', end: '03:30:00', tpl: null,
      })]).scheduled_hours).toBe(3)
      // Last day of the month is an ordinary day to the rule.
      expect(scheduledFromAssignments([row({ date: '2026-10-31' })]).scheduled_hours).toBe(8)
    })

    it('skips a row whose block did not come back', () => {
      process.env.TZ = tz
      const out = scheduledFromAssignments([{ id: 'x', status: 'scheduled', shift_blocks: null }, null])
      expect(out.shift_count).toBe(0)
    })
  })
}
