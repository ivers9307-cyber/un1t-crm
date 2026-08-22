import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TZ, isValidTz, resolveTz, dayStrInTz, wallMsInTz, dayStartMsInTz, nextLocalMidnightMs,
} from './tz-time'
import { dublinDayStr } from './dublin-time'

const NY = 'America/New_York'
const BERLIN = 'Europe/Berlin'
const LORD_HOWE = 'Australia/Lord_Howe'
const SANTIAGO = 'America/Santiago'

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
  // The overlap convention is deterministic but NOT uniform across zones, and
  // that is deliberate — either instant is genuinely that wall-clock. Pinned so
  // the asymmetry is a recorded decision rather than a surprise.
  it('resolves an ambiguous New York time to the EARLIER instant', () => {
    // 01:30 happens twice on 2026-11-01; a negative standard offset takes the
    // first (EDT) one, where Dublin above takes the second.
    expect(wallMsInTz('2026-11-01', '01:30', NY)).toBe(Date.parse('2026-11-01T05:30:00Z'))
  })
})

// A day boundary that lands on the previous local day is not a day boundary.
// In zones whose DST starts at 00:00 local, local midnight does not exist, and
// the general gap rule (earlier) would put it at 23:00 the day before.
describe('dayStartMsInTz — a skipped local midnight', () => {
  it('resolves to the transition instant, not 23:00 the day before', () => {
    // Chile 2025-09-07: local jumps 06-09 23:59 -> 07-09 01:00 at 04:00Z.
    expect(dayStartMsInTz('2025-09-07', SANTIAGO)).toBe(Date.parse('2025-09-07T04:00:00Z'))
    expect(dayStrInTz(dayStartMsInTz('2025-09-07', SANTIAGO), SANTIAGO)).toBe('2025-09-07')
  })
  it('keeps nextLocalMidnightMs strictly after its input across that gap', () => {
    const at = Date.parse('2025-09-07T02:30:00Z')
    const next = nextLocalMidnightMs(at, SANTIAGO)
    expect(next).toBeGreaterThan(at)
    // "Strictly after" alone is too weak to catch this: 23:00 on the PREVIOUS
    // local day is also strictly after 02:30Z. The boundary must open the day.
    expect(dayStrInTz(next, SANTIAGO)).toBe('2025-09-07')
  })
  it('always lands on its own local day, every day of 2026, in 4 zones', () => {
    for (const tz of ['Europe/Dublin', NY, 'Pacific/Auckland', SANTIAGO]) {
      for (const day of daysOf2026()) {
        expect(dayStrInTz(dayStartMsInTz(day, tz), tz)).toBe(day)
      }
    }
  })
  it('never returns an instant at or before the previous local midnight', () => {
    for (const tz of ['Europe/Dublin', NY, SANTIAGO]) {
      for (const day of daysOf2026().slice(0, 300)) {
        const prev = dayStartMsInTz(day, tz)
        const next = nextLocalMidnightMs(prev, tz)
        expect(next).toBeGreaterThan(prev)
      }
    }
  })
})

describe('dayStrInTz — input contract', () => {
  it('accepts a Date, epoch ms and an ISO string alike', () => {
    const iso = '2026-07-06T22:30:00Z'
    expect(dayStrInTz(iso)).toBe('2026-07-06')
    expect(dayStrInTz(Date.parse(iso))).toBe('2026-07-06')
    expect(dayStrInTz(new Date(iso))).toBe('2026-07-06')
  })
  it('throws a named RangeError rather than silently returning 1970-01-01', () => {
    expect(() => dayStrInTz(null)).toThrow(RangeError)
    expect(() => dayStrInTz(null)).toThrow(/invalid instant/)
    expect(() => dayStrInTz('not a date')).toThrow(RangeError)
    expect(() => dayStrInTz(NaN)).toThrow(RangeError)
    // Every one of these coerces to 0 under Number(), i.e. '1970-01-01'.
    for (const falsy of [null, '', '   ', false, []]) {
      expect(() => dayStrInTz(falsy)).toThrow(RangeError)
    }
  })
  it('still means "now" when omitted', () => {
    expect(dayStrInTz()).toBe(dublinDayStr(Date.now()))
    expect(dayStrInTz(undefined, NY)).toBe(dayStrInTz(Date.now(), NY))
  })
})

// A fixed offset has no DST, so accepting one would be silently an hour wrong
// for half the year — the exact bug this module exists to remove.
describe('resolveTz — IANA names only', () => {
  it('rejects fixed offsets and Etc/GMT pseudo-zones', () => {
    for (const bad of ['+05:30', '-0800', 'Etc/GMT+5']) {
      expect(isValidTz(bad)).toBe(false)
      expect(resolveTz(bad)).toBe(DEFAULT_TZ)
    }
  })
  it('canonicalises case', () => {
    expect(resolveTz('europe/dublin')).toBe('Europe/Dublin')
    expect(resolveTz('AMERICA/NEW_YORK')).toBe(NY)
  })
  it('accepts UTC, which is not in supportedValuesOf', () => {
    expect(isValidTz('UTC')).toBe(true)
    expect(resolveTz('UTC')).toBe('UTC')
  })
})

describe('wallMsInTz — range and calendar checks', () => {
  it('rejects out-of-range clock values', () => {
    for (const bad of ['99:99', '25:00', '24:00', '07:60', '7:00', '0700']) {
      expect(wallMsInTz('2026-07-06', bad)).toBe(null)
    }
  })
  it('rejects malformed and impossible dates instead of rolling them over', () => {
    for (const bad of ['2026-13-45', '26-07-06', '2026-7-6', '2026-02-30', '', null]) {
      expect(wallMsInTz(bad, '07:00')).toBe(null)
    }
    expect(dayStartMsInTz('2026-02-30', NY)).toBe(null)
  })
  it('still accepts the real leap day', () => {
    expect(wallMsInTz('2028-02-29', '07:00')).toBe(Date.parse('2028-02-29T07:00:00Z'))
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
  it('round-trips every quarter-hour of an IST day to the same DATE and time', () => {
    // The date half is the point: an HH:MM-only comparison cannot see a
    // whole-day-late result, which is exactly the bug this block is named for.
    for (let mins = 0; mins < 1440; mins += 15) {
      const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
      expect(localStamp(wallMsInTz('2026-07-06', hhmm), DEFAULT_TZ)).toBe(`2026-07-06 ${hhmm}`)
    }
  })
})

// The invariant every caller depends on, swept rather than sampled: resolving a
// wall-clock and reading it back must return the same LOCAL DATE and the same
// wall-clock. Four zones chosen to span the failure modes — UTC-anchored,
// negative offset, far-east (guess crosses the dateline into the next local
// day), and a zone whose DST starts at local midnight.
describe('wallMsInTz — round-trip property over every day of 2026', () => {
  it('holds for 4 zones x 366 days x 4 times, except in a DST gap', () => {
    let checked = 0
    let gaps = 0
    for (const tz of ['Europe/Dublin', NY, 'Pacific/Auckland', SANTIAGO]) {
      for (const day of daysOf2026()) {
        for (const t of ['00:00', '07:00', '12:30', '23:30']) {
          const ms = wallMsInTz(day, t, tz)
          if (!wallClockExists(day, t, tz)) { gaps++; continue }
          expect(localStamp(ms, tz)).toBe(`${day} ${t}`)
          expect(dayStrInTz(ms, tz)).toBe(day)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(5800)
    expect(gaps).toBeGreaterThan(0) // the sweep really does cross spring-forward
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
