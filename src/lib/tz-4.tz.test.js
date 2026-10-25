// tz-4.tz.test.js — TZ.4. Sequence send windows, send quiet hours and the
// anniversary/birthday day are judged on the sequence's STUDIO clock
// (locations.timezone) instead of a hard-coded Europe/Dublin.
//
//   • Europe/Dublin: TZ.4 proved it byte-identical to a frozen copy of the
//     pre-change bodies (every half-hour of 2026, every quarter-hour of the
//     weeks around both EU DST changes, every quiet-hours end hour); that sweep
//     was retired in TZ.18b. Dublin is now pinned by fixed values around both
//     2026 EU DST changes; zoned-time ≡ dublin-time stays proven by
//     shared/zoned-time.parity.test.js.
//   • America/New_York: follows New York across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect } from 'vitest'

const { nextAcceptableSend, evaluateSendTime } = await import('./send-quiet-hours.js')
const { clampToSendWindow } = await import('./sequences/scheduler.js')
const { isInsideSendWindow, anniversaryOccurrenceYear, birthdayTargetMonthDay } = await import('./sequences/cron-triggers.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const iso = (d) => (Number.isFinite(d.getTime()) ? d.toISOString() : 'Invalid')

// ── Europe/Dublin pinned values ─────────────────────────────────────────────

describe('TZ.4 Europe/Dublin pinned values: send quiet hours', () => {
  it.each([
    // [config, at, next acceptable send]
    [null, '2026-01-15T22:00:00Z', '2026-01-16T08:00:00.000Z'], // default 21 → 8, winter (GMT)
    [null, '2026-01-15T12:00:00Z', '2026-01-15T12:00:00.000Z'], // outside the window: unchanged
    [null, '2026-07-01T20:30:00Z', '2026-07-02T07:00:00.000Z'], // summer: 08:00 IST
    [null, '2026-03-28T23:30:00Z', '2026-03-29T07:00:00.000Z'], // across the spring-forward
    [null, '2026-10-24T23:30:00Z', '2026-10-25T08:00:00.000Z'], // across the fall-back
    [{ enabled: false }, '2026-01-15T22:00:00Z', '2026-01-15T22:00:00.000Z'],
    [{ enabled: true, startHour: 23, endHour: 1 }, '2026-03-28T23:30:00Z', '2026-03-29T01:00:00.000Z'], // ends in the gap hour → 02:00 IST
    [{ enabled: true, startHour: 20, endHour: 2 }, '2026-10-25T00:30:00Z', '2026-10-25T02:00:00.000Z'], // ends after the repeated hour
    [{ enabled: true, startHour: 0, endHour: 6 }, '2026-03-29T00:30:00Z', '2026-03-29T05:00:00.000Z'], // same-day window
  ])('nextAcceptableSend %j at %s', (cfg, at, expected) => {
    expect(iso(nextAcceptableSend(at, cfg, D))).toBe(expected)
  })

  it('omitting the zone is Europe/Dublin', () => {
    expect(iso(nextAcceptableSend('2026-07-01T20:30:00Z', null))).toBe('2026-07-02T07:00:00.000Z')
    expect(iso(nextAcceptableSend('2026-10-24T23:30:00Z', null))).toBe('2026-10-25T08:00:00.000Z')
  })

  it('evaluateSendTime (default window), explicit zone and default', () => {
    for (const [at, now, expected] of [
      ['2026-01-15T22:00:00Z', '2026-01-15T19:00:00Z', {
        enabled: true, quiet: true, timeLabel: '22:00', whenLabel: '22:00 tonight', windowLabel: '21:00 to 08:00',
        nextSlot: new Date('2026-01-16T08:00:00.000Z'), nextSlotIso: '2026-01-16T08:00:00.000Z', nextSlotLabel: '08:00 tomorrow',
      }],
      ['2026-03-29T00:30:00Z', '2026-03-28T21:30:00Z', {
        enabled: true, quiet: true, timeLabel: '00:30', whenLabel: '00:30 tomorrow', windowLabel: '21:00 to 08:00',
        nextSlot: new Date('2026-03-29T07:00:00.000Z'), nextSlotIso: '2026-03-29T07:00:00.000Z', nextSlotLabel: '08:00 tomorrow',
      }],
      ['2026-10-25T00:30:00Z', '2026-10-22T00:30:00Z', {
        enabled: true, quiet: true, timeLabel: '01:30', whenLabel: '01:30 on Sun 25 Oct', windowLabel: '21:00 to 08:00',
        nextSlot: new Date('2026-10-25T08:00:00.000Z'), nextSlotIso: '2026-10-25T08:00:00.000Z', nextSlotLabel: '08:00 on Sun 25 Oct',
      }],
      ['2026-07-01T12:00:00Z', '2026-07-01T09:00:00Z', {
        enabled: true, quiet: false, timeLabel: '13:00', whenLabel: '13:00 today', windowLabel: '21:00 to 08:00',
        nextSlot: null, nextSlotIso: null, nextSlotLabel: null,
      }],
    ]) {
      expect(evaluateSendTime({ at, now, config: null, zone: D })).toStrictEqual(expected)
      expect(evaluateSendTime({ at, now, config: null })).toStrictEqual(expected)
    }
  })

  it('evaluateSendTime: the inert shapes', () => {
    const inert = { enabled: true, quiet: false, timeLabel: null, whenLabel: null, windowLabel: '21:00 to 08:00', nextSlot: null, nextSlotIso: null, nextSlotLabel: null }
    expect(evaluateSendTime({ at: null, now: 0, config: null, zone: D })).toStrictEqual(inert)
    expect(evaluateSendTime({ at: 'garbage', config: null })).toStrictEqual(inert)
  })
})

describe('TZ.4 Europe/Dublin pinned values: sequence send window', () => {
  const WEEKDAYS_9_17 = { start_hour: 9, end_hour: 17, skip_days: [0, 6] }
  const ONE_TO_THREE = { start_hour: 1, end_hour: 3, skip_days: [] } // straddles both EU change hours
  const NO_SUNDAYS = { start_hour: null, end_hour: null, skip_days: [0] }

  it.each([
    // [window, at, clamped, inside]
    [WEEKDAYS_9_17, '2026-01-16T18:00:00Z', '2026-01-19T09:00:00.000Z', false], // Fri evening → Mon 09:00 GMT
    [WEEKDAYS_9_17, '2026-07-03T07:30:00Z', '2026-07-03T08:30:00.000Z', false], // 08:30 IST → 09:30 IST
    [WEEKDAYS_9_17, '2026-03-28T23:30:00Z', '2026-03-30T08:30:00.000Z', false], // weekend across the spring-forward
    [WEEKDAYS_9_17, '2026-10-24T23:30:00Z', '2026-10-26T09:30:00.000Z', false], // weekend across the fall-back
    [ONE_TO_THREE, '2026-03-28T23:30:00Z', '2026-03-29T01:30:00.000Z', false],
    [ONE_TO_THREE, '2026-03-29T01:30:00Z', '2026-03-29T01:30:00.000Z', true], // 02:30 IST
    [ONE_TO_THREE, '2026-10-25T00:30:00Z', '2026-10-25T00:30:00.000Z', true], // the first 01:30 (IST)
    [ONE_TO_THREE, '2026-10-25T03:30:00Z', '2026-10-26T01:30:00.000Z', false],
    [NO_SUNDAYS, '2026-03-29T01:30:00Z', '2026-03-29T23:30:00.000Z', false], // Sunday → Monday 00:30 IST
    [NO_SUNDAYS, '2026-10-25T00:30:00Z', '2026-10-26T00:30:00.000Z', false], // Sunday → Monday 00:30 GMT
  ])('%j at %s', (w, at, clamped, inside) => {
    expect(clampToSendWindow(new Date(at), w, D).toISOString()).toBe(clamped)
    expect(clampToSendWindow(new Date(at), w).toISOString()).toBe(clamped) // zone omitted = Dublin
    expect(isInsideSendWindow(new Date(at), w, D)).toBe(inside)
    expect(isInsideSendWindow(new Date(at), w)).toBe(inside)
  })

  it('no window (null / {}) leaves the instant alone', () => {
    for (const w of [null, {}]) {
      expect(clampToSendWindow(new Date('2026-03-29T01:30:00Z'), w, D).toISOString()).toBe('2026-03-29T01:30:00.000Z')
    }
  })
})

describe('TZ.4 Europe/Dublin pinned values: anniversary year and birthday day', () => {
  it.each([
    // [at, year, birthday days_after 0 / 1 / 7 / 30]
    ['2026-12-31T23:59:00Z', '2026', ['12-31', '12-30', '12-24', '12-01']],
    ['2027-01-01T00:00:00Z', '2027', ['01-01', '12-31', '12-25', '12-02']], // GMT: Dublin midnight = UTC midnight
    ['2026-06-30T23:30:00Z', '2026', ['07-01', '06-30', '06-24', '06-01']], // IST: already 1 July
    ['2026-03-29T00:30:00Z', '2026', ['03-29', '03-28', '03-22', '02-27']],
    ['2026-10-25T00:30:00Z', '2026', ['10-25', '10-24', '10-18', '09-25']],
  ])('%s', (at, year, days) => {
    const t = Date.parse(at)
    expect(anniversaryOccurrenceYear(t, D)).toBe(year)
    expect([0, 1, 7, 30].map((n) => birthdayTargetMonthDay(t, n, D))).toEqual(days)
  })

  it('pins the two EU DST days (an hour-off instant included)', () => {
    // 00:30 IST on Mon 30 Mar = 23:30Z Sun: 24h earlier is 23:30 GMT on Sat 28 Mar.
    expect(birthdayTargetMonthDay(Date.parse('2026-03-29T23:30:00Z'), 1, D)).toBe('03-28')
    // 23:30 GMT on Sun 25 Oct: 24h earlier is 00:30 IST on Sun 25 Oct.
    expect(birthdayTargetMonthDay(Date.parse('2026-10-25T23:30:00Z'), 1, D)).toBe('10-25')
  })
})

// ── America/New_York follows New York across DST ────────────────────────────

describe('TZ.4 America/New_York: send quiet hours follow New York', () => {
  const QUIET = { enabled: true, startHour: 21, endHour: 8 }

  it('21:30 EDT (summer) moves to 08:00 EDT = 12:00Z', () => {
    expect(nextAcceptableSend('2026-07-01T01:30:00Z', QUIET, NY).toISOString()).toBe('2026-07-01T12:00:00.000Z')
    // the same instant is 02:30 IST in Dublin: moved to 08:00 IST = 07:00Z
    expect(nextAcceptableSend('2026-07-01T01:30:00Z', QUIET, D).toISOString()).toBe('2026-07-01T07:00:00.000Z')
  })

  it('21:30 EST (winter) moves to 08:00 EST = 13:00Z', () => {
    expect(nextAcceptableSend('2026-12-02T02:30:00Z', QUIET, NY).toISOString()).toBe('2026-12-02T13:00:00.000Z')
  })

  it('a window ending in the spring-forward gap (02:00 does not exist on 8 Mar) lands on 03:00 EDT', () => {
    const cfg = { enabled: true, startHour: 21, endHour: 2 }
    // 00:30 EST on Sun 8 Mar
    expect(nextAcceptableSend('2026-03-08T05:30:00Z', cfg, NY).toISOString()).toBe('2026-03-08T07:00:00.000Z')
  })

  it('a window ending across the fall-back (1 Nov) lands on 08:00 EST, 25h after 08:00 EDT the day before', () => {
    // 22:00 EDT Sat 31 Oct → 08:00 EST Sun 1 Nov = 13:00Z
    expect(nextAcceptableSend('2026-11-01T02:00:00Z', QUIET, NY).toISOString()).toBe('2026-11-01T13:00:00.000Z')
  })

  it('the advisory reads New York wall clock: "tonight" is the New York evening', () => {
    const v = evaluateSendTime({ at: '2026-07-01T01:30:00Z', now: '2026-07-01T01:30:00Z', config: QUIET, zone: NY })
    expect(v).toMatchObject({
      quiet: true, timeLabel: '21:30', whenLabel: '21:30 tonight', windowLabel: '21:00 to 08:00',
      nextSlotIso: '2026-07-01T12:00:00.000Z', nextSlotLabel: '08:00 tomorrow',
    })
    // In Dublin the same instant is 02:30 the next morning
    expect(evaluateSendTime({ at: '2026-07-01T01:30:00Z', now: '2026-07-01T01:30:00Z', config: QUIET, zone: D }))
      .toMatchObject({ timeLabel: '02:30', whenLabel: '02:30 today', nextSlotLabel: '08:00 today' })
  })

  it('the day boundary is New York midnight, not Dublin midnight', () => {
    // now 23:30 EDT Tue 30 Jun (04:30 IST Wed 1 Jul); at 01:00 EDT Wed 1 Jul (06:00 IST)
    const args = { at: '2026-07-01T05:00:00Z', now: '2026-07-01T03:30:00Z', config: QUIET }
    expect(evaluateSendTime({ ...args, zone: NY })).toMatchObject({ whenLabel: '01:00 tomorrow', nextSlotLabel: '08:00 tomorrow' })
    expect(evaluateSendTime({ ...args, zone: D })).toMatchObject({ whenLabel: '06:00 today', nextSlotLabel: '08:00 today' })
  })

  it('a slot two New York days out spells the New York date, across the fall-back', () => {
    const v = evaluateSendTime({ at: '2026-11-01T02:00:00Z', now: '2026-10-29T16:00:00Z', config: QUIET, zone: NY })
    expect(v.whenLabel).toBe('22:00 on Sat 31 Oct')
    expect(v.nextSlotLabel).toBe('08:00 on Sun 1 Nov')
  })
})

describe('TZ.4 America/New_York: the sequence send window follows New York', () => {
  const WEEKDAYS_9_17 = { start_hour: 9, end_hour: 17, skip_days: [6, 0] } // 0 = Sunday (getDay())

  it('Sat 10:00 EST moves to Mon 09:00 EST = 14:00Z', () => {
    expect(clampToSendWindow(new Date('2026-11-07T15:00:00Z'), WEEKDAYS_9_17, NY).toISOString()).toBe('2026-11-09T14:00:00.000Z')
  })

  it('across the fall-back: Sat 31 Oct 10:00 EDT moves to Mon 2 Nov 09:00 EST = 14:00Z (not 13:00Z)', () => {
    expect(clampToSendWindow(new Date('2026-10-31T14:00:00Z'), WEEKDAYS_9_17, NY).toISOString()).toBe('2026-11-02T14:00:00.000Z')
  })

  it('across the spring-forward: Sat 7 Mar 10:00 EST moves to Mon 9 Mar 09:00 EDT = 13:00Z', () => {
    expect(clampToSendWindow(new Date('2026-03-07T15:00:00Z'), WEEKDAYS_9_17, NY).toISOString()).toBe('2026-03-09T13:00:00.000Z')
  })

  it('isInsideSendWindow reads the hour in New York', () => {
    const w = { start_hour: 9, end_hour: 19, skip_days: [] }
    // 12:00Z on 20 Aug = 08:00 EDT (outside) = 13:00 IST (inside)
    expect(isInsideSendWindow(new Date('2026-08-20T12:00:00Z'), w, NY)).toBe(false)
    expect(isInsideSendWindow(new Date('2026-08-20T12:00:00Z'), w, D)).toBe(true)
    // 13:00Z = 09:00 EDT
    expect(isInsideSendWindow(new Date('2026-08-20T13:00:00Z'), w, NY)).toBe(true)
  })
})

describe('TZ.4 America/New_York: anniversary year and birthday day flip at New York midnight', () => {
  it('the dedup year turns over at New York midnight, not Dublin midnight', () => {
    const t = Date.parse('2027-01-01T03:00:00Z') // 22:00 EST on 31 Dec 2026
    expect(anniversaryOccurrenceYear(t, NY)).toBe('2026')
    expect(anniversaryOccurrenceYear(t, D)).toBe('2027')
    expect(anniversaryOccurrenceYear(Date.parse('2027-01-01T05:00:00Z'), NY)).toBe('2027')
  })

  it('a birthday (days_after 0) is the New York calendar day', () => {
    const t = Date.parse('2026-07-01T02:00:00Z') // 22:00 EDT on 30 Jun
    expect(birthdayTargetMonthDay(t, 0, NY)).toBe('06-30')
    expect(birthdayTargetMonthDay(t, 0, D)).toBe('07-01')
  })

  it('days_after counts back from the New York day across the fall-back', () => {
    // 12:00 EST Mon 2 Nov; one day back is Sun 1 Nov
    expect(birthdayTargetMonthDay(Date.parse('2026-11-02T17:00:00Z'), 1, NY)).toBe('11-01')
    // 12:00 EDT Sun 8 Mar (after spring-forward); one day back is Sat 7 Mar
    expect(birthdayTargetMonthDay(Date.parse('2026-03-08T16:00:00Z'), 1, NY)).toBe('03-07')
  })
})
