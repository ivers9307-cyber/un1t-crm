// mobile/lib/availability-form.test.js
//
// AVAIL.2 — the phone availability form's decisions. No RN runtime: the
// screen renders what these return. The RULES are shared/availability.js's
// (the server runs the same ones); these tests pin what the FORM adds: typed
// times, rows, the PUT body, the dirty check, and the server's answer turned
// into words. Every date is read from its own digits, so this file passes
// under any TZ (the PR gate runs it under two).

import { describe, it, expect } from 'vitest'
import { AVAILABILITY_LIMITS, normaliseAvailability, carryStartedRules, availabilityProblems } from 'shared/availability'
import {
  AVAILABILITY_COPY, WEEKDAY_CHIPS, createRowKeys, parseTimeInput, timeOnBlur, rowFromRule, rowsFromServer,
  newRow, rowToRule, datesLabel, calendarRange, rangeFromCalendar,
  hasEnded, startedRules, rowProblem, formProblems, canAdd, duplicateKeys, startedNote, rowSummary,
  buildSaveBody, isDirty,
} from './availability-form'

const TODAY = '2026-09-25' // a Friday

// The GET's shape: canonical rules, no ids. r3 started before TODAY and has
// not ended; r4 is in the future.
const SERVER = {
  weekly: [
    { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null },
    { kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' },
  ],
  dated: [
    { kind: 'dated', weekday: null, start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: null },
    { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' },
  ],
}
// Keys r1..r4, in that order.
const loaded = () => rowsFromServer(SERVER, createRowKeys(), { todayIso: TODAY })

describe('WEEKDAY_CHIPS', () => {
  it('Monday first, the shared codes, three-letter faces and full names for screen readers', () => {
    expect(WEEKDAY_CHIPS.map((d) => d.code)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
    expect(WEEKDAY_CHIPS[0]).toEqual({ code: 'mon', label: 'Monday', short: 'Mon' })
    expect(WEEKDAY_CHIPS[6]).toEqual({ code: 'sun', label: 'Sunday', short: 'Sun' })
  })
})

describe('parseTimeInput', () => {
  it.each([
    ['9', '09:00'], ['09', '09:00'], ['930', '09:30'], ['0930', '09:30'], ['9:30', '09:30'], ['9.30', '09:30'],
    ['17', '17:00'], ['17:30', '17:30'], ['1730', '17:30'], ['5pm', '17:00'], ['5:30pm', '17:30'], ['5:30 PM', '17:30'],
    ['1230pm', '12:30'], ['12pm', '12:00'], ['12am', '00:00'], ['0', '00:00'], [' 07:05 ', '07:05'],
  ])('%j reads as %s', (typed, hhmm) => expect(parseTimeInput(typed)).toBe(hhmm))

  it.each([
    '', '   ', null, undefined, '24:00', '2400', '9:5', '9:60', '13pm', '0am', '17:30pm', 'noon', '9-30', '12345', '09:30:00',
  ])('%j does not read (no overnight, no seconds, no guessing)', (typed) => expect(parseTimeInput(typed)).toBeNull())
})

describe('timeOnBlur', () => {
  it('tidies what reads and leaves anything else for the coach to see', () => {
    expect(timeOnBlur('930')).toBe('09:30')
    expect(timeOnBlur('5:30pm')).toBe('17:30')
    expect(timeOnBlur('9:5')).toBe('9:5')
    expect(timeOnBlur('')).toBe('')
    expect(timeOnBlur(undefined)).toBe('')
  })
})

describe('rows from the server', () => {
  it('one row per rule, weekly first, keyed in order, times HH:MM, blanks as empty strings', () => {
    const rows = loaded()
    expect(rows.map((r) => r.key)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(rows[0]).toEqual({
      key: 'r1', kind: 'weekly', weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '', startedOn: null,
    })
    expect(rows[1]).toMatchObject({ kind: 'weekly', weekday: 'tue', all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' })
    expect(rows[3]).toMatchObject({
      kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding', startedOn: null,
    })
  })

  it('a dated rule that started before today remembers its stored start (only its end and note may change)', () => {
    const rows = loaded()
    expect(rows[2]).toMatchObject({ start_date: '2026-09-20', end_date: '2026-09-30', startedOn: '2026-09-20' })
    // Starting today is not "started"; with no today nothing is judged started.
    expect(rowFromRule({ kind: 'dated', start_date: TODAY, end_date: TODAY, all_day: true }, 'k', { todayIso: TODAY }).startedOn).toBeNull()
    expect(rowsFromServer(SERVER, createRowKeys())[2].startedOn).toBeNull()
  })

  it("reads Postgres's HH:MM:SS too", () => {
    expect(rowFromRule({ kind: 'weekly', weekday: 'thu', all_day: false, start_time: '06:00:00', end_time: '08:30:00' }, 'k'))
      .toMatchObject({ key: 'k', start_time: '06:00', end_time: '08:30' })
  })

  it('skips anything unreadable instead of inventing a rule', () => {
    expect(rowsFromServer(null, createRowKeys())).toEqual([])
    expect(rowsFromServer({ weekly: [null, 'x', 7], dated: 'nope' }, createRowKeys())).toEqual([])
    expect(rowsFromServer({ weekly: [{ weekday: 'wed', all_day: true }] }, createRowKeys()))
      .toEqual([{ key: 'r1', kind: 'weekly', weekday: 'wed', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '', startedOn: null }])
  })
})

describe('newRow', () => {
  it('weekly: Monday, all day; dated: today, all day', () => {
    const next = createRowKeys('n')
    expect(newRow('weekly', { todayIso: TODAY, nextKey: next })).toEqual({
      key: 'n1', kind: 'weekly', weekday: 'mon', start_date: '', end_date: '', all_day: true, start_time: '', end_time: '', note: '', startedOn: null,
    })
    expect(newRow('dated', { todayIso: TODAY, nextKey: next })).toEqual({
      key: 'n2', kind: 'dated', weekday: 'mon', start_date: TODAY, end_date: TODAY, all_day: true, start_time: '', end_time: '', note: '', startedOn: null,
    })
  })
})

describe('rowToRule', () => {
  const rows = loaded()
  it('reads typed times; a canonical rule comes out', () => {
    expect(rowToRule({ ...rows[1], start_time: '9', end_time: '1230pm' })).toEqual({
      kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:30', note: 'college',
    })
  })
  it('a date with no last day is one day', () => {
    expect(rowToRule({ ...rows[3], end_date: '' })).toMatchObject({ start_date: '2026-10-03', end_date: '2026-10-03' })
  })
  it('all day drops the times; a blank note is null; an unreadable time is null', () => {
    expect(rowToRule({ ...rows[1], all_day: true })).toMatchObject({ all_day: true, start_time: null, end_time: null })
    expect(rowToRule({ ...rows[0], note: '   ' }).note).toBeNull()
    expect(rowToRule({ ...rows[1], start_time: 'soon' }).start_time).toBeNull()
  })
})

describe('dates on a card', () => {
  it("reads like the leave form's dates", () => {
    expect(datesLabel(loaded()[3])).toBe('Sat 3 Oct – Mon 5 Oct')
    expect(datesLabel({ kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-03' })).toBe('Sat 3 Oct')
    expect(datesLabel({ kind: 'dated', start_date: '2026-12-30', end_date: '2027-01-02' })).toBe('Wed 30 Dec 2026 – Sat 2 Jan 2027')
    expect(datesLabel({ kind: 'dated', start_date: '', end_date: '' })).toBe(AVAILABILITY_COPY.chooseDates)
  })

  it('a one-day entry hands the calendar NO end, so a second tap can make a range', () => {
    expect(calendarRange({ start_date: '2026-10-03', end_date: '2026-10-03' })).toEqual({ startDate: '2026-10-03', endDate: null, initialMonth: null })
    expect(calendarRange({ start_date: '2026-10-03', end_date: '2026-10-05' })).toEqual({ startDate: '2026-10-03', endDate: '2026-10-05', initialMonth: null })
    expect(calendarRange({ start_date: '', end_date: '' })).toEqual({ startDate: null, endDate: null, initialMonth: null })
  })

  it('a started entry shows its whole span but opens on the month of its last day (the days before today cannot be picked)', () => {
    expect(calendarRange(loaded()[2])).toEqual({ startDate: '2026-09-20', endDate: '2026-09-30', initialMonth: '2026-09-30' })
  })

  it("the calendar's first tap is a one-day entry; the second extends it", () => {
    expect(rangeFromCalendar({ start: '2026-10-03', end: null })).toEqual({ start_date: '2026-10-03', end_date: '2026-10-03' })
    expect(rangeFromCalendar({ start: '2026-10-03', end: '2026-10-05' })).toEqual({ start_date: '2026-10-03', end_date: '2026-10-05' })
  })

  it('on a started entry every tap moves only the last day; the stored start stays (the server carries it on from today)', () => {
    const started = loaded()[2]
    // The calendar holds both ends, so a tap arrives as a fresh start.
    expect(rangeFromCalendar({ start: '2026-10-02', end: null }, started)).toEqual({ start_date: '2026-09-20', end_date: '2026-10-02' })
    expect(rangeFromCalendar({ start: '2026-09-27', end: null }, started)).toEqual({ start_date: '2026-09-20', end_date: '2026-09-27' })
    expect(rangeFromCalendar({ start: '2026-09-26', end: '2026-09-28' }, started)).toEqual({ start_date: '2026-09-20', end_date: '2026-09-28' })
  })
})

// A dated row by hand (the key is 'x' unless given).
const datedRow = (start, end, extra = {}) => ({
  key: 'x', kind: 'dated', weekday: 'mon', start_date: start, end_date: end, all_day: true, start_time: '', end_time: '', note: '', startedOn: null, ...extra,
})

describe('hasEnded', () => {
  it('a dated row whose last day is before today has ended; one ending today has not', () => {
    expect(hasEnded(datedRow('2026-09-20', '2026-09-24'), TODAY)).toBe(true)
    expect(hasEnded(datedRow('2026-09-24', ''), TODAY)).toBe(true) // one day, yesterday
    expect(hasEnded(datedRow('2026-09-20', '2026-09-25'), TODAY)).toBe(false)
  })
  it('a weekly row never ends; with no today nothing is judged ended', () => {
    expect(hasEnded(loaded()[0], TODAY)).toBe(false)
    expect(hasEnded(datedRow('2026-09-20', '2026-09-24'), null)).toBe(false)
  })
})

describe('startedRules', () => {
  it("the loaded dated rules that started before today, canonical (the server's `stored` for carryStartedRules)", () => {
    const rows = loaded()
    expect(startedRules(rows, TODAY)).toEqual([rowToRule(rows[2])])
    expect(startedRules(null, TODAY)).toEqual([])
  })
  it("judged at the moment asked: a rule that started today becomes 'started' after midnight", () => {
    const rows = loaded()
    expect(startedRules(rows, '2026-10-04').map((r) => r.start_date)).toEqual(['2026-09-20', '2026-10-03'])
  })
})

describe('rowProblem', () => {
  const [mon, tue, started, future] = loaded()
  const stored = startedRules(loaded(), TODAY)

  it('a typed time that does not read says how to write one, before anything else', () => {
    expect(rowProblem({ ...tue, start_time: '9:5' }, { todayIso: TODAY })).toBe(AVAILABILITY_COPY.timeFormat)
    expect(rowProblem({ ...tue, end_time: 'late' }, { todayIso: TODAY })).toBe(AVAILABILITY_COPY.timeFormat)
  })

  it("otherwise the shared rules' own words", () => {
    expect(rowProblem({ ...tue, start_time: '12:00', end_time: '09:00' }, { todayIso: TODAY })).toBe('The end time must be after the start time')
    expect(rowProblem({ ...tue, start_time: '', end_time: '' }, { todayIso: TODAY })).toBe('Give a start and an end time, or choose all day')
    expect(rowProblem({ ...future, start_date: '2026-10-10', end_date: '2026-10-01' }, { todayIso: TODAY })).toBe('The last day is before the first day')
  })

  it('all day ignores whatever is left in the time fields', () => {
    expect(rowProblem({ ...mon, start_time: 'x', end_time: 'y' }, { todayIso: TODAY })).toBeNull()
  })

  it('a started rule the coach already has is fine, and so is a note edit', () => {
    expect(rowProblem(started, { todayIso: TODAY, started: stored })).toBeNull()
    expect(rowProblem({ ...started, note: 'new words' }, { todayIso: TODAY, started: stored })).toBeNull()
  })

  it('a started rule whose LAST DAY moved (still from today) is fine: the server carries it on from today', () => {
    expect(rowProblem({ ...started, end_date: '2026-10-02' }, { todayIso: TODAY, started: stored })).toBeNull()
    expect(rowProblem({ ...started, end_date: TODAY }, { todayIso: TODAY, started: stored })).toBeNull()
    expect(rowProblem({ ...started, end_date: '2026-10-02', note: 'moved' }, { todayIso: TODAY, started: stored })).toBeNull()
  })

  it('a started rule with a moved start or a changed window, or a new rule before today: start today or later', () => {
    expect(rowProblem({ ...started, all_day: false, start_time: '09:00', end_time: '10:00' }, { todayIso: TODAY, started: stored }))
      .toBe('Start today or later')
    expect(rowProblem({ ...started, start_date: '2026-09-21' }, { todayIso: TODAY, started: stored })).toBe('Start today or later')
    // A card added yesterday on a screen left open over midnight.
    expect(rowProblem(datedRow('2026-09-24', '2026-09-26'), { todayIso: TODAY, started: stored })).toBe('Start today or later')
  })

  it('with nothing loaded to compare against, backdating is left to the server', () => {
    expect(rowProblem(datedRow('2026-09-24', '2026-09-26'), { todayIso: TODAY })).toBeNull()
  })

  it("agrees with the route, rule for rule (carryStartedRules + availabilityProblems on the whole body)", () => {
    const cases = [
      started,
      { ...started, note: 'n' },
      { ...started, end_date: '2026-10-02' },
      { ...started, start_date: '2026-09-21' },
      { ...started, all_day: false, start_time: '09:00', end_time: '10:00' },
      datedRow('2026-09-24', '2026-09-26'),
      future,
    ]
    for (const row of cases) {
      const input = normaliseAvailability({ weekly: [], dated: [rowToRule(row)] })
      const carried = carryStartedRules(input, stored, TODAY)
      const server = availabilityProblems(carried.input, { todayIso: TODAY, knownKeys: carried.knownKeys })[0]?.message ?? null
      expect(rowProblem(row, { todayIso: TODAY, started: stored })).toBe(server)
    }
  })
})

describe('formProblems', () => {
  it('a clean form is ok', () => {
    expect(formProblems(loaded(), { todayIso: TODAY, started: startedRules(loaded(), TODAY) }))
      .toEqual({ byKey: {}, banner: null, ok: true })
  })

  it('marks each broken row by key; an ended row is never judged (it is not sent)', () => {
    const rows = [...loaded(), datedRow('2026-09-01', '2026-09-02', { key: 'old', all_day: false, start_time: 'x' })]
    rows[1] = { ...rows[1], end_time: '08:00' }
    const out = formProblems(rows, { todayIso: TODAY, started: startedRules(loaded(), TODAY) })
    expect(out.byKey).toEqual({ r2: 'The end time must be after the start time' })
    expect(out.ok).toBe(false)
  })

  it('says so when a list is over its cap', () => {
    const next = createRowKeys()
    const many = Array.from({ length: AVAILABILITY_LIMITS.weekly + 1 }, () => newRow('weekly', { todayIso: TODAY, nextKey: next }))
    expect(formProblems(many, { todayIso: TODAY })).toMatchObject({ banner: AVAILABILITY_COPY.weeklyFull, ok: false })
  })
})

describe('canAdd', () => {
  it('stops at the cap for that list only', () => {
    const next = createRowKeys()
    const full = Array.from({ length: AVAILABILITY_LIMITS.weekly }, () => newRow('weekly', { todayIso: TODAY, nextKey: next }))
    expect(canAdd(full, 'weekly', { todayIso: TODAY })).toBe(false)
    expect(canAdd(full, 'dated', { todayIso: TODAY })).toBe(true)
    expect(canAdd(full.slice(1), 'weekly', { todayIso: TODAY })).toBe(true)
  })
})

describe('duplicateKeys', () => {
  const [mon, tue] = loaded()
  it('a later exact copy (same day, window and note) is flagged; the first is not', () => {
    expect([...duplicateKeys([mon, { ...mon, key: 'copy' }], { todayIso: TODAY })]).toEqual(['copy'])
    expect([...duplicateKeys([tue, { ...tue, key: 'typed', start_time: '9', end_time: '12' }], { todayIso: TODAY })]).toEqual(['typed'])
  })
  it('a different note is a different entry', () => {
    expect(duplicateKeys([mon, { ...mon, key: 'b', note: 'other' }], { todayIso: TODAY }).size).toBe(0)
  })
})

describe('startedNote / rowSummary', () => {
  const [mon, tue, started, future] = loaded()
  it('only a started dated row that has not ended gets the started note, naming the day it started', () => {
    expect(startedNote(started, { todayIso: TODAY }))
      .toBe('Started 20 Sep. The days already gone stay as they are: you can change the last day or the note, or remove it from today.')
    expect(startedNote(future, { todayIso: TODAY })).toBeNull()
    expect(startedNote(mon, { todayIso: TODAY })).toBeNull()
    expect(startedNote({ ...started, end_date: '2026-09-24' }, { todayIso: TODAY })).toBeNull()
  })
  it("a card's one-line name is the shared description; an unfinished card says so", () => {
    expect(rowSummary(mon, { todayIso: TODAY })).toBe('Mondays, all day')
    expect(rowSummary(tue, { todayIso: TODAY })).toBe('Tuesdays, 9am–12pm')
    expect(rowSummary(future, { todayIso: TODAY })).toBe('3 Oct – 5 Oct, 5pm–7:30pm')
    expect(rowSummary({ ...tue, start_time: '' }, { todayIso: TODAY })).toBe('Unfinished weekly time')
    expect(rowSummary({ ...future, start_date: '' }, { todayIso: TODAY })).toBe('Unfinished date')
    expect(rowSummary({ ...started, end_date: '2026-09-24' }, { todayIso: TODAY })).toBe('20 Sep – 24 Sep, all day')
  })
})

describe('buildSaveBody', () => {
  it('both lists in canonical order, without kind, whatever order the cards are in; each path names its card', () => {
    const rows = loaded()
    const { body, keysByPath, endedKeys } = buildSaveBody([rows[3], rows[1], rows[2], rows[0]], { todayIso: TODAY })
    expect(body).toEqual({
      weekly: [
        { weekday: 'mon', all_day: true, start_time: null, end_time: null, note: null },
        { weekday: 'tue', all_day: false, start_time: '09:00', end_time: '12:00', note: 'college' },
      ],
      dated: [
        { start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: null },
        { start_date: '2026-10-03', end_date: '2026-10-05', all_day: false, start_time: '17:00', end_time: '19:30', note: 'wedding' },
      ],
    })
    expect(keysByPath).toEqual({ 'weekly.0': ['r1'], 'weekly.1': ['r2'], 'dated.0': ['r3'], 'dated.1': ['r4'] })
    expect(endedKeys).toEqual([])
  })

  it('a started card goes back with its STORED start and its new last day (the server carries it on from today)', () => {
    const rows = loaded()
    const moved = rangeFromCalendar({ start: '2026-10-02', end: null }, rows[2])
    const { body } = buildSaveBody([rows[0], rows[1], { ...rows[2], ...moved }, rows[3]], { todayIso: TODAY })
    expect(body.dated[0]).toEqual({ start_date: '2026-09-20', end_date: '2026-10-02', all_day: true, start_time: null, end_time: null, note: null })
    // The route validates the carried body with no issue.
    const carried = carryStartedRules(normaliseAvailability(body), startedRules(rows, TODAY), TODAY)
    expect(availabilityProblems(carried.input, { todayIso: TODAY, knownKeys: carried.knownKeys })).toEqual([])
    expect(carried.input.dated[0].start_date).toBe(TODAY)
  })

  it('an exact copy is sent once, and its path points at every card that made it', () => {
    const [mon] = loaded()
    const { body, keysByPath } = buildSaveBody([mon, { ...mon, key: 'copy' }], { todayIso: TODAY })
    expect(body.weekly).toHaveLength(1)
    expect(keysByPath).toEqual({ 'weekly.0': ['r1', 'copy'] })
  })

  it('a dated card that ended (a screen left open over midnight) is left out, not sent back', () => {
    const rows = loaded()
    const gone = { ...rows[2], key: 'gone', start_date: '2026-09-01', end_date: '2026-09-24' }
    const { body, endedKeys, keysByPath } = buildSaveBody([...rows, gone], { todayIso: TODAY })
    expect(body.dated.map((d) => d.start_date)).toEqual(['2026-09-20', '2026-10-03'])
    expect(endedKeys).toEqual(['gone'])
    expect(Object.values(keysByPath).flat()).not.toContain('gone')
  })

  it('typed times go out as HH:MM; a one-day date carries its end', () => {
    const next = createRowKeys('n')
    const w = { ...newRow('weekly', { todayIso: TODAY, nextKey: next }), weekday: 'fri', all_day: false, start_time: '5pm', end_time: '1930' }
    const d = { ...newRow('dated', { todayIso: TODAY, nextKey: next }), start_date: '2026-10-09', end_date: '' }
    expect(buildSaveBody([w, d], { todayIso: TODAY }).body).toEqual({
      weekly: [{ weekday: 'fri', all_day: false, start_time: '17:00', end_time: '19:30', note: null }],
      dated: [{ start_date: '2026-10-09', end_date: '2026-10-09', all_day: true, start_time: null, end_time: null, note: null }],
    })
  })
})

describe('isDirty', () => {
  it('nothing loaded is never dirty, so a failed load can never be saved over', () => {
    expect(isDirty(null, loaded(), { todayIso: TODAY })).toBe(false)
  })

  it('the same rules in another order, or typed differently, are not a change', () => {
    const base = loaded()
    expect(isDirty(base, [...base].reverse(), { todayIso: TODAY })).toBe(false)
    const retyped = base.map((r) => (r.key === 'r2' ? { ...r, start_time: '9', end_time: '12pm' } : r))
    expect(isDirty(base, retyped, { todayIso: TODAY })).toBe(false)
  })

  it("a note-only edit, a started card's new last day, a removed card or a new card IS a change", () => {
    const base = loaded()
    expect(isDirty(base, base.map((r) => (r.key === 'r1' ? { ...r, note: 'school run' } : r)), { todayIso: TODAY })).toBe(true)
    expect(isDirty(base, base.map((r) => (r.key === 'r3' ? { ...r, end_date: '2026-09-27' } : r)), { todayIso: TODAY })).toBe(true)
    expect(isDirty(base, base.slice(1), { todayIso: TODAY })).toBe(true)
    expect(isDirty(base, [...base, newRow('dated', { todayIso: TODAY, nextKey: createRowKeys('n') })], { todayIso: TODAY })).toBe(true)
  })

  it('adding an exact copy, or dropping a card that has ended, is not a change', () => {
    const base = loaded()
    expect(isDirty(base, [...base, { ...base[0], key: 'copy' }], { todayIso: TODAY })).toBe(false)
    const withOld = [...base, { ...base[2], key: 'old', start_date: '2026-09-01', end_date: '2026-09-24' }]
    expect(isDirty(withOld, base, { todayIso: TODAY })).toBe(false)
  })
})
