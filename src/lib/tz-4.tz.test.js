// tz-4.tz.test.js — TZ.4. Sequence send windows, send quiet hours and the
// anniversary/birthday day are judged on the sequence's STUDIO clock
// (locations.timezone) instead of a hard-coded Europe/Dublin.
//
//   • Europe/Dublin: byte-identical to the FROZEN pre-change bodies
//     (tz-4.legacy-dublin.test-helpers.js), over every half-hour of 2026, every
//     quarter-hour of the weeks around both 2026 EU DST changes, and every
//     quiet-hours end hour.
//   • America/New_York: follows New York across both 2026 US DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect } from 'vitest'

const L = await import('./tz-4.legacy-dublin.test-helpers.js')
const { nextAcceptableSend, evaluateSendTime } = await import('./send-quiet-hours.js')
const { clampToSendWindow } = await import('./sequences/scheduler.js')
const { isInsideSendWindow, anniversaryOccurrenceYear, birthdayTargetMonthDay } = await import('./sequences/cron-triggers.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
].map(Date.parse)

const HOUR = 3600_000
const range = (fromIso, toIso, stepMs) => {
  const out = []
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += stepMs) out.push(t)
  return out
}
const YEAR_HALF_HOURS = range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', HOUR / 2)
const YEAR_3H = range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 3 * HOUR)
// The weeks around both EU changes, every quarter-hour.
const DST_WEEKS = [
  ...range('2026-03-26T00:00:00Z', '2026-04-02T00:00:00Z', HOUR / 4),
  ...range('2026-10-22T00:00:00Z', '2026-10-29T00:00:00Z', HOUR / 4),
]
// The frozen legacy clamp builds an Intl formatter per hour it steps, so the
// full-year sweeps take seconds, not milliseconds.
const SWEEP_TIMEOUT = 120_000
const iso = (d) => (Number.isFinite(d.getTime()) ? d.toISOString() : 'Invalid')

const QUIET_CONFIGS = [
  null, // the code-side default, 21 → 8
  { enabled: false },
  { enabled: true, startHour: 22, endHour: 7 },
  { enabled: true, startHour: 0, endHour: 6 }, // same-day window
  { enabled: true, startHour: 23, endHour: 1 }, // ends inside the EU gap hour on 29 Mar
  { enabled: true, startHour: 20, endHour: 2 }, // ends on the EU overlap hour on 25 Oct
]

// ── Europe/Dublin is byte-identical ─────────────────────────────────────────

describe('TZ.4 Europe/Dublin is byte-identical: send quiet hours', () => {
  it('nextAcceptableSend: every half-hour of 2026, every config', () => {
    const diffs = []
    for (const cfg of QUIET_CONFIGS) {
      for (const t of YEAR_HALF_HOURS) {
        const a = iso(nextAcceptableSend(t, cfg, D))
        if (a !== iso(L.nextAcceptableSendLegacy(t, cfg))) diffs.push(`${JSON.stringify(cfg)} ${new Date(t).toISOString()}`)
      }
    }
    expect(diffs).toEqual([])
  }, SWEEP_TIMEOUT)

  it('nextAcceptableSend: every quarter-hour of the DST weeks, every end hour 0-23', () => {
    const diffs = []
    for (let end = 0; end < 24; end++) {
      const cfg = { enabled: true, startHour: (end + 13) % 24, endHour: end }
      for (const t of DST_WEEKS) {
        if (iso(nextAcceptableSend(t, cfg, D)) !== iso(L.nextAcceptableSendLegacy(t, cfg))) diffs.push(`${end} ${new Date(t).toISOString()}`)
      }
    }
    expect(diffs).toEqual([])
  }, SWEEP_TIMEOUT)

  it('omitting the zone is Europe/Dublin', () => {
    for (const t of SAMPLES) expect(iso(nextAcceptableSend(t, null))).toBe(iso(L.nextAcceptableSendLegacy(t, null)))
  })

  it.each(SAMPLES.map((t) => [new Date(t).toISOString(), t]))('evaluateSendTime %s', (_label, t) => {
    for (const cfg of QUIET_CONFIGS) {
      for (const nowMs of [t, t - 3 * HOUR, t - 30 * HOUR, t - 72 * HOUR]) {
        expect(evaluateSendTime({ at: t, now: nowMs, config: cfg, zone: D }))
          .toStrictEqual(L.evaluateSendTimeLegacy({ at: t, now: nowMs, config: cfg }))
      }
    }
  })

  it('evaluateSendTime: every half-hour of 2026 (default window; now = 3h earlier) and the DST weeks', () => {
    const diffs = []
    for (const t of [...YEAR_HALF_HOURS, ...DST_WEEKS]) {
      const a = evaluateSendTime({ at: t, now: t - 3 * HOUR, config: null, zone: D })
      const b = L.evaluateSendTimeLegacy({ at: t, now: t - 3 * HOUR, config: null })
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(new Date(t).toISOString())
    }
    expect(diffs).toEqual([])
    // and the inert shapes
    expect(evaluateSendTime({ at: null, now: 0, config: null, zone: D })).toStrictEqual(L.evaluateSendTimeLegacy({ at: null, now: 0, config: null }))
    expect(evaluateSendTime({ at: 'garbage', config: null })).toStrictEqual(L.evaluateSendTimeLegacy({ at: 'garbage', config: null }))
  }, SWEEP_TIMEOUT)
})

const WINDOWS = [
  { start_hour: 9, end_hour: 17, skip_days: [0, 6] },
  { start_hour: 8, end_hour: 20, skip_days: [] },
  { start_hour: null, end_hour: null, skip_days: [0] },
  { start_hour: 1, end_hour: 3, skip_days: [] }, // straddles both EU change hours
  { start_hour: 10 },
  null,
  {},
]

describe('TZ.4 Europe/Dublin is byte-identical: sequence send window', () => {
  it('clampToSendWindow: every 3h of 2026 and every quarter-hour of the DST weeks, every window', () => {
    const diffs = []
    for (const w of WINDOWS) {
      for (const t of [...YEAR_3H, ...DST_WEEKS]) {
        const a = clampToSendWindow(new Date(t), w, D).toISOString()
        if (a !== L.clampToSendWindowLegacy(new Date(t), w).toISOString()) diffs.push(`${JSON.stringify(w)} ${new Date(t).toISOString()}`)
      }
    }
    expect(diffs).toEqual([])
  }, SWEEP_TIMEOUT)

  it('omitting the zone is Europe/Dublin (clamp and isInsideSendWindow)', () => {
    for (const t of SAMPLES) {
      for (const w of WINDOWS) {
        const legacy = L.clampToSendWindowLegacy(new Date(t), w)
        expect(clampToSendWindow(new Date(t), w).toISOString()).toBe(legacy.toISOString())
        if (w && Object.keys(w).length) {
          expect(isInsideSendWindow(new Date(t), w)).toBe(legacy.getTime() === t)
          expect(isInsideSendWindow(new Date(t), w, D)).toBe(legacy.getTime() === t)
        }
      }
    }
  })
})

describe('TZ.4 Europe/Dublin is byte-identical: anniversary year and birthday day', () => {
  it('every half-hour of 2026, days_after 0, 1, 7, 30, 200', () => {
    const diffs = []
    for (const t of YEAR_HALF_HOURS) {
      if (anniversaryOccurrenceYear(t, D) !== L.anniversaryOccurrenceYearLegacy(t)) diffs.push(`year ${t}`)
      for (const n of [0, 1, 7, 30, 200]) {
        if (birthdayTargetMonthDay(t, n, D) !== L.birthdayTargetMonthDayLegacy(t, n)) diffs.push(`${n} ${new Date(t).toISOString()}`)
      }
    }
    expect(diffs).toEqual([])
  }, SWEEP_TIMEOUT)

  it('pins the two EU DST days (the legacy answer, an hour-off instant included)', () => {
    // 00:30 IST on Mon 30 Mar = 23:30Z Sun: 24h earlier is 23:30 GMT on Sat 28 Mar.
    const t = Date.parse('2026-03-29T23:30:00Z')
    expect(birthdayTargetMonthDay(t, 1, D)).toBe('03-28')
    expect(birthdayTargetMonthDay(t, 1, D)).toBe(L.birthdayTargetMonthDayLegacy(t, 1))
    // 23:30 GMT on Sun 25 Oct: 24h earlier is 00:30 IST on Sun 25 Oct.
    const u = Date.parse('2026-10-25T23:30:00Z')
    expect(birthdayTargetMonthDay(u, 1, D)).toBe('10-25')
    expect(birthdayTargetMonthDay(u, 1, D)).toBe(L.birthdayTargetMonthDayLegacy(u, 1))
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
