// src/lib/contractor-invoices-scheduled.test.js
// INVOICEHOURS.1 — the contractor invoice review's "scheduled hours": live
// assignments on PUBLISHED rosters only (the LABOUR.1 rule), hours by payroll's
// shiftHours, unpublished hours tallied apart. Pure string arithmetic, so every
// case runs under Dublin and a US zone.

import { describe, it, expect, afterEach } from 'vitest'
import { scheduledFromAssignments, computeScheduledForPeriod } from './contractor-invoices'
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

// A recording fake of the two reads. profiles: .select().eq().single();
// shift_assignments: .select().eq().eq().gte().lte().order().range() awaited
// (selectAll), one page per await.
function fakeDb({
  profile = { hourly_rate: 20, employment_type: 'contractor' },
  profileError = null, pages = [[]], rowsError = null,
} = {}) {
  const calls = []
  let page = 0
  return {
    calls,
    from(table) {
      const q = { table, filters: [], select: null, order: null, range: null }
      calls.push(q)
      const b = {
        select(cols) { q.select = cols; return b },
        eq(col, val) { q.filters.push(['eq', col, val]); return b },
        gte(col, val) { q.filters.push(['gte', col, val]); return b },
        lte(col, val) { q.filters.push(['lte', col, val]); return b },
        order(col, opts) { q.order = [col, opts]; return b },
        range(from, to) { q.range = [from, to]; return b },
        single() {
          return Promise.resolve(profileError
            ? { data: null, error: profileError }
            : { data: profile, error: null })
        },
        then(res, rej) {
          const out = rowsError
            ? { data: null, error: rowsError }
            : { data: pages[page++] || [], error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
}

const ARGS = { contractor_id: 'c1', location_id: 'locA', period_start: '2026-10-01', period_end: '2026-10-31' }

for (const tz of ['Europe/Dublin', 'America/Los_Angeles']) {
  describe(`computeScheduledForPeriod (TZ=${tz})`, () => {
    it("reads the invoice's studio and period, by string, with status and roster", async () => {
      process.env.TZ = tz
      const db = fakeDb()
      await computeScheduledForPeriod(db, ARGS)
      const q = db.calls.find((c) => c.table === 'shift_assignments')
      expect(q.filters).toEqual([
        ['eq', 'profile_id', 'c1'],
        ['eq', 'shift_blocks.location_id', 'locA'],
        ['gte', 'shift_blocks.block_date', '2026-10-01'],
        ['lte', 'shift_blocks.block_date', '2026-10-31'],
      ])
      expect(q.select).toMatch(/\bstatus\b/)
      expect(q.select).toMatch(/rosters:roster_id \( status \)/)
      expect(q.order).toEqual(['id', { ascending: true }])
      expect(q.range).toEqual([0, 999])
    })
  })
}

describe('computeScheduledForPeriod', () => {
  it('published-only figures and the unpublished tally reach the result', async () => {
    const db = fakeDb({ pages: [[
      row(),                                                          // 8h published
      row({ roster: 'draft', start: '10:00:00', end: '12:00:00', tpl: null }), // 2h draft
      row({ status: 'cancelled' }),                                   // nowhere
    ]] })
    await expect(computeScheduledForPeriod(db, ARGS)).resolves.toEqual({
      scheduled_hours: 8, shift_count: 1,
      hourly_rate: 20, estimated_cost: 160,
      unpublished_hours: 2, unpublished_shift_count: 1,
    })
  })

  it('pages past 1,000 rows (a truncated read would be an under-count)', async () => {
    const oneHour = () => row({ start: '09:00:00', end: '10:00:00', tpl: null })
    const db = fakeDb({ pages: [Array.from({ length: 1000 }, oneHour), Array.from({ length: 5 }, oneHour)] })
    const out = await computeScheduledForPeriod(db, ARGS)
    expect(out.shift_count).toBe(1005)
    expect(out.scheduled_hours).toBe(1005)
    expect(out.estimated_cost).toBe(20100)
    const ranges = db.calls.filter((c) => c.table === 'shift_assignments').map((c) => c.range)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })

  it('the assignment read fails → throws, never 0', async () => {
    const db = fakeDb({ rowsError: { message: 'boom' } })
    await expect(computeScheduledForPeriod(db, ARGS)).rejects.toThrow(/Assignment lookup failed: boom/)
  })

  it('the profile read fails → throws', async () => {
    const db = fakeDb({ profileError: { message: 'nope' } })
    await expect(computeScheduledForPeriod(db, ARGS)).rejects.toThrow(/Profile lookup failed: nope/)
  })

  it('no hourly rate → hours, but no estimated cost', async () => {
    const db = fakeDb({ profile: { hourly_rate: null, employment_type: 'contractor' }, pages: [[row()]] })
    await expect(computeScheduledForPeriod(db, ARGS)).resolves.toMatchObject({
      scheduled_hours: 8, shift_count: 1, hourly_rate: null, estimated_cost: null,
    })
  })
})
