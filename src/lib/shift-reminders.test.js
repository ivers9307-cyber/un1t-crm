// SHIFTREMIND.1 — when is a shift reminder due, what does it say, and does the
// cron arm send it exactly once?
//
// Every instant below is written in UTC with the Dublin wall-clock in the test
// name. Ireland is UTC+1 from the last Sunday of March to the last Sunday of
// October (2026: 29 Mar -> 25 Oct) and UTC+0 otherwise. Nothing here reads the
// host clock or the host timezone, so the file passes under any TZ.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./roster-read', () => ({ fetchApiShiftRows: vi.fn() }))
vi.mock('./notify', () => ({ notifyUsers: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { fetchApiShiftRows } = await import('./roster-read')
const { notifyUsers } = await import('./notify')
const { logWarn, logError } = await import('./log')
const {
  reminderPlanFor, isReminderDue, dueShiftReminders, leaveKeysFor, leaveKey, reminderKey,
  coRosteredFirstNames, buildShiftReminderMessage, runShiftReminders,
} = await import('./shift-reminders')

const at = (iso) => Date.parse(iso)
const iso = (ms) => new Date(ms).toISOString()

// A fetchApiShiftRows() row. Fictional people only: the repo is public.
function shift(over = {}) {
  return {
    id: 'assign-1',
    profile_id: 'coach-1',
    location_id: 'loc-1',
    shift_template_id: 'tpl-early',
    shift_date: '2026-09-22',
    status: 'scheduled',
    published: true,
    start_time_override: null,
    end_time_override: null,
    block_start_time: null,
    block_end_time: null,
    shift_templates: { name: 'Early', start_time: '06:00:00', end_time: '14:00:00' },
    profiles: { id: 'coach-1', full_name: 'Alex Example' },
    ...over,
  }
}
const midShift = (over = {}) => shift({
  id: 'assign-2', shift_template_id: 'tpl-mid',
  shift_templates: { name: 'Mid', start_time: '10:00:00', end_time: '14:00:00' },
  ...over,
})

describe('reminderPlanFor — which rule, and the fire instant', () => {
  it('06:00 shift -> 20:00 Dublin the evening before (summer, UTC+1)', () => {
    const p = reminderPlanFor(shift())
    expect(p.kind).toBe('evening_before')
    expect(iso(p.fireAtMs)).toBe('2026-09-21T19:00:00.000Z') // 20:00 Dublin
    expect(iso(p.startMs)).toBe('2026-09-22T05:00:00.000Z')  // 06:00 Dublin
    expect(p.leadMinutes).toBe(600)
  })

  it('10:00 shift -> exactly 2 hours before', () => {
    const p = reminderPlanFor(midShift())
    expect(p.kind).toBe('two_hours')
    expect(iso(p.fireAtMs)).toBe('2026-09-22T07:00:00.000Z') // 08:00 Dublin
    expect(p.leadMinutes).toBe(120)
  })

  it('the 08:00 boundary: 07:59 is early, 08:00 is not', () => {
    const tpl = (start) => ({ name: 'T', start_time: start, end_time: '13:00:00' })
    expect(reminderPlanFor(shift({ shift_templates: tpl('07:59:00') })).kind).toBe('evening_before')
    expect(reminderPlanFor(shift({ shift_templates: tpl('08:00:00') })).kind).toBe('two_hours')
  })

  it('uses the EFFECTIVE start: assignment override, then block, then template', () => {
    // Template says 09:00 but this coach was moved to 07:30 -> evening before.
    expect(reminderPlanFor(shift({
      start_time_override: '07:30:00',
      shift_templates: { name: 'T', start_time: '09:00:00', end_time: '13:00:00' },
    })).kind).toBe('evening_before')
    // Template says 06:00 but the block was moved to 09:30 -> two hours.
    const p = reminderPlanFor(shift({ block_start_time: '09:30:00' }))
    expect(p.kind).toBe('two_hours')
    expect(iso(p.startMs)).toBe('2026-09-22T08:30:00.000Z')
  })

  it('spring forward (Sun 29 Mar 2026): 20:00 Sat is still winter time, the night is 1h short', () => {
    const p = reminderPlanFor(shift({ shift_date: '2026-03-29' }))
    expect(iso(p.fireAtMs)).toBe('2026-03-28T20:00:00.000Z') // 20:00 Dublin, UTC+0
    expect(iso(p.startMs)).toBe('2026-03-29T05:00:00.000Z')  // 06:00 Dublin, UTC+1
    expect(p.leadMinutes).toBe(540)
  })

  it('fall back (Sun 25 Oct 2026): 20:00 Sat is still summer time, the night is 1h long', () => {
    const p = reminderPlanFor(shift({ shift_date: '2026-10-25' }))
    expect(iso(p.fireAtMs)).toBe('2026-10-24T19:00:00.000Z') // 20:00 Dublin, UTC+1
    expect(iso(p.startMs)).toBe('2026-10-25T06:00:00.000Z')  // 06:00 Dublin, UTC+0
    expect(p.leadMinutes).toBe(660)
  })

  it('a 10:00 shift on both DST days still fires 2 real hours before', () => {
    expect(iso(reminderPlanFor(midShift({ shift_date: '2026-03-29' })).fireAtMs)).toBe('2026-03-29T07:00:00.000Z')
    expect(iso(reminderPlanFor(midShift({ shift_date: '2026-10-25' })).fireAtMs)).toBe('2026-10-25T08:00:00.000Z')
  })

  it('returns null rather than guessing when the row has no date or no start', () => {
    expect(reminderPlanFor(shift({ shift_date: null }))).toBeNull()
    expect(reminderPlanFor(shift({ shift_templates: {} }))).toBeNull()
    expect(reminderPlanFor(null)).toBeNull()
  })
})

describe('dueShiftReminders — the timing table', () => {
  // [name, shift, now (UTC), expected kinds]
  const TABLE = [
    ['06:00 shift at 19:59 the evening before -> not yet', shift(), '2026-09-21T18:59:00Z', []],
    ['06:00 shift at 20:00 the evening before -> due', shift(), '2026-09-21T19:00:00Z', ['evening_before']],
    ['06:00 shift at 20:14 (two missed ticks) -> still due', shift(), '2026-09-21T19:14:00Z', ['evening_before']],
    ['06:00 shift published at 23:30 -> due on the next tick', shift(), '2026-09-21T22:30:00Z', ['evening_before']],
    ['06:00 shift at 05:30 (exactly 30 min notice) -> due', shift(), '2026-09-22T04:30:00Z', ['evening_before']],
    ['06:00 shift at 05:31 (29 min notice) -> never fires late', shift(), '2026-09-22T04:31:00Z', []],
    ['06:00 shift after it has started -> nothing', shift(), '2026-09-22T05:10:00Z', []],
    ['10:00 shift at 07:59 -> not yet', midShift(), '2026-09-22T06:59:00Z', []],
    ['10:00 shift at 08:00 (T-2h) -> due', midShift(), '2026-09-22T07:00:00Z', ['two_hours']],
    ['10:00 shift created at 09:30 (30 min notice) -> due', midShift(), '2026-09-22T08:30:00Z', ['two_hours']],
    ['10:00 shift created at 09:31 (29 min notice) -> nothing', midShift(), '2026-09-22T08:31:00Z', []],
    ['spring-forward 06:00 shift at 19:59 Sat -> not yet', shift({ shift_date: '2026-03-29' }), '2026-03-28T19:59:00Z', []],
    ['spring-forward 06:00 shift at 20:00 Sat -> due', shift({ shift_date: '2026-03-29' }), '2026-03-28T20:00:00Z', ['evening_before']],
    ['fall-back 06:00 shift at 19:59 Sat -> not yet', shift({ shift_date: '2026-10-25' }), '2026-10-24T18:59:00Z', []],
    ['fall-back 06:00 shift at 20:00 Sat -> due', shift({ shift_date: '2026-10-25' }), '2026-10-24T19:00:00Z', ['evening_before']],
  ]
  it.each(TABLE)('%s', (_name, s, now, kinds) => {
    expect(dueShiftReminders([s], { nowMs: at(now) }).map((d) => d.kind)).toEqual(kinds)
  })

  const DUE_NOW = { nowMs: at('2026-09-21T19:00:00Z') }

  it('an UNPUBLISHED shift is never due, whatever the clock says', () => {
    expect(dueShiftReminders([shift({ published: false })], DUE_NOW)).toEqual([])
    expect(dueShiftReminders([shift({ published: undefined })], DUE_NOW)).toEqual([])
  })

  it('a cancelled assignment is skipped; a swapped one is a live shift for its new owner', () => {
    expect(dueShiftReminders([shift({ status: 'cancelled' })], DUE_NOW)).toEqual([])
    expect(dueShiftReminders([shift({ status: 'swapped', profile_id: 'coach-2' })], DUE_NOW)).toHaveLength(1)
  })

  it('a coach on approved leave that day is skipped; leave on another day is not', () => {
    const onLeave = new Set([leaveKey('coach-1', '2026-09-22')])
    expect(dueShiftReminders([shift()], { ...DUE_NOW, onLeave })).toEqual([])
    const otherDay = new Set([leaveKey('coach-1', '2026-09-23')])
    expect(dueShiftReminders([shift()], { ...DUE_NOW, onLeave: otherDay })).toHaveLength(1)
  })

  it('duplicate run inside the same window: a ledger hit removes it', () => {
    const first = dueShiftReminders([shift()], DUE_NOW)
    expect(first).toHaveLength(1)
    const sentKeys = new Set(first.map((d) => reminderKey(d.shift.id, d.shift.profile_id)))
    expect(dueShiftReminders([shift()], { nowMs: at('2026-09-21T19:05:00Z'), sentKeys })).toEqual([])
  })

  it('the ledger key is per RECIPIENT: after a swap the new owner is still reminded', () => {
    const sentKeys = new Set([reminderKey('assign-1', 'coach-1')])
    expect(dueShiftReminders([shift({ status: 'swapped', profile_id: 'coach-2' })], { ...DUE_NOW, sentKeys }))
      .toHaveLength(1)
  })

  it('the same (assignment, coach) handed in twice in ONE run is still one reminder', () => {
    // The reader cannot produce this (one row per assignment id), but this
    // function is the last thing between a row and a push, so it does not
    // rely on that: whatever the input, at most one reminder per key.
    const due = dueShiftReminders([shift(), shift(), shift({ start_time_override: '07:00:00' })], DUE_NOW)
    expect(due).toHaveLength(1)
  })

  it("reads each location's own timezone", () => {
    // 06:00 in New York on 22 Sep is 10:00 UTC; 20:00 the evening before is 00:00 UTC.
    const s = shift({ location_id: 'loc-ny' })
    const tzByLocation = { 'loc-ny': 'America/New_York' }
    expect(dueShiftReminders([s], { nowMs: at('2026-09-21T23:59:00Z'), tzByLocation })).toEqual([])
    expect(dueShiftReminders([s], { nowMs: at('2026-09-22T00:00:00Z'), tzByLocation })).toHaveLength(1)
  })

  it('isReminderDue(null) is false, not a throw', () => {
    expect(isReminderDue(null, 0)).toBe(false)
  })
})

describe('leaveKeysFor', () => {
  it('expands approved ranges over the asked-for dates only, and ignores other statuses', () => {
    const keys = leaveKeysFor([
      { profile_id: 'coach-1', status: 'approved', start_date: '2026-09-20', end_date: '2026-09-22' },
      { profile_id: 'coach-2', status: 'pending', start_date: '2026-09-22', end_date: '2026-09-22' },
      { profile_id: 'coach-3', status: 'approved', start_date: '2026-09-23', end_date: '2026-09-23' },
    ], ['2026-09-22', '2026-09-23'])
    expect([...keys].sort()).toEqual(['coach-1|2026-09-22', 'coach-3|2026-09-23'])
  })
  it('tolerates null input', () => {
    expect(leaveKeysFor(null, null).size).toBe(0)
  })
})
