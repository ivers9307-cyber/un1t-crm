// AVAIL.1 — the availability rules, shared by the web, the API and (AVAIL.2)
// the phone. Every date here is a calendar date read from its own digits, so
// this file passes under any TZ.

import { describe, it, expect } from 'vitest'
import {
  AVAILABILITY_WEEKDAYS, AVAILABILITY_LIMITS, weekdayOf, normaliseRule, normaliseAvailability,
  splitRules, ruleProblem, availabilityProblems, rulesOnDate, unavailableFor, unavailableSummary,
  describeWindow, describeRule, diffAvailability, sameAvailability, ruleKey, withoutEnded, carryStartedRules,
} from './availability'

const weekly = (weekday, start, end, note = null) =>
  ({ kind: 'weekly', weekday, all_day: !start, start_time: start, end_time: end, note })
const dated = (from, to, start = null, end = null, note = null) =>
  ({ kind: 'dated', start_date: from, end_date: to, all_day: !start, start_time: start, end_time: end, note })

describe('weekday codes', () => {
  it('are the shift_templates.days_of_week codes, Monday first', () => {
    expect(AVAILABILITY_WEEKDAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  })
  it.each([
    ['2026-09-25', 'fri'], ['2026-05-06', 'wed'], ['2026-03-29', 'sun'], ['2026-10-25', 'sun'], ['2028-02-29', 'tue'],
  ])('%s is %s', (iso, code) => expect(weekdayOf(iso)).toBe(code))
  it.each(['2026-02-30', '2026-13-01', '26-09-25', '', null, '2026-09-25T10:00:00Z'])('%s is not a day', (bad) => {
    expect(weekdayOf(bad)).toBeNull()
  })
})

describe('normaliseRule / normaliseAvailability', () => {
  it('all_day drops the times; HH:MM:SS from Postgres becomes HH:MM; a blank note is null', () => {
    expect(normaliseRule({ kind: 'weekly', weekday: 'MON', all_day: true, start_time: '09:00', end_time: '10:00', note: '  ' }))
      .toEqual({ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null })
    expect(normaliseRule({ kind: 'weekly', weekday: 'tue', all_day: false, start_time: '09:00:00', end_time: '12:30:00' }))
      .toMatchObject({ start_time: '09:00', end_time: '12:30' })
  })
  it('a dated rule with no end_date is one day', () => {
    expect(normaliseRule({ kind: 'dated', start_date: '2026-10-03', all_day: true })).toMatchObject({ end_date: '2026-10-03' })
  })
  it('sorts weekly Monday-first then by time, dated by date, and drops exact duplicates', () => {
    const out = normaliseAvailability({
      weekly: [weekly('tue', '09:00', '10:00'), weekly('mon', '17:00', '19:00'), weekly('mon', '09:00', '10:00'), weekly('mon', '09:00', '10:00')],
      dated: [dated('2026-11-01', '2026-11-01'), dated('2026-10-03', '2026-10-05')],
    })
    expect(out.weekly.map((r) => `${r.weekday} ${r.start_time}`)).toEqual(['mon 09:00', 'mon 17:00', 'tue 09:00'])
    expect(out.dated.map((r) => r.start_date)).toEqual(['2026-10-03', '2026-11-01'])
  })
  it('splitRules sorts flat rows (a DB read, or an RPC snapshot) into the two lists', () => {
    const out = splitRules([dated('2026-10-03', '2026-10-03'), weekly('fri', null, null)])
    expect(out.weekly).toHaveLength(1)
    expect(out.dated).toHaveLength(1)
  })
})

describe('ruleProblem', () => {
  const today = '2026-09-25'
  it.each([
    [weekly('funday', null, null), 'Choose a day of the week'],
    [weekly('mon', '09:00', null), 'Give a start and an end time, or choose all day'],
    [weekly('mon', '12:00', '12:00'), 'The end time must be after the start time'],
    [weekly('mon', '22:00', '02:00'), 'The end time must be after the start time'],
    [dated('2026-02-30', '2026-03-01'), 'Use a real date'],
    [dated('2026-10-05', '2026-10-03'), 'The last day is before the first day'],
    [dated('2026-10-01', '2027-10-02'), 'Up to a year at a time'], // 367 days inclusive; mig 630 refuses it too
    [dated('2026-09-20', '2026-09-24'), 'That date has passed'],
    [dated('2028-10-01', '2028-10-01'), 'Up to two years ahead'],
    [weekly('mon', null, null, 'x'.repeat(201)), 'Keep the note to 200 characters'],
  ])('%j → %s', (raw, message) => {
    expect(ruleProblem(normaliseRule(raw), { todayIso: today })).toBe(message)
  })
  it('accepts a good rule, and a range running through today', () => {
    expect(ruleProblem(normaliseRule(weekly('mon', '09:00', '12:00')), { todayIso: today })).toBeNull()
    expect(ruleProblem(normaliseRule(dated('2026-09-20', '2026-09-25')), { todayIso: today })).toBeNull()
    expect(ruleProblem(normaliseRule(dated('2026-10-01', '2027-09-30')), { todayIso: today })).toBeNull() // 365 days
    expect(ruleProblem(normaliseRule(dated('2026-10-01', '2027-10-01')), { todayIso: today })).toBeNull() // 366 days: the limit, as mig 630's CHECK
  })
  it('availabilityProblems names the list and the index, and caps the counts', () => {
    const many = Array.from({ length: AVAILABILITY_LIMITS.weekly + 1 }, (_, i) => weekly('mon', `${String(i % 10).padStart(2, '0')}:00`, `${String(i % 10).padStart(2, '0')}:30`, `n${i}`))
    const issues = availabilityProblems(normaliseAvailability({ weekly: many, dated: [dated('2026-09-01', '2026-09-01')] }), { todayIso: today })
    expect(issues).toContainEqual({ path: 'weekly', message: `Up to ${AVAILABILITY_LIMITS.weekly} weekly entries` })
    expect(issues).toContainEqual({ path: 'dated.0', message: 'That date has passed' })
  })
})

describe('stale tab over midnight: an ended rule the coach already has', () => {
  const today = '2026-09-25'
  const ended = normaliseRule(dated('2026-09-23', '2026-09-24', null, null, 'Wedding'))
  it('is not a problem when it is a rule already stored (history), whatever its note', () => {
    const knownKeys = new Set([ruleKey({ ...ended, note: 'old words' })])
    expect(ruleProblem(ended, { todayIso: today, knownKeys })).toBeNull()
  })
  it('is still refused when it is NEW (not stored)', () => {
    expect(ruleProblem(ended, { todayIso: today, knownKeys: new Set() })).toBe('That date has passed')
    expect(ruleProblem(ended, { todayIso: today })).toBe('That date has passed')
  })
  it('withoutEnded drops dated rules that ended before today and keeps the rest', () => {
    const input = normaliseAvailability({ weekly: [weekly('mon', null, null)], dated: [ended, dated('2026-09-25', '2026-09-25')] })
    const out = withoutEnded(input, today)
    expect(out.weekly).toHaveLength(1)
    expect(out.dated.map((r) => r.start_date)).toEqual(['2026-09-25'])
  })
})

describe('a dated rule that starts before today (backdating)', () => {
  const today = '2026-09-25'
  const started = normaliseRule(dated('2026-09-20', '2026-09-30'))
  it('is refused when it is new or changed', () => {
    expect(ruleProblem(started, { todayIso: today, knownKeys: new Set() })).toBe('Start today or later')
    const other = new Set([ruleKey(dated('2026-09-20', '2026-09-29'))])
    expect(ruleProblem(started, { todayIso: today, knownKeys: other })).toBe('Start today or later')
  })
  it('is fine when the coach already has it (a note edit included)', () => {
    const knownKeys = new Set([ruleKey({ ...started, note: 'before the edit' })])
    expect(ruleProblem({ ...started, note: 'after the edit' }, { todayIso: today, knownKeys })).toBeNull()
  })
  it('without knownKeys (a client that has not loaded them) it is not judged; the server always judges it', () => {
    expect(ruleProblem(started, { todayIso: today })).toBeNull()
  })
})

describe('carryStartedRules: a started rule whose END moved (the one edit allowed besides the note)', () => {
  const today = '2026-09-25'
  const stored = [normaliseRule(dated('2026-09-20', '2026-09-30', '09:00', '12:00', 'Course'))]
  const run = (rule) => carryStartedRules(normaliseAvailability({ dated: [rule] }), stored, today)
  it('shortened or extended: continues from TODAY (the RPC keeps 20-24 as history)', () => {
    expect(run(dated('2026-09-20', '2026-09-27', '09:00', '12:00', 'Course')).input.dated[0]).toMatchObject({ start_date: '2026-09-25', end_date: '2026-09-27' })
    expect(run(dated('2026-09-20', '2026-10-05', '09:00', '12:00')).input.dated[0]).toMatchObject({ start_date: '2026-09-25', end_date: '2026-10-05' })
  })
  it('the carried rule then passes validation', () => {
    const { input, knownKeys } = run(dated('2026-09-20', '2026-09-27', '09:00', '12:00'))
    expect(ruleProblem(input.dated[0], { todayIso: today, knownKeys })).toBeNull()
  })
  it('an end moved to before today: kept as a known ended rule, so validation passes and withoutEnded drops it', () => {
    const { input, knownKeys } = run(dated('2026-09-20', '2026-09-23', '09:00', '12:00'))
    expect(input.dated[0]).toMatchObject({ start_date: '2026-09-20', end_date: '2026-09-23' })
    expect(ruleProblem(input.dated[0], { todayIso: today, knownKeys })).toBeNull()
    expect(withoutEnded(input, today).dated).toEqual([])
  })
  it('a changed window or start is NOT carried (still refused), and an unchanged rule is left alone', () => {
    const { input, knownKeys } = carryStartedRules(normaliseAvailability({
      dated: [dated('2026-09-20', '2026-09-27', null, null), dated('2026-09-21', '2026-09-27', '09:00', '12:00'), stored[0]],
    }), stored, today)
    expect(input.dated.map((r) => r.start_date)).toEqual(['2026-09-20', '2026-09-20', '2026-09-21'])
    expect(input.dated.map((r) => ruleProblem(r, { todayIso: today, knownKeys }))).toEqual(['Start today or later', null, 'Start today or later'])
  })
})

describe('rulesOnDate / unavailableFor', () => {
  const rules = [weekly('wed', '10:00', '11:00', 'School run'), dated('2026-05-07', '2026-05-08', null, null, 'Wedding')]

  it('a weekly rule applies on every date with that weekday', () => {
    expect(rulesOnDate(rules, '2026-05-06')).toHaveLength(1)
    expect(rulesOnDate(rules, '2026-05-13')).toHaveLength(1)
    expect(rulesOnDate(rules, '2026-05-05')).toHaveLength(0)
  })
  it('overlap is strict: a shift touching the window is not flagged', () => {
    expect(unavailableFor(rules, '2026-05-06', '10:00', '12:00')).toHaveLength(1)
    expect(unavailableFor(rules, '2026-05-06', '10:30:00', '10:45:00')).toHaveLength(1)
    expect(unavailableFor(rules, '2026-05-06', '11:00', '12:00')).toBeNull()
    expect(unavailableFor(rules, '2026-05-06', '09:00', '10:00')).toBeNull()
  })
  it('an all-day rule flags any shift that day; no times asks about the whole day', () => {
    expect(unavailableFor(rules, '2026-05-07', '06:00', '07:00')[0].note).toBe('Wedding')
    expect(unavailableFor(rules, '2026-05-06')).toHaveLength(1)
  })
  it('a shift crossing midnight is judged as the whole day (no overnight windows)', () => {
    expect(unavailableFor(rules, '2026-05-06', '22:00', '00:30')).toHaveLength(1)
  })
  it('an unreal date or no rules is null', () => {
    expect(unavailableFor(rules, '2026-02-30', '10:00', '11:00')).toBeNull()
    expect(unavailableFor([], '2026-05-06', '10:00', '11:00')).toBeNull()
    expect(unavailableFor(undefined, '2026-05-06')).toBeNull()
  })
})

describe('describing rules', () => {
  it('windows in the 12-hour style of the rest of the schedule', () => {
    expect(describeWindow(normaliseRule(weekly('mon', '09:00', '12:00')))).toBe('9am–12pm')
    expect(describeWindow(normaliseRule(weekly('mon', '00:30', '12:15')))).toBe('12:30am–12:15pm')
    expect(describeWindow(normaliseRule(weekly('mon', null, null)))).toBe('all day')
  })
  it('rules', () => {
    expect(describeRule(weekly('mon', '09:00', '12:00'))).toBe('Mondays, 9am–12pm')
    expect(describeRule(dated('2026-10-03', '2026-10-03'))).toBe('3 Oct, all day')
    expect(describeRule(dated('2026-10-03', '2026-10-05', '17:00', '19:30'))).toBe('3 Oct – 5 Oct, 5pm–7:30pm')
  })
  it('the picker summary: all day wins, otherwise every window once', () => {
    expect(unavailableSummary([weekly('mon', '09:00', '12:00'), weekly('mon', null, null)])).toBe('all day')
    expect(unavailableSummary([weekly('mon', '09:00', '12:00'), dated('2026-10-05', '2026-10-05', '17:00', '19:00'), weekly('mon', '09:00', '12:00')]))
      .toBe('9am–12pm, 5pm–7pm')
    expect(unavailableSummary(null)).toBe('')
  })
})

describe('diffAvailability / sameAvailability', () => {
  it('reports what was added and removed, ignoring a changed note', () => {
    const before = [weekly('mon', '09:00', '12:00')]
    const after = [weekly('mon', '09:00', '12:00', 'new note'), weekly('tue', null, null)]
    const { added, removed } = diffAvailability(before, after)
    expect(added.map(describeRule)).toEqual(['Tuesdays, all day'])
    expect(removed).toEqual([])
    expect(sameAvailability(before, after)).toBe(false)
  })
  it('with fromIso: dated rules clip to that day, and same-window overlaps cancel (a started rule cut short)', () => {
    const from = '2026-09-25'
    // 20-30 Sep cut to end on the 27th on the 25th: the RPC stores 25-27 and history 20-24.
    let d = diffAvailability([dated('2026-09-20', '2026-09-30')], [dated('2026-09-25', '2026-09-27')], { fromIso: from })
    expect(d.added).toEqual([])
    expect(d.removed.map(describeRule)).toEqual(['28 Sep – 30 Sep, all day'])
    // deleted outright: only the days from today come back
    d = diffAvailability([dated('2026-09-20', '2026-09-30')], [], { fromIso: from })
    expect(d.removed.map(describeRule)).toEqual(['25 Sep – 30 Sep, all day'])
    // extended: only the new days are added
    d = diffAvailability([dated('2026-09-20', '2026-09-30')], [dated('2026-09-25', '2026-10-03')], { fromIso: from })
    expect(d.added.map(describeRule)).toEqual(['1 Oct – 3 Oct, all day'])
    expect(d.removed).toEqual([])
    // a different window never cancels, and a middle cut leaves two pieces
    d = diffAvailability([dated('2026-10-01', '2026-10-10')], [dated('2026-10-04', '2026-10-05', '09:00', '10:00')], { fromIso: from })
    expect(d.removed.map(describeRule)).toEqual(['1 Oct – 10 Oct, all day'])
    d = diffAvailability([dated('2026-10-01', '2026-10-10')], [dated('2026-10-01', '2026-10-03'), dated('2026-10-06', '2026-10-10')], { fromIso: from })
    expect(d.removed.map(describeRule)).toEqual(['4 Oct – 5 Oct, all day'])
    expect(d.added).toEqual([])
  })
  it('accepts either flat arrays or { weekly, dated }', () => {
    expect(sameAvailability({ weekly: [weekly('mon', null, null)], dated: [] }, [weekly('mon', null, null)])).toBe(true)
  })
})
