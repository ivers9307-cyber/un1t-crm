import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TZ, isValidTz, resolveTz, dayStrInTz, wallMsInTz, dayStartMsInTz, nextLocalMidnightMs,
} from './tz-time'
import { dublinDayStr } from './dublin-time'

const NY = 'America/New_York'
const BERLIN = 'Europe/Berlin'
const LORD_HOWE = 'Australia/Lord_Howe'

describe('resolveTz', () => {
  it('falls back to Dublin for null, blank and garbage', () => {
    expect(resolveTz(null)).toBe(DEFAULT_TZ)
    expect(resolveTz('')).toBe(DEFAULT_TZ)
    expect(resolveTz('Mars/Olympus')).toBe(DEFAULT_TZ)
  })
  it('keeps a valid zone', () => {
    expect(resolveTz(NY)).toBe(NY)
    expect(isValidTz(NY)).toBe(true)
    expect(isValidTz('nope')).toBe(false)
  })
})

describe('dayStrInTz', () => {
  it('matches dublinDayStr for Dublin across a BST evening and both DST transitions', () => {
    for (const iso of ['2026-07-06T22:30:00Z', '2026-07-06T23:30:00Z', '2026-03-29T00:30:00Z', '2026-10-25T01:30:00Z']) {
      expect(dayStrInTz(Date.parse(iso))).toBe(dublinDayStr(Date.parse(iso)))
    }
  })
  it('keys a late US evening to the local day, not the UTC day', () => {
    expect(dayStrInTz(Date.parse('2026-07-07T03:30:00Z'), NY)).toBe('2026-07-06')
  })
})

describe('wallMsInTz', () => {
  it('resolves a Dublin IST wall-clock exactly (UTC+1)', () => {
    expect(wallMsInTz('2026-07-06', '07:00')).toBe(Date.parse('2026-07-06T07:00:00+01:00'))
  })
  it('resolves a Dublin GMT wall-clock exactly (UTC+0)', () => {
    expect(wallMsInTz('2026-01-12', '07:00')).toBe(Date.parse('2026-01-12T07:00:00+00:00'))
  })
  it('is a whole day right for a negative-offset zone (the old minute-of-day bug)', () => {
    expect(wallMsInTz('2026-07-06', '07:00', NY)).toBe(Date.parse('2026-07-06T07:00:00-04:00'))
    expect(wallMsInTz('2026-07-06', '00:00', NY)).toBe(Date.parse('2026-07-06T00:00:00-04:00'))
  })
  it('handles the New York spring-forward day', () => {
    expect(wallMsInTz('2026-03-08', '07:00', NY)).toBe(Date.parse('2026-03-08T07:00:00-04:00'))
  })
  it('returns null for a malformed time', () => {
    expect(wallMsInTz('2026-07-06', '7:00')).toBe(null)
    expect(wallMsInTz('2026-07-06', undefined)).toBe(null)
  })
})

// A single correction pass samples the zone's offset at the naive guess, which
// is on the WRONG SIDE of a DST transition for a band of wall-clock times on
// each transition day in any zone whose standard offset is not 0. These are the
// cases a one-pass implementation gets wrong by exactly the DST step; they were
// found by sweeping an independent oracle over 2025-2027 in 12 zones.
describe('wallMsInTz — the second correction pass', () => {
  it('resolves the post-jump band on the New York spring-forward day', () => {
    // 02:00 EST → 03:00 EDT. 03:00-06:59 local reads back as EST at the guess.
    expect(wallMsInTz('2026-03-08', '03:00', NY)).toBe(Date.parse('2026-03-08T03:00:00-04:00'))
    expect(wallMsInTz('2026-03-08', '06:45', NY)).toBe(Date.parse('2026-03-08T06:45:00-04:00'))
  })
  it('resolves the post-fall-back band on the New York fall-back day', () => {
    // 02:00 EDT → 01:00 EST. 02:00-05:59 local reads back as EDT at the guess.
    expect(wallMsInTz('2026-11-01', '03:00', NY)).toBe(Date.parse('2026-11-01T03:00:00-05:00'))
    expect(wallMsInTz('2026-11-01', '05:45', NY)).toBe(Date.parse('2026-11-01T05:45:00-05:00'))
  })
  it('is exact for a positive non-zero standard offset (Berlin, UTC+1/+2)', () => {
    // 01:30 on the spring-forward day is still CET, but the naive guess for it
    // lands past 01:00 UTC and so reads back as CEST.
    expect(wallMsInTz('2026-03-29', '01:30', BERLIN)).toBe(Date.parse('2026-03-29T01:30:00+01:00'))
    // Mirror image on the fall-back day: 01:00 is still CEST, guess reads CET.
    expect(wallMsInTz('2026-10-25', '01:00', BERLIN)).toBe(Date.parse('2026-10-25T01:00:00+02:00'))
  })
  it('is exact for a half-hour DST step (Lord Howe, +10:30/+11:00)', () => {
    // Far-east zone: the naive guess for Sat 15:30 lands past SUNDAY's 02:00
    // DST end, so it reads the wrong offset AND the wrong calendar day.
    expect(wallMsInTz('2026-04-04', '15:30', LORD_HOWE))
      .toBe(Date.parse('2026-04-04T15:30:00+11:00'))
  })
  it('is exact for a zone with no DST at all', () => {
    expect(wallMsInTz('2026-07-06', '07:00', 'Asia/Kolkata'))
      .toBe(Date.parse('2026-07-06T07:00:00+05:30'))
  })
})

// No instant maps to a nonexistent wall-clock, and two map to an ambiguous one.
// Both must stay DETERMINISTIC and must keep the conventions the Dublin engine
// in src/lib/schedule/desired-state.js already documents and accepts, because
// that engine is being moved onto this module.
describe('wallMsInTz — DST gap and overlap conventions', () => {
  it('resolves a nonexistent Dublin time to the earlier instant', () => {
    // 01:30 does not exist on 2026-03-29 (Dublin skips 01:00 → 02:00).
    expect(wallMsInTz('2026-03-29', '01:30')).toBe(Date.parse('2026-03-29T00:30:00+00:00'))
  })
  it('resolves an ambiguous Dublin time to the later (post-fall-back) instant', () => {
    // 01:30 happens twice on 2026-10-25; the engine takes the +00:00 one.
    expect(wallMsInTz('2026-10-25', '01:30')).toBe(Date.parse('2026-10-25T01:30:00+00:00'))
  })
  it('resolves a nonexistent New York time to the earlier instant', () => {
    expect(wallMsInTz('2026-03-08', '02:30', NY)).toBe(Date.parse('2026-03-08T01:30:00-05:00'))
  })
})

// The engine's private dublinWallMs corrects by minute-of-day, so a read-back
// that rolls onto the NEXT calendar date is a whole day out. That bites Dublin
// itself at 23:00-23:59 during IST — not just negative-offset zones.
describe('wallMsInTz — late-evening IST (the whole-day case for Dublin)', () => {
  it('keeps a 23:00 IST boundary on its own calendar day', () => {
    expect(wallMsInTz('2026-07-06', '23:00')).toBe(Date.parse('2026-07-06T23:00:00+01:00'))
    expect(wallMsInTz('2026-07-06', '23:30')).toBe(Date.parse('2026-07-06T23:30:00+01:00'))
  })
  it('round-trips every quarter-hour of an IST day back to the same wall-clock', () => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    for (let mins = 0; mins < 1440; mins += 15) {
      const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
      expect(fmt.format(new Date(wallMsInTz('2026-07-06', hhmm)))).toBe(hhmm)
    }
  })
})

describe('dayStartMsInTz / nextLocalMidnightMs', () => {
  it('dayStart is 00:00 local', () => {
    expect(dayStartMsInTz('2026-07-06', NY)).toBe(Date.parse('2026-07-06T00:00:00-04:00'))
  })
  it('next midnight on a 23h Dublin day (spring forward 2026-03-29)', () => {
    const at = Date.parse('2026-03-29T03:00:00+01:00')
    expect(nextLocalMidnightMs(at, 'Europe/Dublin')).toBe(Date.parse('2026-03-30T00:00:00+01:00'))
  })
  it('next midnight on a 25h Dublin day (fall back 2026-10-25)', () => {
    const at = Date.parse('2026-10-25T12:00:00+00:00')
    expect(nextLocalMidnightMs(at, 'Europe/Dublin')).toBe(Date.parse('2026-10-26T00:00:00+00:00'))
  })
})
