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
  NO_REMINDER_BEFORE, NO_REMINDER_FROM, DAY_LEAD_MINUTES, isInSendWindow,
  reminderPlanFor, isReminderDue, dueShiftReminders, buildShiftRuns, leaveKeysFor, leaveKey, reminderKey,
  coRosteredFirstNames, buildShiftReminderMessage, BODY_MAX_CHARS, runShiftReminders,
} = await import('./shift-reminders')

const at = (iso) => Date.parse(iso)
// Dublin wall clock -> epoch ms, by search (deliberately NOT the module's own localToUtc).
function localMs(date, hhmmStr) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (let ms = Date.parse(`${date}T00:00:00Z`) - 3 * 3600e3; ms < Date.parse(`${date}T00:00:00Z`) + 27 * 3600e3; ms += 60e3) {
    if (fmt.format(ms) === `${date} ${hhmmStr}`) return ms
  }
  throw new Error(`no such wall-clock time: ${date} ${hhmmStr}`)
}
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

  // AMENDED RULE: nobody is reminded before 07:00 Dublin. If 2 hours before the
  // start would land before 07:00 (any start before 09:00), it goes the evening
  // before instead.
  it.each([
    ['08:00', 'evening_before', '2026-09-21T19:00:00.000Z'], // T-2h would be 06:00
    ['08:59', 'evening_before', '2026-09-21T19:00:00.000Z'], // T-2h would be 06:59
    ['09:00', 'two_hours', '2026-09-22T06:00:00.000Z'],      // 07:00 Dublin, the earliest push of any day
    ['09:15', 'two_hours', '2026-09-22T06:15:00.000Z'],      // 07:15 Dublin
  ])('a %s start is %s', (start, kind, fireIso) => {
    const p = reminderPlanFor(shift({ shift_templates: { name: 'T', start_time: `${start}:00`, end_time: '13:00:00' } }))
    expect(p.kind).toBe(kind)
    expect(iso(p.fireAtMs)).toBe(fireIso)
  })

  it('the threshold is the two named numbers, not a third one', () => {
    expect(NO_REMINDER_BEFORE).toBe('07:00')
    expect(DAY_LEAD_MINUTES).toBe(120)
  })

  it('no start time of day ever produces a fire time before 07:00 or after 22:00 Dublin', () => {
    for (let m = 0; m < 24 * 60; m += 5) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0')
      for (const date of ['2026-09-22', '2026-03-29', '2026-10-25', '2026-01-15']) {
        const p = reminderPlanFor(shift({ shift_date: date, shift_templates: { name: 'T', start_time: `${hh}:${mm}:00`, end_time: '23:59:00' } }))
        const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false }).format(p.fireAtMs)
        expect(wall >= '07:00' && wall <= '22:00', `${date} ${hh}:${mm} fires at ${wall}`).toBe(true)
      }
    }
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
    // QUIET HOURS: nothing is ever due outside [07:00, 22:00) on the wall clock.
    ['06:00 shift at 21:55 (last tick of the evening) -> still due', shift(), '2026-09-21T20:55:00Z', ['evening_before']],
    ['06:00 shift at 22:00 -> quiet hours, NOT due', shift(), '2026-09-21T21:00:00Z', []],
    ['06:00 shift published at 23:30 -> NOT due at 23:35', shift(), '2026-09-21T22:35:00Z', []],
    ['06:00 shift, still unsent, at 05:30 (30 min notice) -> NOT due: before 07:00', shift(), '2026-09-22T04:30:00Z', []],
    ['07:29 shift, unsent overnight, at 07:00 -> under 30 min, never', shift({ shift_templates: { name: 'T', start_time: '07:29:00', end_time: '13:00:00' } }), '2026-09-22T06:00:00Z', []],
    ['07:30 shift, unsent overnight, at 06:59 -> quiet hours', shift({ shift_templates: { name: 'T', start_time: '07:30:00', end_time: '13:00:00' } }), '2026-09-22T05:59:00Z', []],
    ['07:30 shift, unsent overnight, at 07:00 -> due (exactly 30 min left)', shift({ shift_templates: { name: 'T', start_time: '07:30:00', end_time: '13:00:00' } }), '2026-09-22T06:00:00Z', ['evening_before']],
    ['06:00 shift at 05:31 (29 min notice) -> never fires late', shift(), '2026-09-22T04:31:00Z', []],
    ['06:00 shift after it has started -> nothing', shift(), '2026-09-22T05:10:00Z', []],
    ['10:00 shift at 07:59 -> not yet', midShift(), '2026-09-22T06:59:00Z', []],
    ['10:00 shift at 08:00 (T-2h) -> due', midShift(), '2026-09-22T07:00:00Z', ['two_hours']],
    ['10:00 shift created at 09:30 (30 min notice) -> due', midShift(), '2026-09-22T08:30:00Z', ['two_hours']],
    ['10:00 shift created at 09:31 (29 min notice) -> nothing', midShift(), '2026-09-22T08:31:00Z', []],
    ['08:30 shift, unsent overnight, at 06:30 (where the old rule fired) -> quiet hours', shift({ shift_templates: { name: 'T', start_time: '08:30:00', end_time: '13:00:00' } }), '2026-09-22T05:30:00Z', []],
    ['08:30 shift, unsent overnight, at 07:00 -> due', shift({ shift_templates: { name: 'T', start_time: '08:30:00', end_time: '13:00:00' } }), '2026-09-22T06:00:00Z', ['evening_before']],
    ['08:30 shift at 19:59 the evening before -> not yet', shift({ shift_templates: { name: 'T', start_time: '08:30:00', end_time: '13:00:00' } }), '2026-09-21T18:59:00Z', []],
    ['08:30 shift at 20:00 the evening before -> due', shift({ shift_templates: { name: 'T', start_time: '08:30:00', end_time: '13:00:00' } }), '2026-09-21T19:00:00Z', ['evening_before']],
    ['09:00 shift at 06:59 -> not yet', shift({ shift_templates: { name: 'T', start_time: '09:00:00', end_time: '13:00:00' } }), '2026-09-22T05:59:00Z', []],
    ['09:00 shift at 07:00 -> due', shift({ shift_templates: { name: 'T', start_time: '09:00:00', end_time: '13:00:00' } }), '2026-09-22T06:00:00Z', ['two_hours']],
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

  it('the send window is two named bounds, [07:00, 22:00), read on the LOCATION wall clock', () => {
    expect([NO_REMINDER_BEFORE, NO_REMINDER_FROM]).toEqual(['07:00', '22:00'])
    expect(isInSendWindow(at('2026-09-22T05:59:59Z'))).toBe(false) // 06:59:59 Dublin (summer)
    expect(isInSendWindow(at('2026-09-22T06:00:00Z'))).toBe(true)  // 07:00
    expect(isInSendWindow(at('2026-09-22T20:59:00Z'))).toBe(true)  // 21:59
    expect(isInSendWindow(at('2026-09-22T21:00:00Z'))).toBe(false) // 22:00
    expect(isInSendWindow(at('2026-01-15T07:00:00Z'))).toBe(true)  // 07:00 Dublin (winter)
    expect(isInSendWindow(at('2026-01-15T06:59:00Z'))).toBe(false)
    expect(isInSendWindow(at('2026-09-22T00:00:00Z'))).toBe(false) // 01:00 Dublin; midnight must not read as "24"
    expect(isInSendWindow(at('2026-09-22T00:00:00Z'), 'America/New_York')).toBe(true) // 20:00 in New York
  })

  it('isReminderDue(null) is false, not a throw', () => {
    expect(isReminderDue(null, 0)).toBe(false)
  })
})

// ── AMENDMENT 2: one reminder per RUN of shifts, not per shift ──────────────
//
// The day that prompted it: 05:45-08:00, 08:00-09:00 and 09:15-10:30 is ONE
// morning of work and must be ONE push, carried by the first shift.

const tplShift = (id, name, start, end, over = {}) => shift({
  id, shift_template_id: `tpl-${id}`,
  shift_templates: { name, start_time: `${start}:00`, end_time: `${end}:00` },
  ...over,
})
const r1 = (over) => tplShift('r1', 'Early Morning', '05:45', '08:00', over)
const r2 = (over) => tplShift('r2', 'Morning 8am', '08:00', '09:00', over)
const r3 = (over) => tplShift('r3', 'Morning 9:15', '09:15', '10:30', over)
const r4 = (over) => tplShift('r4', 'Evening', '17:45', '20:30', over)
const EVENING_BEFORE = at('2026-09-21T19:00:00Z') // 20:00 Dublin, Mon 21 Sep
const ids = (due) => due.map((d) => `${d.shift.profile_id}:${d.shift.id}`)
const keysFor = (...pairs) => new Set(pairs.map(([a, c]) => reminderKey(a, c)))

describe('buildShiftRuns — grouping a coach-day into runs', () => {
  const runIds = (shifts, ctx) => buildShiftRuns(shifts, ctx).map((r) => r.shifts.map((s) => s.id))

  it('back-to-back and near shifts are one run, whatever order the rows arrive in', () => {
    expect(runIds([r3(), r1(), r2()])).toEqual([['r1', 'r2', 'r3']])
  })

  it('the gap is measured from the run\'s LATEST end: exactly 120 minutes joins, 121 starts a new run', () => {
    const a = tplShift('a', 'A', '06:00', '08:00')
    expect(runIds([a, tplShift('b', 'B', '10:00', '11:00')])).toEqual([['a', 'b']])
    expect(runIds([a, tplShift('b', 'B', '10:01', '11:00')])).toEqual([['a'], ['b']])
    // A long shift swallows a short one inside it; the run's end stays the long one's.
    const long = tplShift('long', 'Long', '06:00', '12:00')
    const inside = tplShift('inside', 'Inside', '07:00', '08:00')
    expect(runIds([long, inside, tplShift('c', 'C', '13:30', '15:00')])).toEqual([['long', 'inside', 'c']])
  })

  it('a split day (gap over 120 minutes) is two runs', () => {
    expect(runIds([r1(), r2(), r3(), r4()])).toEqual([['r1', 'r2', 'r3'], ['r4']])
  })

  it('runs are per COACH and per DATE, and span ALL locations', () => {
    expect(runIds([r1(), r2({ location_id: 'loc-2' })])).toEqual([['r1', 'r2']])
    expect(runIds([r1(), r2({ profile_id: 'coach-2' })])).toEqual([['r1'], ['r2']])
    expect(runIds([r1(), r2({ shift_date: '2026-09-23' })])).toEqual([['r1'], ['r2']])
  })

  it('only live, published shifts make a run; whole-day leave removes the coach-day', () => {
    expect(runIds([r1({ published: false }), r2(), r3()])).toEqual([['r2', 'r3']])
    expect(runIds([r1({ status: 'cancelled' }), r2(), r3()])).toEqual([['r2', 'r3']])
    expect(runIds([r1(), r2()], { onLeave: new Set([leaveKey('coach-1', '2026-09-22')]) })).toEqual([])
  })

  it('an overnight shift ends the NEXT day, so its run reaches past midnight', () => {
    const [run] = buildShiftRuns([tplShift('n', 'Night', '22:00', '02:00')])
    expect(iso(run.startMs)).toBe('2026-09-22T21:00:00.000Z')
    expect(iso(run.endMs)).toBe('2026-09-23T01:00:00.000Z')
  })
})

describe('dueShiftReminders — one reminder per run', () => {
  it('three shifts in one morning are ONE reminder, carried by the first shift, fired by the first start', () => {
    const due = dueShiftReminders([r2(), r3(), r1()], { nowMs: EVENING_BEFORE })
    expect(ids(due)).toEqual(['coach-1:r1'])
    expect(due[0].kind).toBe('evening_before')
    expect(due[0].run.map((s) => s.id)).toEqual(['r1', 'r2', 'r3'])
    expect(iso(due[0].runEndMs)).toBe('2026-09-22T09:30:00.000Z') // 10:30 Dublin
  })

  it('the later shifts of a run never carry a reminder of their own, at any time of the day', () => {
    const sentKeys = keysFor(['r1', 'coach-1'])
    // 07:15 is when the 09:15 shift would fire if it stood alone.
    for (const now of ['2026-09-21T19:05:00Z', '2026-09-22T05:00:00Z', '2026-09-22T06:15:00Z', '2026-09-22T07:00:00Z']) {
      expect(dueShiftReminders([r1(), r2(), r3()], { nowMs: at(now), sentKeys }), now).toEqual([])
    }
    // Even with NO ledger row: once the first start is under 30 minutes away the run's chance has gone.
    expect(dueShiftReminders([r1(), r2(), r3()], { nowMs: at('2026-09-22T06:15:00Z') })).toEqual([])
  })

  it('(a) a shift ADDED to a run after its reminder went: no second reminder, later OR earlier than the first', () => {
    const sentKeys = keysFor(['r2', 'coach-1']) // reminded when the run was just [r2]
    const later = dueShiftReminders([r2(), r3()], { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys })
    const earlier = dueShiftReminders([r1(), r2()], { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys })
    expect(later).toEqual([])
    expect(earlier).toEqual([]) // r1 is the new first shift, but the run it belongs to was already reminded
  })

  it('(b) the FIRST shift is SWAPPED AWAY after the reminder went: the rest of the run is not reminded again', () => {
    // r1 now belongs to coach-2 (migs 612/615 move profile_id, status -> swapped).
    // The ledger still holds (r1, coach-1), and r1 is still a row we can see, so
    // it stands in coach-1's day as a ghost that marks the run as reminded.
    const sentKeys = keysFor(['r1', 'coach-1'])
    const rows = [r1({ profile_id: 'coach-2', status: 'swapped' }), r2(), r3()]
    expect(ids(dueShiftReminders(rows, { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys }))).toEqual(['coach-2:r1'])
  })

  it('(b) a ghost only covers ITS run: the evening run of the same day is still reminded', () => {
    const sentKeys = keysFor(['r1', 'coach-1'])
    const rows = [r1({ profile_id: 'coach-2', status: 'swapped' }), r2(), r4()]
    const due = dueShiftReminders(rows, { nowMs: at('2026-09-22T14:45:00Z'), sentKeys }) // 15:45 Dublin = 17:45 - 2h
    expect(ids(due)).toEqual(['coach-1:r4'])
  })

  it('(b) the first shift is REMOVED (a manager unassign is a hard DELETE): ACCEPTED, the rest of the run gets one more reminder', () => {
    // Nothing is left to stand as a ghost: the assignment row is gone and the
    // ledger row carries no date, times or run. So the run [r2, r3] looks new
    // and is reminded once, keyed on r2. Accepted on purpose: it is rare, the
    // coach's day now STARTS at a different time, and it can happen only once
    // more per removal (r2 then holds the claim).
    const sentKeys = keysFor(['r1', 'coach-1'])
    const due = dueShiftReminders([r2(), r3()], { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys })
    expect(ids(due)).toEqual(['coach-1:r2'])
    const after = keysFor(['r1', 'coach-1'], ['r2', 'coach-1'])
    expect(dueShiftReminders([r2(), r3()], { nowMs: EVENING_BEFORE + 10 * 60e3, sentKeys: after })).toEqual([])
  })

  it('(c) a split day yields two reminders: the morning run the evening before, the evening run 2 hours before', () => {
    const day = [r1(), r2(), r3(), r4()]
    expect(ids(dueShiftReminders(day, { nowMs: EVENING_BEFORE }))).toEqual(['coach-1:r1'])
    const sentKeys = keysFor(['r1', 'coach-1'])
    expect(dueShiftReminders(day, { nowMs: at('2026-09-22T14:44:00Z'), sentKeys })).toEqual([])
    expect(ids(dueShiftReminders(day, { nowMs: at('2026-09-22T14:45:00Z'), sentKeys }))).toEqual(['coach-1:r4'])
  })

  it('(d) a coach who TAKES a shift in the middle of someone else\'s run is reminded for their OWN run', () => {
    const sentKeys = keysFor(['r1', 'coach-1']) // coach-1 was reminded before the swap
    const taken = r2({ profile_id: 'coach-2', status: 'swapped' })
    const own = tplShift('r5', 'Late Morning', '09:30', '11:00', { profile_id: 'coach-2' })
    const due = dueShiftReminders([r1(), taken, r3(), own], { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys })
    expect(ids(due)).toEqual(['coach-2:r2']) // coach-1's [r1, r3] is already reminded; coach-2's run is [r2, r5]
    expect(due[0].run.map((s) => s.id)).toEqual(['r2', 'r5'])
  })

  it('(f) a duplicate tick in the same window sends nothing for the run', () => {
    const first = dueShiftReminders([r1(), r2(), r3()], { nowMs: EVENING_BEFORE })
    const sentKeys = new Set(first.map((d) => reminderKey(d.shift.id, d.shift.profile_id)))
    expect(dueShiftReminders([r1(), r2(), r3()], { nowMs: EVENING_BEFORE + 5 * 60e3, sentKeys })).toEqual([])
  })
})

// (e) DST: the 5-minute tick simulation over both change weekends, multi-shift
// runs included, is the sweep below.
describe('QUIET HOURS SWEEP — every 5-minute tick across 48 hours', () => {
  const STARTS = ['00:15', '01:30', '05:45', '06:00', '08:59', '09:00', '12:00', '17:45', '23:00']
  const wallOf = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
  const dayOf = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin' }).format(ms)
  const fixture = (date) => [
    // one lone shift per coach (01:30 happens TWICE on the fall-back night) ...
    ...STARTS.map((start, i) => tplShift(`s${i}`, `S ${start}`, start, '23:59', { shift_date: date, profile_id: `c${i}` })),
    // ... and one coach with a three-shift morning run plus an evening run.
    ...[r1, r2, r3, r4].map((f) => f({ shift_date: date, profile_id: 'c-run' })),
  ]

  // Ticks from 00:00 UTC the day before to 00:00 UTC the day after: 48h, 576 ticks.
  function sweep(date, visibleFromMs) {
    const rows = fixture(date)
    const sentKeys = new Set()
    const fired = {}
    const t0 = Date.parse(`${addDays(date, -1)}T00:00:00Z`)
    let ticks = 0
    for (let now = t0; now < t0 + 48 * 3600e3; now += 5 * 60e3) {
      ticks++
      const due = dueShiftReminders(now >= visibleFromMs ? rows : [], { nowMs: now, sentKeys })
      const wall = wallOf(now)
      if (due.length) expect(wall >= '07:00' && wall < '22:00', `${date}: due at ${wall} Dublin`).toBe(true)
      for (const d of due) {
        const key = reminderKey(d.shift.id, d.shift.profile_id)
        expect(sentKeys.has(key), `${key} fired twice`).toBe(false)
        sentKeys.add(key)
        fired[d.shift.id] = `${dayOf(now) === date ? 'D' : 'D-1'} ${wall}`
      }
    }
    expect(ticks).toBe(576)
    return fired
  }
  const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10)

  it.each(['2026-09-22', '2026-03-29', '2026-10-25'])('%s, everything published in good time: every run exactly once, at its planned time, never in quiet hours', (date) => {
    expect(sweep(date, 0)).toEqual({
      s0: 'D-1 20:00', s1: 'D-1 20:00', s2: 'D-1 20:00', s3: 'D-1 20:00', s4: 'D-1 20:00', // starts before 09:00
      s5: 'D 07:00', s6: 'D 10:00', s7: 'D 15:45', s8: 'D 21:00',
      r1: 'D-1 20:00', r4: 'D 15:45', // the run coach: once for the morning run, once for the evening
    })
  }, 60000)

  it.each(['2026-09-22', '2026-03-29', '2026-10-25'])('%s, published at 22:05 the evening before: starts before 07:30 get NOTHING, the rest wait for 07:00', (date) => {
    const publishedAt = localMs(addDays(date, -1), '22:05')
    expect(sweep(date, publishedAt)).toEqual({
      s4: 'D 07:00', s5: 'D 07:00', s6: 'D 10:00', s7: 'D 15:45', s8: 'D 21:00',
      r4: 'D 15:45', // the morning run starts 05:45: its chance went; r2/r3 never carry one
    })
  }, 60000)
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

  // AMENDMENT 3 — leave only silences a reminder when it covers the WHOLE day.
  // time_off_requests does not say WHICH half a half day is, so a coach with a
  // half day may well be working the other half: remind them.
  it('a single-day request with total_days < 1 is a half day and does NOT count as leave', () => {
    const day = { status: 'approved', start_date: '2026-09-22', end_date: '2026-09-22' }
    const keys = leaveKeysFor([
      { ...day, profile_id: 'half', total_days: 0.5 },
      { ...day, profile_id: 'half-as-text', total_days: '0.5' }, // numeric(5,1) can arrive as a string
      { ...day, profile_id: 'full', total_days: 1 },
      { ...day, profile_id: 'unknown', total_days: null },       // unreadable -> treated as a full day, as before
    ], ['2026-09-22'])
    expect([...keys].sort()).toEqual(['full|2026-09-22', 'unknown|2026-09-22'])
  })

  it('a multi-day request skips every day it covers, even when its total has a half in it', () => {
    const keys = leaveKeysFor([
      { profile_id: 'coach-1', status: 'approved', start_date: '2026-09-22', end_date: '2026-09-23', total_days: 1.5 },
    ], ['2026-09-22', '2026-09-23'])
    expect([...keys].sort()).toEqual(['coach-1|2026-09-22', 'coach-1|2026-09-23'])
  })
})

describe('coRosteredFirstNames + buildShiftReminderMessage', () => {
  const me = shift()
  const mate = (id, profileId, fullName, over = {}) =>
    shift({ id, profile_id: profileId, profiles: { id: profileId, full_name: fullName }, ...over })

  it('lists first names of other live, published coaches on the SAME block, A-Z', () => {
    const all = [
      me,
      mate('a2', 'coach-2', 'Sam Sample'),
      mate('a3', 'coach-3', 'Bo  Placeholder'),
      mate('a4', 'coach-4', 'Other Day', { shift_date: '2026-09-23' }),
      mate('a5', 'coach-5', 'Other Template', { shift_template_id: 'tpl-late' }),
      mate('a6', 'coach-6', 'Other Studio', { location_id: 'loc-2' }),
      mate('a7', 'coach-7', 'Dropped Out', { status: 'cancelled' }),
      mate('a8', 'coach-8', 'Draft Only', { published: false }),
    ]
    expect(coRosteredFirstNames(me, all)).toEqual(['Bo', 'Sam'])
  })

  it('leaves out a colleague who is on approved leave that day', () => {
    const all = [me, mate('a2', 'coach-2', 'Sam Sample')]
    expect(coRosteredFirstNames(me, all, new Set([leaveKey('coach-2', '2026-09-22')]))).toEqual([])
  })

  // The message describes the RUN: day, first start to last end, studio(s), the
  // shift names in order, then who is on the FIRST shift with you.
  const NAMES = { 'loc-1': 'Studio North', 'loc-2': 'Studio South' }
  const EVE = at('2026-09-21T19:00:00Z')
  const msg = (run, over = {}) => buildShiftReminderMessage({ run, nameByLocation: NAMES, nowMs: EVE, ...over })

  it('a single shift the evening before: "tomorrow", 24h times, studio, shift name, colleagues', () => {
    expect(msg([me], { coNames: ['Bo', 'Sam'] })).toEqual({
      title: 'Shift tomorrow at 06:00',
      body: 'Tomorrow 06:00 to 14:00 at Studio North: Early · with Bo and Sam',
    })
  })

  it('a run of three reads first start to LAST end with the shift names in order', () => {
    expect(msg([r1(), r2(), r3()])).toEqual({
      title: '3 shifts tomorrow from 05:45',
      body: 'Tomorrow 05:45 to 10:30 at Studio North: Early Morning, Morning 8am, Morning 9:15',
    })
  })

  it('a reminder that fires on the day says "today", and no colleagues means no "with"', () => {
    expect(msg([r4()], { nowMs: at('2026-09-22T14:45:00Z') })).toEqual({
      title: 'Shift today at 17:45',
      body: 'Today 17:45 to 20:30 at Studio North: Evening',
    })
  })

  it('"tomorrow" is the DUBLIN tomorrow: 23:30 UTC on 21 Sep is already 22 Sep in Dublin', () => {
    expect(msg([me], { nowMs: at('2026-09-21T23:30:00Z') }).title).toBe('Shift today at 06:00')
  })

  it('a run across two studios names both, in the order they are worked', () => {
    expect(msg([r1({ location_id: 'loc-2' }), r2(), r3({ location_id: 'loc-2' })]).body)
      .toBe('Tomorrow 05:45 to 10:30 at Studio South and Studio North: Early Morning, Morning 8am, Morning 9:15')
  })

  it('the end is the LATEST end in the run, not the last shift\'s; overridden and overnight times are the ones shown', () => {
    const long = tplShift('long', 'Long', '06:00', '12:00')
    const inside = tplShift('inside', 'Inside', '07:00', '08:00')
    expect(msg([long, inside]).body).toBe('Tomorrow 06:00 to 12:00 at Studio North: Long, Inside')
    const moved = shift({ start_time_override: '07:00:00', end_time_override: '11:30:00' })
    expect(msg([moved], { coNames: ['Al', 'Bo', 'Cy'] }).body).toBe('Tomorrow 07:00 to 11:30 at Studio North: Early · with Al, Bo and Cy')
    expect(msg([tplShift('n', 'Night', '22:00', '02:00')]).body).toBe('Tomorrow 22:00 to 02:00 at Studio North: Night')
  })

  it('stays lock-screen short: colleagues cap at 3, shift names give way to "+N more" until the body fits', () => {
    expect(BODY_MAX_CHARS).toBe(140)
    expect(msg([me], { coNames: ['Al', 'Bo', 'Cy', 'Di', 'Ed'] }).body)
      .toBe('Tomorrow 06:00 to 14:00 at Studio North: Early · with Al, Bo, Cy +2 more')
    const many = ['05:45', '06:45', '07:45', '08:45', '09:45', '10:45'].map((start, i) =>
      tplShift(`m${i}`, `Strength and Conditioning Block ${i + 1}`, start, `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:45`))
    const { title, body } = msg(many, { coNames: ['Al', 'Bo'] })
    expect(title).toBe('6 shifts tomorrow from 05:45')
    expect(body).toBe('Tomorrow 05:45 to 11:45 at Studio North: Strength and Conditioning Block 1, Strength and Conditioning Block 2 +4 more · with Al and Bo')
    expect(body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
  })

  it('never drops below one shift name, and tolerates a missing studio name or template name', () => {
    expect(msg([me], { nameByLocation: {} }).body).toBe('Tomorrow 06:00 to 14:00: Early')
    expect(msg([shift({ shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })]).body).toBe('Tomorrow 06:00 to 14:00 at Studio North')
  })
})

// ── the cron arm ────────────────────────────────────────────────────────────

// Records every write against push_reminder_sends so a test can assert the
// ORDER: claim (insert) -> send -> count update, or claim -> send -> release.
function makeDb({ leave = [], leaveError = null, ledger = [], ledgerError = null, insertError = null, deleteError = null } = {}) {
  const writes = []
  const selects = {}
  const ledgerReads = []
  const chain = (result, record, table) => {
    const b = {}
    for (const m of ['select', 'eq', 'in', 'lte', 'gte']) {
      b[m] = (...args) => {
        if (record && m === 'eq') record.where[args[0]] = args[1]
        if (table && m === 'select') selects[table] = args[0]
        return b
      }
    }
    b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    return b
  }
  return {
    writes,
    selects,
    ledgerReads,
    from(table) {
      if (table === 'time_off_requests') return chain({ data: leave, error: leaveError }, null, table)
      if (table === 'push_reminder_sends') {
        // The ledger READ honours its filters, like the real table would: a test
        // that seeds a row the arm forgot to ask for must not pass by accident.
        const filters = []
        ledgerReads.push(filters)
        const b = chain(null)
        for (const m of ['eq', 'in', 'gte']) b[m] = (col, val) => { filters.push([m, col, val]); return b }
        b.then = (resolve, reject) => {
          const rows = ledger
            .map((r) => ({ entity_type: 'shift', sent_at: new Date(NOW - 60e3).toISOString(), ...r }))
            .filter((r) => filters.every(([m, col, val]) =>
              m === 'eq' ? r[col] === val : m === 'in' ? val.includes(r[col]) : r[col] >= val))
          return Promise.resolve({ data: ledgerError ? null : rows, error: ledgerError }).then(resolve, reject)
        }
        b.insert = (row) => { writes.push({ op: 'insert', row }); return chain({ data: null, error: insertError }) }
        b.delete = () => { const w = { op: 'delete', where: {} }; writes.push(w); return chain({ data: null, error: deleteError }, w) }
        b.update = (patch) => { const w = { op: 'update', patch, where: {} }; writes.push(w); return chain({ data: null, error: null }, w) }
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const LOCATIONS = [{ id: 'loc-1', name: 'Studio North', timezone: 'Europe/Dublin' }]
const NOW = at('2026-09-21T19:00:00Z') // 20:00 Dublin, Mon 21 Sep
const SENT = { sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0 }
const OWN_ROW = { entity_type: 'shift', entity_id: 'assign-1', recipient_id: 'coach-1' }

describe('runShiftReminders', () => {
  beforeEach(() => {
    fetchApiShiftRows.mockReset().mockResolvedValue({ rows: [shift()], error: null })
    notifyUsers.mockReset().mockResolvedValue({ ...SENT })
    logWarn.mockReset()
    logError.mockReset()
  })

  it.each([
    ['22:00', '2026-09-21T21:00:00Z'],
    ['23:35', '2026-09-21T22:35:00Z'],
    ['03:00', '2026-09-22T02:00:00Z'],
    ['06:55', '2026-09-22T05:55:00Z'],
  ])('QUIET HOURS (%s Dublin): returns before ANY database read, and says so', async (_wall, now) => {
    const db = makeDb()
    const from = vi.spyOn(db, 'from')
    const summary = await runShiftReminders(db, { nowMs: at(now), locations: LOCATIONS })
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ quiet_hours: 1, shift_candidates: 0, shift_pushed: 0 })
  })

  it('inside the send window quiet_hours is 0', async () => {
    expect((await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })).quiet_hours).toBe(0)
  })

  it('reads PUBLISHED shifts for the Dublin today + tomorrow at every location', async () => {
    await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(fetchApiShiftRows).toHaveBeenCalledWith(expect.anything(), {
      locationIds: ['loc-1'], startDate: '2026-09-21', endDate: '2026-09-22', publishedOnly: true,
    })
  })

  it('claims the ledger row, THEN sends on the shift_reminder category, then records the counts', async () => {
    const db = makeDb()
    let writesAtSend = null
    notifyUsers.mockImplementation(async () => { writesAtSend = db.writes.map((w) => w.op); return { ...SENT } })

    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })

    expect(writesAtSend).toEqual(['insert']) // the claim was already written when the push went out
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers).toHaveBeenCalledWith(['coach-1'], {
      title: 'Shift tomorrow at 06:00',
      body: 'Tomorrow 06:00 to 14:00 at Studio North: Early',
      category: 'shift_reminder',
      emailSubject: 'Shift tomorrow at 06:00',
      data: { type: 'shift_reminder', assignment_id: 'assign-1', block_date: '2026-09-22', location_id: 'loc-1', lead_minutes: 600, shift_count: 1 },
    })
    expect(db.writes).toEqual([
      { op: 'insert', row: { ...OWN_ROW, lead_time_minutes: 600, push_count: 0, push_invalidated: 0 } },
      { op: 'update', patch: { push_count: 1, push_invalidated: 0 }, where: OWN_ROW },
    ])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_pushed: 1, shift_skipped_dup: 0, shift_send_failed: 0, shift_claim_failed: 0 })
  })

  it('second run in the same window: the ledger row stops it, nothing is sent or written', async () => {
    const db = makeDb({ ledger: [{ entity_id: 'assign-1', recipient_id: 'coach-1' }] })
    const summary = await runShiftReminders(db, { nowMs: NOW + 5 * 60 * 1000, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_skipped_dup: 1, shift_pushed: 0 })
  })

  it('two overlapping ticks: the loser hits the unique key (23505) on its claim and sends nothing', async () => {
    const db = makeDb({ insertError: { code: '23505' } })
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ shift_skipped_dup: 1, shift_claim_failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  it('the claim cannot be written (e.g. mig 619 not applied -> 23514): NOT sent, logged at error level', async () => {
    const db = makeDb({ insertError: { code: '23514', message: 'violates check constraint' } })
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ shift_claim_failed: 1, shift_pushed: 0 })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a pipeline failure RELEASES the claim, so the next tick retries', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, failed: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'delete'])
    expect(db.writes[1].where).toEqual(OWN_ROW)
    expect(summary).toMatchObject({ shift_send_failed: 1, shift_pushed: 0 })
  })

  // notifyUsers is documented as never throwing. If it throws anyway the arm
  // cannot know whether the push already left, and releasing the claim would
  // repeat it every 5 minutes: KEEP the claim, say so loudly, never rethrow.
  it('a THROWING sender keeps the claim (outcome unknown), is logged at error level, and is never rethrown', async () => {
    notifyUsers.mockRejectedValue(new Error('expo down'))
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert'])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ shift_send_threw: 1, shift_send_failed: 0, shift_pushed: 0 })
  })

  it('one coach\'s sender throwing does not stop the next coach\'s reminder', async () => {
    const mate = shift({ id: 'assign-9', profile_id: 'coach-9', profiles: { id: 'coach-9', full_name: 'Sam Sample' } })
    fetchApiShiftRows.mockResolvedValue({ rows: [shift(), mate], error: null })
    notifyUsers.mockRejectedValueOnce(new Error('expo down'))
    const summary = await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ shift_send_threw: 1, shift_pushed: 1 })
  })

  it('a failed release is logged at error level: that reminder will not retry', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, failed: 1 })
    await runShiftReminders(makeDb({ deleteError: { message: 'boom' } }), { nowMs: NOW, locations: LOCATIONS })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('an opted-out / no-device coach (nothing sent, nothing failed) KEEPS the claim: there is nothing to retry against', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, skipped: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'update'])
    expect(summary).toMatchObject({ shift_skipped_no_recipient: 1, shift_pushed: 0 })
  })

  it('email is the ONLY channel and the mail failed (sent 0, failed 0, email_failed 1): the claim is RELEASED so the next tick retries', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, email_failed: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'delete'])
    expect(db.writes[1].where).toEqual(OWN_ROW)
    expect(summary).toMatchObject({ shift_send_failed: 1, shift_skipped_no_recipient: 0 })
  })

  it.each([
    ['push delivered, a second device failed', { sent: 1, failed: 1 }],
    ['push delivered, the email fallback for someone failed', { sent: 1, email_failed: 1 }],
    ['push failed, the email got through', { sent: 0, failed: 1, emailed: 1 }],
  ])('a PARTIAL success never releases the claim: %s', async (_name, counts) => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, ...counts })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'update'])
    expect(summary.shift_send_failed).toBe(0)
  })

  it('an email-fallback delivery counts as delivered', async () => {
    notifyUsers.mockResolvedValue({ ...SENT, sent: 0, emailed: 1 })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.writes.map((w) => w.op)).toEqual(['insert', 'update'])
    expect(summary).toMatchObject({ shift_emailed: 1, shift_send_failed: 0 })
  })

  it('a coach on approved leave gets nothing, and is not named to colleagues', async () => {
    const mate = shift({ id: 'assign-9', profile_id: 'coach-9', profiles: { id: 'coach-9', full_name: 'Sam Sample' } })
    fetchApiShiftRows.mockResolvedValue({ rows: [shift(), mate], error: null })
    const db = makeDb({ leave: [{ profile_id: 'coach-9', status: 'approved', start_date: '2026-09-22', end_date: '2026-09-22' }] })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers.mock.calls[0][0]).toEqual(['coach-1'])
    expect(notifyUsers.mock.calls[0][1].body).toBe('Tomorrow 06:00 to 14:00 at Studio North: Early')
  })

  it('two coaches on one block each get their own reminder naming the other', async () => {
    const mate = shift({ id: 'assign-9', profile_id: 'coach-9', profiles: { id: 'coach-9', full_name: 'Sam Sample' } })
    fetchApiShiftRows.mockResolvedValue({ rows: [shift(), mate], error: null })
    await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers.mock.calls.map(([ids, p]) => [ids[0], p.body])).toEqual([
      ['coach-1', 'Tomorrow 06:00 to 14:00 at Studio North: Early · with Sam'],
      ['coach-9', 'Tomorrow 06:00 to 14:00 at Studio North: Early · with Alex'],
    ])
  })

  it('a coach on an approved HALF day is still reminded', async () => {
    const db = makeDb({ leave: [{ profile_id: 'coach-1', status: 'approved', start_date: '2026-09-22', end_date: '2026-09-22', total_days: 0.5 }] })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(db.selects.time_off_requests).toMatch(/\btotal_days\b/)
  })

  it('leave read failure fails OPEN: the reminder still goes, and it is logged', async () => {
    const db = makeDb({ leaveError: { message: 'boom' } })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalled()
  })

  it('ledger read failure fails CLOSED for this tick: throws before any claim or send', async () => {
    const db = makeDb({ ledgerError: { message: 'boom' } })
    await expect(runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })).rejects.toThrow(/ledger read failed/)
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('a shift read failure throws; no locations means no reads at all', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [], error: { message: 'down' } })
    await expect(runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })).rejects.toThrow(/shift read failed/)
    fetchApiShiftRows.mockClear()
    const summary = await runShiftReminders(makeDb(), { nowMs: NOW, locations: [] })
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
    expect(summary.shift_candidates).toBe(0)
  })

  // ── runs, at the arm ──────────────────────────────────────────────────────
  it('a run of three shifts is ONE claim and ONE push that describes the whole run', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [r2(), r3(), r1()], error: null })
    const db = makeDb()
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
    expect(notifyUsers.mock.calls[0][1]).toMatchObject({
      title: '3 shifts tomorrow from 05:45',
      body: 'Tomorrow 05:45 to 10:30 at Studio North: Early Morning, Morning 8am, Morning 9:15',
      data: { type: 'shift_reminder', assignment_id: 'r1', block_date: '2026-09-22', shift_count: 3 },
    })
    expect(db.writes.filter((w) => w.op === 'insert').map((w) => w.row.entity_id)).toEqual(['r1'])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_pushed: 1 })
  })

  it('reads the ledger by COACH over the last 48 hours, so a claim on ANY shift of the run is seen', async () => {
    const db = makeDb()
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(db.ledgerReads[0]).toEqual([
      ['eq', 'entity_type', 'shift'],
      ['in', 'recipient_id', ['coach-1']],
      ['gte', 'sent_at', new Date(NOW - 48 * 3600e3).toISOString()],
    ])
  })

  it('(a) an EARLIER shift added after the reminder went: the claim sits on the old first shift, nothing is sent', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [r1(), r2()], error: null })
    const db = makeDb({ ledger: [{ entity_id: 'r2', recipient_id: 'coach-1' }] })
    const summary = await runShiftReminders(db, { nowMs: NOW + 5 * 60e3, locations: LOCATIONS })
    expect(notifyUsers).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
    expect(summary).toMatchObject({ shift_candidates: 1, shift_skipped_dup: 1 })
  })

  it('(b) the first shift swapped away after the reminder went: the giver is not reminded again, the taker is', async () => {
    fetchApiShiftRows.mockResolvedValue({
      rows: [r1({ profile_id: 'coach-2', status: 'swapped', profiles: { id: 'coach-2', full_name: 'Sam Sample' } }), r2(), r3()],
      error: null,
    })
    const db = makeDb({ ledger: [{ entity_id: 'r1', recipient_id: 'coach-1' }] })
    await runShiftReminders(db, { nowMs: NOW + 5 * 60e3, locations: LOCATIONS })
    expect(notifyUsers.mock.calls.map(([ids]) => ids)).toEqual([['coach-2']])
    expect(db.writes.filter((w) => w.op === 'insert').map((w) => [w.row.entity_id, w.row.recipient_id])).toEqual([['r1', 'coach-2']])
  })

  it('a ledger row older than the lookback, or for another entity type, does not silence a reminder', async () => {
    const db = makeDb({ ledger: [
      { entity_id: 'assign-1', recipient_id: 'coach-1', sent_at: new Date(NOW - 49 * 3600e3).toISOString() },
      { entity_id: 'assign-1', recipient_id: 'coach-1', entity_type: 'task' },
    ] })
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(notifyUsers).toHaveBeenCalledTimes(1)
  })

  it('nothing due means the ledger is never touched', async () => {
    const db = makeDb()
    const from = vi.spyOn(db, 'from')
    await runShiftReminders(db, { nowMs: at('2026-09-21T12:00:00Z'), locations: LOCATIONS })
    // COST: not the ledger, and not the leave table either. Most ticks end here,
    // after the one shift read.
    expect(from.mock.calls.map(([t]) => t)).toEqual([])
    expect(notifyUsers).not.toHaveBeenCalled()
  })

  it('leave is read only once a run is time-due, and BEFORE the ledger', async () => {
    const db = makeDb()
    const from = vi.spyOn(db, 'from')
    await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(from.mock.calls.map(([t]) => t).slice(0, 2)).toEqual(['time_off_requests', 'push_reminder_sends'])
  })

  it('everyone time-due is on leave: the ledger is never read', async () => {
    const db = makeDb({ leave: [{ profile_id: 'coach-1', status: 'approved', start_date: '2026-09-22', end_date: '2026-09-22', total_days: 1 }] })
    const from = vi.spyOn(db, 'from')
    const summary = await runShiftReminders(db, { nowMs: NOW, locations: LOCATIONS })
    expect(from.mock.calls.map(([t]) => t)).toEqual(['time_off_requests'])
    expect(summary.shift_candidates).toBe(0)
  })

  it('a shift read that came back at the 1,000-row cap is warned about and counted, never silently truncated', async () => {
    fetchApiShiftRows.mockResolvedValue({ rows: [shift()], error: null, capped: true })
    const summary = await runShiftReminders(makeDb(), { nowMs: NOW, locations: LOCATIONS })
    expect(logWarn).toHaveBeenCalledWith('shift-reminders', expect.stringMatching(/1,000-row cap/), expect.anything())
    expect(summary.shift_read_capped).toBe(1)
    expect(notifyUsers).toHaveBeenCalledTimes(1) // what was read is still reminded
  })
})
