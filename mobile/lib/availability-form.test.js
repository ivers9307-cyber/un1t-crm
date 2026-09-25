// mobile/lib/availability-form.test.js
//
// AVAIL.2 — the phone availability form's decisions. No RN runtime: the
// screen renders what these return. The RULES are shared/availability.js's
// (the server runs the same ones); these tests pin what the FORM adds: typed
// times, rows, the PUT body, the dirty check, and the server's answer turned
// into words. Every date is read from its own digits, so this file passes
// under any TZ (the PR gate runs it under two).

import { describe, it, expect } from 'vitest'
import {
  AVAILABILITY_COPY, WEEKDAY_CHIPS, createRowKeys, parseTimeInput, timeOnBlur, rowFromRule, rowsFromServer,
  newRow, rowToRule, datesLabel, calendarRange, rangeFromCalendar,
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
