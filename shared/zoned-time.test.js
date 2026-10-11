// TZ.1 — shared/zoned-time.js behaviour in zones other than Europe/Dublin
// (the Dublin byte-identity contract is shared/zoned-time.parity.test.js).
process.env.TZ = 'America/Los_Angeles' // host zone is neither of the zones under test
import { describe, it, expect, vi } from 'vitest'
const Z = await import('./zoned-time.js')
const NY = 'America/New_York'

// ── Independent oracle ───────────────────────────────────────────────────────
// Deliberately a DIFFERENT algorithm from the module's: it enumerates the
// candidate offsets around an instant and filters by read-back, rather than
// solving. A test that reimplemented the solver would assert nothing.
const _f = new Map()
function stampFmt(tz) {
  if (!_f.has(tz)) _f.set(tz, new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }))
  return _f.get(tz)
}
// Full local date-time of an instant, as 'YYYY-MM-DD HH:MM'.
function localStamp(ms, tz) {
  const p = {}
  for (const { type, value } of stampFmt(tz).formatToParts(new Date(ms))) p[type] = value
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}
function naiveOf(ms, tz) {
  const s = localStamp(ms, tz)
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16))
}
// Does this wall-clock exist in `tz` at all? False inside a spring-forward gap.
function wallClockExists(dateStr, hhmm, tz) {
  const want = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10),
    +hhmm.slice(0, 2), +hhmm.slice(3, 5))
  for (const probe of [want - 86400000, want, want + 86400000]) {
    const off = naiveOf(probe, tz) - probe
    if (naiveOf(want - off, tz) === want) return true
  }
  return false
}
function daysOf2026() {
  const out = []
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86400000) {
    const d = new Date(t)
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`)
  }
  return out
}

// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
describe('America/New_York across 2026 DST', () => {
  it('todayStrIn flips at New York midnight, not UTC or Dublin midnight', () => {
    expect(Z.todayStrIn(NY, Date.parse('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
    expect(Z.todayStrIn(NY, Date.parse('2026-07-01T04:00:00Z'))).toBe('2026-07-01')
    expect(Z.todayStrIn(NY, Date.parse('2026-12-01T04:59:00Z'))).toBe('2026-11-30')
    expect(Z.todayStrIn(NY, Date.parse('2026-12-01T05:00:00Z'))).toBe('2026-12-01')
  })
  it('09:00 wall clock is 13:00Z in EDT and 14:00Z in EST (HH:MM:SS and HH:MM)', () => {
    expect(new Date(Z.zonedWallClockToInstant('2026-07-01', '09:00:00', NY)).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(new Date(Z.zonedWallClockToInstant('2026-12-01', '09:00', NY)).toISOString()).toBe('2026-12-01T14:00:00.000Z')
    expect(new Date(Z.zonedWallClockToInstant('2026-12-01', '09:00:30', NY)).toISOString()).toBe('2026-12-01T14:00:30.000Z')
  })
  it('spring-forward gap 02:30 resolves EARLIER; the day still starts at 00:00 EST', () => {
    expect(new Date(Z.zonedWallClockToInstant('2026-03-08', '02:30', NY)).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    expect(new Date(Z.dayStartMsIn('2026-03-08', NY)).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(new Date(Z.strictDayStartMsIn('2026-03-08', NY)).toISOString()).toBe('2026-03-08T05:00:00.000Z')
  })
  it('the post-jump band on both DST days needs the second correction pass', () => {
    expect(Z.zonedWallClockToInstant('2026-03-08', '03:00', NY)).toBe(Date.parse('2026-03-08T03:00:00-04:00'))
    expect(Z.zonedWallClockToInstant('2026-11-01', '03:00', NY)).toBe(Date.parse('2026-11-01T03:00:00-05:00'))
  })
  it('the 25-hour fall-back day has a range of 25h; the 23-hour spring day 23h', () => {
    const fall = Z.dayRangeMsIn('2026-11-01', '2026-11-01', NY)
    expect(fall.endMs - fall.startMs).toBe(25 * 3600 * 1000)
    const spring = Z.dayRangeMsIn('2026-03-08', '2026-03-08', NY)
    expect(spring.endMs - spring.startMs).toBe(23 * 3600 * 1000)
  })
  it('addDaysIn walks whole New York days across both transitions', () => {
    expect(Z.addDaysIn('2026-03-07', 1, NY)).toBe('2026-03-08')
    expect(Z.addDaysIn('2026-03-07', 2, NY)).toBe('2026-03-09')
    expect(Z.addDaysIn('2026-10-31', 2, NY)).toBe('2026-11-02')
    expect(Z.addDaysIn('2026-11-02', -2, NY)).toBe('2026-10-31')
  })
  it('isoWeekKeyIn / weekStartMsIn / monthStartMsIn use the New York calendar', () => {
    expect(Z.isoWeekKeyIn(Date.parse('2026-01-05T03:00:00Z'), NY)).toBe('2026-W01') // still Sun 4 Jan in NY
    expect(Z.isoWeekKeyIn(Date.parse('2026-01-05T06:00:00Z'), NY)).toBe('2026-W02') // Mon 5 Jan in NY
    expect(new Date(Z.weekStartMsIn(Date.parse('2026-07-08T12:00:00Z'), NY)).toISOString()).toBe('2026-07-06T04:00:00.000Z')
    expect(new Date(Z.monthStartMsIn(Date.parse('2026-11-01T03:00:00Z'), NY)).toISOString()).toBe('2026-10-01T04:00:00.000Z')
  })
  it('dayStrIn, dateKeyIn, monthStrIn, monthKeyIn, timeLabelIn, nowMinutesIn read New York wall clock', () => {
    const t = Date.parse('2026-08-01T02:30:00Z') // 31 Jul 22:30 EDT
    expect(Z.dayStrIn(t, NY)).toBe('2026-07-31')
    expect(Z.dateKeyIn(t, NY)).toBe('2026-07-31')
    expect(Z.monthStrIn(t, NY)).toBe('2026-07')
    expect(Z.monthKeyIn(t, NY)).toBe('2026-07')
    expect(Z.timeLabelIn(new Date(t).toISOString(), NY)).toBe('22:30')
    expect(Z.nowMinutesIn(NY, t)).toBe(22 * 60 + 30)
    // winter: EST is UTC-5
    expect(Z.timeLabelIn('2026-12-01T14:05:00Z', NY)).toBe('09:05')
  })
  it('instantToZonedParts gives the local weekday and minute of day', () => {
    expect(Z.instantToZonedParts('2026-07-06T03:30:00Z', NY)).toMatchObject({ dateKey: '2026-07-05', weekday: 7, h: 23, mi: 30, s: 0, minuteOfDay: 1410 })
    expect(Z.instantToZonedParts(new Date('2026-07-06T04:00:00Z'), NY)).toMatchObject({ y: 2026, mo: 7, d: 6, weekday: 1, h: 0, minuteOfDay: 0 })
    expect(Z.instantToZonedParts(Date.parse('2026-07-06T04:00:00Z'), NY).dateKey).toBe('2026-07-06')
  })
  it('the overlap hour of the fall-back day resolves deterministically (EARLIER for New York, as tz-time)', () => {
    expect(Z.zonedWallClockToInstant('2026-11-01', '01:30', NY)).toBe(Date.parse('2026-11-01T05:30:00Z'))
  })
  it('nextLocalMidnightMs is the next New York midnight', () => {
    expect(new Date(Z.nextLocalMidnightMs(Date.parse('2026-11-01T12:00:00Z'), NY)).toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect(new Date(Z.nextLocalMidnightMs(Date.parse('2026-03-08T12:00:00Z'), NY)).toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })
})

describe('formatInZone', () => {
  it('formats in the zone given, with en-IE by default', () => {
    const t = Date.parse('2026-07-06T13:00:00Z')
    expect(Z.formatInZone(t, NY, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('09:00')
    expect(Z.formatInZone(t, 'Europe/Dublin', { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('14:00')
    expect(Z.formatInZone(new Date(t), NY, { weekday: 'long' })).toBe('Monday')
    expect(Z.formatInZone(t, NY, { month: 'long' }, 'fr-FR')).toBe('juillet')
  })
  it('an invalid zone throws RangeError, as Intl does', () => {
    expect(() => Z.formatInZone(0, 'Mars/Olympus', {})).toThrow(RangeError)
  })
})

describe('strict forms', () => {
  it('zonedWallClockToInstant rejects malformed and impossible input instead of rolling over', () => {
    for (const bad of ['24:00', '7:00', '07:60', '07:00:60', '0700', '', null, undefined]) {
      expect(Z.zonedWallClockToInstant('2026-07-06', bad, NY)).toBeNull()
    }
    for (const bad of ['2026-02-30', '2026-13-01', '26-07-06', '', null]) {
      expect(Z.zonedWallClockToInstant(bad, '07:00', NY)).toBeNull()
    }
  })
  it('strictDayStartMsIn is null for an impossible date; dayStartMsIn rolls over like dublinDayStartMs', () => {
    expect(Z.strictDayStartMsIn('2026-02-30', NY)).toBeNull()
    expect(Z.dayStartMsIn('2026-02-30', NY)).toBe(Z.dayStartMsIn('2026-03-02', NY))
  })
  it('strictDayStrIn throws a named RangeError on a non-instant', () => {
    for (const bad of [null, '', '   ', false, [], NaN, 'not a date']) {
      expect(() => Z.strictDayStrIn(bad, NY)).toThrow(RangeError)
    }
    expect(() => Z.strictDayStrIn(null, NY)).toThrow(/invalid instant/)
    expect(Z.strictDayStrIn('2026-07-07T03:30:00Z', NY)).toBe('2026-07-06')
  })
  it('a far-east zone with a half-hour DST step (Lord Howe) is exact', () => {
    expect(Z.zonedWallClockToInstant('2026-04-04', '15:30', 'Australia/Lord_Howe')).toBe(Date.parse('2026-04-04T15:30:00+11:00'))
  })
  it('a skipped local midnight (Santiago) opens the day at the transition instant', () => {
    expect(Z.dayStartMsIn('2025-09-07', 'America/Santiago')).toBe(Date.parse('2025-09-07T04:00:00Z'))
    expect(Z.strictDayStartMsIn('2025-09-07', 'America/Santiago')).toBe(Date.parse('2025-09-07T04:00:00Z'))
  })
})

describe('validation', () => {
  it.each([['europe/dublin', 'Europe/Dublin'], ['UTC', 'UTC'], ['Etc/UTC', 'UTC'], ['America/New_York', 'America/New_York'], [' Europe/London ', 'Europe/London']])(
    '%s → %s', (i, o) => expect(Z.canonicalZone(i)).toBe(o),
  )
  it.each(['+05:30', '-0800', 'Etc/GMT-5', 'Etc/GMT+5', 'GMT+1', 'UTC+1', 'Mars/Olympus', '', '   ', null, undefined, 42, 'x'.repeat(65)])(
    'rejects %s', (v) => expect(Z.canonicalZone(v)).toBeNull(),
  )
  it('isValidZone / resolveZone', () => {
    expect(Z.isValidZone(NY)).toBe(true)
    expect(Z.isValidZone('nope')).toBe(false)
    expect(Z.resolveZone(null)).toBe('Europe/Dublin')
    expect(Z.resolveZone('Mars/Olympus')).toBe('Europe/Dublin')
    expect(Z.resolveZone('america/new_york')).toBe(NY)
  })
  it('Asia/Kolkata is valid (Intl may canonicalise it to the Asia/Calcutta link)', () => {
    expect(Z.isValidZone('Asia/Kolkata')).toBe(true)
    expect(['Asia/Kolkata', 'Asia/Calcutta']).toContain(Z.canonicalZone('Asia/Kolkata'))
  })
  it('resolveZoneWithFallback flags only a non-null invalid value', () => {
    expect(Z.resolveZoneWithFallback(null)).toEqual({ zone: 'Europe/Dublin', fallback: false })
    expect(Z.resolveZoneWithFallback(undefined)).toEqual({ zone: 'Europe/Dublin', fallback: false })
    expect(Z.resolveZoneWithFallback('Europe/Dubln')).toEqual({ zone: 'Europe/Dublin', fallback: true })
    expect(Z.resolveZoneWithFallback('')).toEqual({ zone: 'Europe/Dublin', fallback: true })
    expect(Z.resolveZoneWithFallback(NY)).toEqual({ zone: NY, fallback: false })
  })
  it('PLATFORM_TZ and DEFAULT_TZ are Europe/Dublin; DAY_MS is 24h', () => {
    expect(Z.PLATFORM_TZ).toBe('Europe/Dublin')
    expect(Z.DEFAULT_TZ).toBe('Europe/Dublin')
    expect(Z.DAY_MS).toBe(86_400_000)
  })
  it('works when Intl.supportedValuesOf is missing (Hermes), and still rejects fixed offsets', async () => {
    const saved = Intl.supportedValuesOf
    try {
      delete Intl.supportedValuesOf
      vi.resetModules()
      const Z2 = await import('./zoned-time.js')
      expect(Z2.isValidZone('Asia/Kolkata')).toBe(true)
      expect(Z2.canonicalZone('America/New_York')).toBe('America/New_York')
      expect(Z2.canonicalZone('Etc/GMT-5')).toBeNull()
      expect(Z2.canonicalZone('+05:30')).toBeNull()
      expect(Z2.canonicalZone('Mars/Olympus')).toBeNull()
      expect(Z2.todayStrIn(NY, Date.parse('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
    } finally {
      Intl.supportedValuesOf = saved
    }
  })
  it('importing the module builds no formatter (nothing can throw at import on a thin ICU)', async () => {
    const Real = Intl.DateTimeFormat
    let built = 0
    try {
      Intl.DateTimeFormat = function (...a) { built++; return new Real(...a) }
      vi.resetModules()
      await import('./zoned-time.js')
      expect(built).toBe(0)
    } finally {
      Intl.DateTimeFormat = Real
    }
  })
})

// Oracle: tz-time.test.js's independent read-back enumerator (copied verbatim
// above): a different algorithm (enumerate offsets, filter by read-back), so
// this is not the solver testing itself.
describe('the tz-time oracle, all 2026 quarter-hours in five zones', () => {
  const ZONES = ['Europe/Dublin', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago']
  const QUARTERS = []
  for (let m = 0; m < 1440; m += 15) QUARTERS.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  it.each(ZONES)('%s: every existing wall clock reads back exactly, and every day starts on itself', (zone) => {
    let bad = 0
    let checked = 0
    for (const d of daysOf2026()) {
      if (Z.strictDayStrIn(Z.dayStartMsIn(d, zone), zone) !== d) bad++
      for (const hhmm of QUARTERS) {
        if (!wallClockExists(d, hhmm, zone)) continue
        checked++
        if (localStamp(Z.zonedWallClockToInstant(d, hhmm, zone), zone) !== `${d} ${hhmm}`) bad++
      }
    }
    expect(bad).toBe(0)
    expect(checked).toBeGreaterThan(365 * 96 - 10)
  })
})
