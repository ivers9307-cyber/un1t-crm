// src/lib/staff-push-hours.test.js
// THE table for staff quiet hours. shift-reminders.js and swap-cover.js both
// import the rule from staff-push-hours.js; their own suites only pin that
// they obey it.
import { describe, it, expect } from 'vitest'
import {
  STAFF_PUSH_FROM, STAFF_PUSH_UNTIL, STAFF_PUSH_HOURS, STAFF_PUSH_DEFAULT_TZ,
  isValidStaffTimeZone, resolveStaffTimeZone, staffWallClockHHMM, inStaffPushHours,
} from './staff-push-hours'

const at = (iso) => Date.parse(iso)

describe('the band', () => {
  it('is 07:00 (inclusive) to 22:00 (exclusive), Europe/Dublin by default', () => {
    expect([STAFF_PUSH_FROM, STAFF_PUSH_UNTIL, STAFF_PUSH_DEFAULT_TZ]).toEqual(['07:00', '22:00', 'Europe/Dublin'])
    expect(STAFF_PUSH_HOURS).toEqual({ start: '07:00', end: '22:00' })
    expect(Object.isFrozen(STAFF_PUSH_HOURS)).toBe(true)
  })
})

describe('isValidStaffTimeZone / resolveStaffTimeZone', () => {
  it.each([
    ['Europe/Dublin', true], ['America/New_York', true], ['UTC', true], ['europe/dublin', true],
    ['Mars/Olympus', false], ['Not/AZone', false], ['', false], ['   ', false],
    [null, false], [undefined, false], [42, false], [{}, false],
  ])('isValidStaffTimeZone(%j) -> %s', (tz, expected) => {
    expect(isValidStaffTimeZone(tz)).toBe(expected)
  })

  it.each([
    // A valid zone is used as written.
    ['America/New_York', { timeZone: 'America/New_York', warn: false }],
    ['Europe/Dublin', { timeZone: 'Europe/Dublin', warn: false }],
    // Never set (NULL column): the Dublin default, silently.
    [null, { timeZone: 'Europe/Dublin', warn: false }],
    [undefined, { timeZone: 'Europe/Dublin', warn: false }],
    // Set to something unusable: Dublin, and the caller owes ONE warning.
    ['', { timeZone: 'Europe/Dublin', warn: true }],
    ['   ', { timeZone: 'Europe/Dublin', warn: true }],
    ['Mars/Olympus', { timeZone: 'Europe/Dublin', warn: true }],
    [42, { timeZone: 'Europe/Dublin', warn: true }],
  ])('resolveStaffTimeZone(%j)', (tz, expected) => {
    expect(resolveStaffTimeZone(tz)).toEqual(expected)
  })

  it('never throws, whatever it is handed', () => {
    for (const tz of [Symbol.iterator, () => {}, [], NaN, 'a'.repeat(5000)]) {
      expect(() => resolveStaffTimeZone(tz)).not.toThrow()
      expect(() => inStaffPushHours(at('2026-07-02T12:00:00Z'), tz)).not.toThrow()
    }
  })
})

describe('staffWallClockHHMM', () => {
  it.each([
    ['2026-01-15T07:00:00Z', 'Europe/Dublin', '07:00'],
    ['2026-07-02T06:00:00Z', 'Europe/Dublin', '07:00'],
    // h23: midnight is 00, never 24.
    ['2026-01-15T00:00:00Z', 'Europe/Dublin', '00:00'],
    ['2026-07-01T23:00:00Z', 'Europe/Dublin', '00:00'],
    ['2026-01-15T12:00:00Z', 'America/New_York', '07:00'],
    ['2026-01-15T12:00:00Z', 'Not/AZone', '12:00'],
    ['2026-01-15T12:00:00Z', null, '12:00'],
  ])('%s in %s -> %s', (iso, tz, expected) => {
    expect(staffWallClockHHMM(at(iso), tz)).toBe(expected)
  })
  it('an unreadable instant is null, not a throw', () => {
    expect(staffWallClockHHMM(NaN, 'Europe/Dublin')).toBe(null)
    expect(staffWallClockHHMM(undefined, 'Europe/Dublin')).toBe(null)
    expect(staffWallClockHHMM('2026-01-15', 'Europe/Dublin')).toBe(null)
  })
})

describe('inStaffPushHours', () => {
  it.each([
    // EXACT boundaries, to the second. Winter: Dublin wall clock IS UTC.
    ['2099-01-01T06:59:59Z', 'Europe/Dublin', false],
    ['2099-01-01T07:00:00Z', 'Europe/Dublin', true],
    ['2099-01-01T21:59:59Z', 'Europe/Dublin', true],
    ['2099-01-01T22:00:00Z', 'Europe/Dublin', false],
    ['2099-01-01T02:00:00Z', 'Europe/Dublin', false],
    ['2099-01-01T00:00:00Z', 'Europe/Dublin', false],
    // Summer (IST, UTC+1): the same four boundaries are an hour earlier in UTC.
    ['2026-07-02T05:59:59Z', 'Europe/Dublin', false],
    ['2026-07-02T06:00:00Z', 'Europe/Dublin', true],
    ['2026-07-02T20:59:59Z', 'Europe/Dublin', true],
    ['2026-07-02T21:00:00Z', 'Europe/Dublin', false],
    // SPRING FORWARD weekend: Sun 2026-03-29, 01:00 GMT -> 02:00 IST.
    ['2026-03-28T06:59:59Z', 'Europe/Dublin', false], // Sat, still GMT
    ['2026-03-28T07:00:00Z', 'Europe/Dublin', true],
    ['2026-03-28T21:59:59Z', 'Europe/Dublin', true],
    ['2026-03-28T22:00:00Z', 'Europe/Dublin', false],
    ['2026-03-29T00:59:59Z', 'Europe/Dublin', false], // 00:59:59 GMT, the last second before the jump
    ['2026-03-29T01:00:00Z', 'Europe/Dublin', false], // 02:00:00 IST, the first second after it
    ['2026-03-29T05:59:59Z', 'Europe/Dublin', false], // 06:59:59 IST
    ['2026-03-29T06:00:00Z', 'Europe/Dublin', true],  // 07:00:00 IST
    ['2026-03-29T20:59:59Z', 'Europe/Dublin', true],  // 21:59:59 IST
    ['2026-03-29T21:00:00Z', 'Europe/Dublin', false], // 22:00:00 IST
    // FALL BACK weekend: Sun 2026-10-25, 02:00 IST -> 01:00 GMT. The hour
    // 01:00-02:00 happens TWICE that night; both passes are quiet.
    ['2026-10-24T05:59:59Z', 'Europe/Dublin', false], // Sat, still IST
    ['2026-10-24T06:00:00Z', 'Europe/Dublin', true],
    ['2026-10-24T20:59:59Z', 'Europe/Dublin', true],
    ['2026-10-24T21:00:00Z', 'Europe/Dublin', false],
    ['2026-10-25T00:00:00Z', 'Europe/Dublin', false], // 01:00 IST, first pass begins
    ['2026-10-25T00:30:00Z', 'Europe/Dublin', false], // 01:30 IST, first pass
    ['2026-10-25T00:59:59Z', 'Europe/Dublin', false], // 01:59:59 IST, last second of the first pass
    ['2026-10-25T01:00:00Z', 'Europe/Dublin', false], // 01:00 GMT, second pass begins
    ['2026-10-25T01:30:00Z', 'Europe/Dublin', false], // 01:30 GMT, second pass
    ['2026-10-25T06:00:00Z', 'Europe/Dublin', false], // 06:00 GMT: on Saturday this instant was 07:00
    ['2026-10-25T06:59:59Z', 'Europe/Dublin', false],
    ['2026-10-25T07:00:00Z', 'Europe/Dublin', true],
    ['2026-10-25T21:00:00Z', 'Europe/Dublin', true],  // 21:00 GMT: on Saturday this instant was already shut
    ['2026-10-25T21:59:59Z', 'Europe/Dublin', true],
    ['2026-10-25T22:00:00Z', 'Europe/Dublin', false],
    // A NON-Dublin zone: the studio's clock, not Dublin's and not the server's.
    ['2026-01-15T11:59:59Z', 'America/New_York', false], // 06:59:59 EST
    ['2026-01-15T12:00:00Z', 'America/New_York', true],
    ['2026-01-16T02:59:59Z', 'America/New_York', true],  // 21:59:59 EST
    ['2026-01-16T03:00:00Z', 'America/New_York', false],
    ['2026-03-08T10:59:59Z', 'America/New_York', false], // US spring forward: 06:59:59 EDT
    ['2026-03-08T11:00:00Z', 'America/New_York', true],
    ['2026-11-01T11:59:59Z', 'America/New_York', false], // US fall back: 06:59:59 EST
    ['2026-11-01T12:00:00Z', 'America/New_York', true],
    ['2026-01-15T07:00:00Z', 'Pacific/Kiritimati', true],  // 21:00 at UTC+14
    ['2026-01-15T08:00:00Z', 'Pacific/Kiritimati', false], // 22:00
    // INVALID and EMPTY zones read the Dublin clock.
    ['2026-07-02T06:00:00Z', 'Mars/Olympus', true],
    ['2026-07-02T05:59:59Z', 'Mars/Olympus', false],
    ['2026-07-02T06:00:00Z', '', true],
    ['2026-07-02T05:59:59Z', '', false],
    ['2026-07-02T06:00:00Z', null, true],
    ['2026-07-02T06:00:00Z', undefined, true],
  ])('%s in %j -> %s', (iso, tz, expected) => {
    expect(inStaffPushHours(at(iso), tz)).toBe(expected)
  })

  it('the default zone is Europe/Dublin', () => {
    expect(inStaffPushHours(at('2026-07-02T06:00:00Z'))).toBe(true)
    expect(inStaffPushHours(at('2026-07-02T05:59:59Z'))).toBe(false)
  })

  it('an unreadable clock is OUTSIDE the band (send nothing), not a throw', () => {
    expect(inStaffPushHours(NaN, 'Europe/Dublin')).toBe(false)
    expect(inStaffPushHours(undefined, 'Europe/Dublin')).toBe(false)
    expect(inStaffPushHours(null, 'Europe/Dublin')).toBe(false)
  })
})
