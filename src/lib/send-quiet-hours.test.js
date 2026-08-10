import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SEND_QUIET_HOURS,
  QUIET_HOURS_COLUMNS,
  normalizeQuietHours,
  isQuietHour,
  nextAcceptableSend,
  evaluateSendTime,
} from './send-quiet-hours'

// Every instant below is written as an explicit UTC (…Z) literal and the
// assertion is about the Europe/Dublin WALL CLOCK it maps to. That is the only
// honest way to test this: Dublin is UTC+1 in summer and UTC+0 in winter, so a
// test written in local wall-clock strings would pass in one half of the year
// and fail in the other.
//
// Reference instants (verified against Intl):
//   2026-08-08T21:44Z  = Sat 08 Aug 22:44 Dublin (IST)  ← the live 994-send incident
//   2026-03-29         = spring forward (01:00 GMT → 02:00 IST)
//   2026-10-25         = fall back    (02:00 IST → 01:00 GMT)

const iso = (s) => new Date(s)

describe('DEFAULT_SEND_QUIET_HOURS', () => {
  it('is 21:00 to 08:00 Europe/Dublin and on by default', () => {
    expect(DEFAULT_SEND_QUIET_HOURS.enabled).toBe(true)
    expect(DEFAULT_SEND_QUIET_HOURS.startHour).toBe(21)
    expect(DEFAULT_SEND_QUIET_HOURS.endHour).toBe(8)
  })

  it('does NOT flag 20:00, which carries 6,092 legitimate live sends', () => {
    expect(isQuietHour(20, DEFAULT_SEND_QUIET_HOURS)).toBe(false)
  })
})

describe('normalizeQuietHours', () => {
  it('falls back to the default when the settings row is missing', () => {
    expect(normalizeQuietHours(null)).toEqual(DEFAULT_SEND_QUIET_HOURS)
    expect(normalizeQuietHours(undefined)).toEqual(DEFAULT_SEND_QUIET_HOURS)
  })

  it('reads the company_settings column names', () => {
    expect(normalizeQuietHours({
      [QUIET_HOURS_COLUMNS.enabled]: true,
      [QUIET_HOURS_COLUMNS.start]: 22,
      [QUIET_HOURS_COLUMNS.end]: 7,
    })).toEqual({ enabled: true, startHour: 22, endHour: 7 })
  })

  it('reads the camelCase shape the client hands back', () => {
    expect(normalizeQuietHours({ enabled: false, startHour: 23, endHour: 6 }))
      .toEqual({ enabled: false, startHour: 23, endHour: 6 })
  })

  it('falls back per field when a field is null or out of range', () => {
    expect(normalizeQuietHours({ send_quiet_hours_start: null, send_quiet_hours_end: 6 }))
      .toEqual({ enabled: true, startHour: 21, endHour: 6 })
    expect(normalizeQuietHours({ send_quiet_hours_start: 99, send_quiet_hours_end: -3 }))
      .toEqual(DEFAULT_SEND_QUIET_HOURS)
  })

  it('treats a zero-length window (start === end) as disabled', () => {
    const cfg = normalizeQuietHours({ send_quiet_hours_start: 9, send_quiet_hours_end: 9 })
    expect(cfg.enabled).toBe(false)
  })
})

describe('isQuietHour — the midnight wrap', () => {
  const wrapping = { enabled: true, startHour: 21, endHour: 8 }

  it('is quiet on both sides of midnight', () => {
    for (const h of [21, 22, 23, 0, 1, 5, 7]) {
      expect(isQuietHour(h, wrapping), `hour ${h}`).toBe(true)
    }
  })

  it('is not quiet during the day', () => {
    for (const h of [8, 9, 12, 17, 20]) {
      expect(isQuietHour(h, wrapping), `hour ${h}`).toBe(false)
    }
  })

  it('handles a NON-wrapping window with the same code path', () => {
    const nonWrapping = { enabled: true, startHour: 1, endHour: 6 }
    expect(isQuietHour(0, nonWrapping)).toBe(false)
    expect(isQuietHour(1, nonWrapping)).toBe(true)
    expect(isQuietHour(5, nonWrapping)).toBe(true)
    expect(isQuietHour(6, nonWrapping)).toBe(false)
    expect(isQuietHour(23, nonWrapping)).toBe(false)
  })

  it('is never quiet when disabled', () => {
    expect(isQuietHour(23, { enabled: false, startHour: 21, endHour: 8 })).toBe(false)
  })
})

describe('nextAcceptableSend', () => {
  it('rolls a late-night send to 08:00 the NEXT Dublin morning', () => {
    // Sat 08 Aug 2026 22:44 Dublin → Sun 09 Aug 08:00 Dublin (07:00Z, IST).
    const slot = nextAcceptableSend(iso('2026-08-08T21:44:00Z'), DEFAULT_SEND_QUIET_HOURS)
    expect(slot.toISOString()).toBe('2026-08-09T07:00:00.000Z')
  })

  it('rolls a past-midnight send to 08:00 the SAME Dublin morning', () => {
    // Sun 09 Aug 2026 00:30 Dublin → 08:00 the same Dublin day.
    const slot = nextAcceptableSend(iso('2026-08-08T23:30:00Z'), DEFAULT_SEND_QUIET_HOURS)
    expect(slot.toISOString()).toBe('2026-08-09T07:00:00.000Z')
  })

  it('returns the candidate untouched outside quiet hours', () => {
    const at = iso('2026-08-08T09:00:00Z') // 10:00 Dublin
    expect(nextAcceptableSend(at, DEFAULT_SEND_QUIET_HOURS).toISOString()).toBe(at.toISOString())
  })

  it('crosses the SPRING-FORWARD boundary (the civil day is 23h long)', () => {
    // Sun 29 Mar 2026 00:30 Dublin (GMT). Dublin jumps 01:00 GMT → 02:00 IST.
    // 08:00 Dublin that morning is 07:00Z, not 08:00Z: naive +Nh arithmetic
    // from midnight would land an hour early.
    const slot = nextAcceptableSend(iso('2026-03-29T00:30:00Z'), DEFAULT_SEND_QUIET_HOURS)
    expect(slot.toISOString()).toBe('2026-03-29T07:00:00.000Z')
  })

  it('crosses the FALL-BACK boundary (the civil day is 25h long)', () => {
    // Sat 24 Oct 2026 22:30 Dublin (IST, 21:30Z) → 08:00 Sun 25 Oct Dublin
    // (GMT, 08:00Z). That is 10h30 later, NOT the 9h30 a fixed-offset
    // calculation would produce.
    const slot = nextAcceptableSend(iso('2026-10-24T21:30:00Z'), DEFAULT_SEND_QUIET_HOURS)
    expect(slot.toISOString()).toBe('2026-10-25T08:00:00.000Z')
  })

  it('skips a wall-clock hour that does not exist on the spring-forward day', () => {
    // Window 22:00 → 01:00. On 29 Mar 2026 there IS no 01:00 Dublin, so the
    // nominal slot is unreachable; the next hour that is genuinely outside
    // the window is 02:00 IST = 01:00Z.
    const cfg = { enabled: true, startHour: 22, endHour: 1 }
    const slot = nextAcceptableSend(iso('2026-03-29T00:10:00Z'), cfg)
    expect(slot.toISOString()).toBe('2026-03-29T01:00:00.000Z')
    expect(isQuietHour(dublinHourOf(slot), cfg)).toBe(false)
  })

  it('returns the candidate when quiet hours are off', () => {
    const at = iso('2026-08-08T21:44:00Z')
    const off = { enabled: false, startHour: 21, endHour: 8 }
    expect(nextAcceptableSend(at, off).toISOString()).toBe(at.toISOString())
  })
})

describe('evaluateSendTime', () => {
  it('flags the live 994-send incident and offers the next morning', () => {
    const at = iso('2026-08-08T21:44:00Z')
    const r = evaluateSendTime({ at, now: at, config: DEFAULT_SEND_QUIET_HOURS })
    expect(r.quiet).toBe(true)
    expect(r.timeLabel).toBe('22:44')
    expect(r.whenLabel).toBe('22:44 tonight')
    expect(r.windowLabel).toBe('21:00 to 08:00')
    expect(r.nextSlot.toISOString()).toBe('2026-08-09T07:00:00.000Z')
    expect(r.nextSlotLabel).toBe('08:00 tomorrow')
    expect(r.nextSlotIso).toBe('2026-08-09T07:00:00.000Z')
  })

  it('says nothing about a 20:00 send', () => {
    const at = iso('2026-08-08T19:10:00Z') // 20:10 Dublin
    const r = evaluateSendTime({ at, now: at, config: DEFAULT_SEND_QUIET_HOURS })
    expect(r.quiet).toBe(false)
    expect(r.nextSlot).toBeNull()
    expect(r.nextSlotLabel).toBeNull()
  })

  it('labels a scheduled slot on a later day by date, not "tomorrow"', () => {
    const now = iso('2026-08-08T09:00:00Z')          // Sat 08 Aug 10:00 Dublin
    const at = iso('2026-08-11T22:00:00Z')           // Tue 11 Aug 23:00 Dublin
    const r = evaluateSendTime({ at, now, config: DEFAULT_SEND_QUIET_HOURS })
    expect(r.quiet).toBe(true)
    expect(r.whenLabel).toBe('23:00 on Tue 11 Aug')
    expect(r.nextSlotLabel).toBe('08:00 on Wed 12 Aug')
  })

  it('reports quiet:false when the feature is switched off at the location', () => {
    const at = iso('2026-08-08T21:44:00Z')
    const r = evaluateSendTime({ at, now: at, config: { send_quiet_hours_enabled: false } })
    expect(r.enabled).toBe(false)
    expect(r.quiet).toBe(false)
  })

  it('treats the window as half-open at both edges', () => {
    const cfg = DEFAULT_SEND_QUIET_HOURS
    // 21:00 Dublin exactly — the first quiet hour.
    const start = iso('2026-08-09T20:00:00Z')
    expect(evaluateSendTime({ at: start, now: start, config: cfg }).quiet).toBe(true)
    // 08:00 Dublin exactly — the first hour that is NOT quiet.
    const end = iso('2026-08-09T07:00:00Z')
    expect(evaluateSendTime({ at: end, now: end, config: cfg }).quiet).toBe(false)
  })

  it('labels Dublin midnight as 00:00, not 24:00', () => {
    // 23:00Z in summer is 00:00 Dublin the next day; en-GB's hour12:false
    // formatter emits '24' there if left alone.
    const at = iso('2026-08-08T23:00:00Z')
    const r = evaluateSendTime({ at, now: at, config: DEFAULT_SEND_QUIET_HOURS })
    expect(r.timeLabel).toBe('00:00')
    expect(r.quiet).toBe(true)
    expect(r.nextSlotIso).toBe('2026-08-09T07:00:00.000Z')
  })

  it('is inert for an unparseable or missing candidate', () => {
    const now = iso('2026-08-08T21:44:00Z')
    expect(evaluateSendTime({ at: null, now }).quiet).toBe(false)
    expect(evaluateSendTime({ at: new Date('nonsense'), now }).quiet).toBe(false)
  })

  it('is pure: the same inputs give the same answer and `now` is never implicit', () => {
    const at = iso('2026-08-08T21:44:00Z')
    const a = evaluateSendTime({ at, now: iso('2026-08-08T21:44:00Z'), config: DEFAULT_SEND_QUIET_HOURS })
    const b = evaluateSendTime({ at, now: iso('2026-08-08T21:44:00Z'), config: DEFAULT_SEND_QUIET_HOURS })
    expect(a).toEqual(b)
    // A different `now` moves only the relative wording, never the verdict.
    const c = evaluateSendTime({ at, now: iso('2026-08-07T09:00:00Z'), config: DEFAULT_SEND_QUIET_HOURS })
    expect(c.quiet).toBe(true)
    expect(c.whenLabel).toBe('22:44 tomorrow')
  })

  it('accepts an ISO string or epoch ms as well as a Date', () => {
    const cfg = DEFAULT_SEND_QUIET_HOURS
    const fromIso = evaluateSendTime({ at: '2026-08-08T21:44:00Z', now: '2026-08-08T21:44:00Z', config: cfg })
    const fromMs = evaluateSendTime({ at: Date.parse('2026-08-08T21:44:00Z'), now: Date.parse('2026-08-08T21:44:00Z'), config: cfg })
    expect(fromIso.quiet).toBe(true)
    expect(fromMs.nextSlotIso).toBe('2026-08-09T07:00:00.000Z')
  })
})

// Local helper so the DST-gap test can assert on the resolved hour without
// exporting an internal.
function dublinHourOf(date) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: '2-digit', hour12: false,
  }).format(date)
  return Number(s) % 24
}
