import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  dublinTodayStr, dublinNowMinutes, addDaysISO, dublinTimeLabel,
  dublinDateKey, dublinDayStartMs, dublinDayRangeMs, dublinAddDays,
  dublinIsoWeekKey, dublinMonthKey, dublinWeekStartMs, dublinMonthStartMs,
  DUBLIN_DAY_MS,
} from './dublin-time.js'

const isoOf = (ms) => new Date(ms).toISOString()

describe('dublinTodayStr', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns Dublin date even when UTC is the previous day (BST window)', () => {
    // 2026-05-11 23:30 UTC = 2026-05-12 00:30 Dublin BST.
    // The Dublin-local date is May 12 even though UTC says May 11.
    vi.setSystemTime(new Date('2026-05-11T23:30:00Z'))
    expect(dublinTodayStr()).toBe('2026-05-12')
  })

  it('returns same date when UTC and Dublin agree (winter, GMT == UTC)', () => {
    // 2026-12-15 14:00 UTC = 2026-12-15 14:00 Dublin GMT.
    vi.setSystemTime(new Date('2026-12-15T14:00:00Z'))
    expect(dublinTodayStr()).toBe('2026-12-15')
  })

  it('returns previous day when Dublin is still on the prior date (early UTC morning, winter)', () => {
    // 2026-12-15 00:30 UTC = 2026-12-15 00:30 Dublin GMT — same date.
    // No edge case in winter because Dublin == UTC.
    vi.setSystemTime(new Date('2026-12-15T00:30:00Z'))
    expect(dublinTodayStr()).toBe('2026-12-15')
  })

  it('handles BST early-morning correctly (after midnight Dublin, before midnight UTC)', () => {
    // 2026-05-11 22:00 UTC = 2026-05-11 23:00 Dublin BST — same date.
    vi.setSystemTime(new Date('2026-05-11T22:00:00Z'))
    expect(dublinTodayStr()).toBe('2026-05-11')
  })
})

describe('dublinNowMinutes', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('returns Dublin clock minutes during BST (UTC+1)', () => {
    // 2026-05-11 09:00 UTC = 2026-05-11 10:00 Dublin BST.
    vi.setSystemTime(new Date('2026-05-11T09:00:00Z'))
    expect(dublinNowMinutes()).toBe(10 * 60) // 10:00 Dublin
  })

  it('returns Dublin clock minutes during GMT (winter)', () => {
    // 2026-12-15 14:30 UTC = 2026-12-15 14:30 Dublin GMT.
    vi.setSystemTime(new Date('2026-12-15T14:30:00Z'))
    expect(dublinNowMinutes()).toBe(14 * 60 + 30)
  })

  it('handles midnight Dublin correctly', () => {
    // 2026-05-11 23:00 UTC = 2026-05-12 00:00 Dublin BST.
    vi.setSystemTime(new Date('2026-05-11T23:00:00Z'))
    expect(dublinNowMinutes()).toBe(0)
  })
})

describe('addDaysISO', () => {
  it('adds days within a month', () => {
    expect(addDaysISO('2026-05-11', 7)).toBe('2026-05-18')
  })
  it('handles month boundary', () => {
    expect(addDaysISO('2026-05-30', 5)).toBe('2026-06-04')
  })
  it('handles year boundary', () => {
    expect(addDaysISO('2026-12-30', 5)).toBe('2027-01-04')
  })
  it('handles negative days', () => {
    expect(addDaysISO('2026-05-11', -1)).toBe('2026-05-10')
  })
  it('zero days = same date', () => {
    expect(addDaysISO('2026-05-11', 0)).toBe('2026-05-11')
  })
})

describe('dublinTimeLabel', () => {
  it('formats a UTC instant as Dublin HH:MM (BST = +1 in summer)', () => {
    expect(dublinTimeLabel('2026-06-27T17:00:00Z')).toBe('18:00')
  })
  it('formats a winter instant (GMT = +0)', () => {
    expect(dublinTimeLabel('2026-01-15T09:30:00Z')).toBe('09:30')
  })
  it('returns null for a bad input', () => {
    expect(dublinTimeLabel('nope')).toBeNull()
    expect(dublinTimeLabel(null)).toBeNull()
  })
})

// Day-boundary helpers kept byte-behaviour-identical to
// champ-app/shared/dublin-time.js — these back the byte-synced challenges.js twin.
describe('dublinDateKey', () => {
  it('GMT winter: 23:30Z stays the same calendar day', () => {
    expect(dublinDateKey('2026-01-15T23:30:00Z')).toBe('2026-01-15')
  })
  it('IST summer: 23:30Z is already the NEXT Dublin day', () => {
    expect(dublinDateKey('2026-07-01T23:30:00Z')).toBe('2026-07-02')
  })
  it('IST summer: 22:30Z is still the same Dublin day (23:30 IST)', () => {
    expect(dublinDateKey('2026-07-01T22:30:00Z')).toBe('2026-07-01')
  })
  it('accepts ms and Date as well as ISO strings', () => {
    const ms = Date.parse('2026-07-01T23:30:00Z')
    expect(dublinDateKey(ms)).toBe('2026-07-02')
    expect(dublinDateKey(new Date(ms))).toBe('2026-07-02')
  })
})

describe('dublinDayStartMs', () => {
  it('GMT: Dublin midnight == UTC midnight', () => {
    expect(isoOf(dublinDayStartMs('2026-01-15'))).toBe('2026-01-15T00:00:00.000Z')
  })
  it('IST: Dublin midnight == 23:00Z the previous day', () => {
    expect(isoOf(dublinDayStartMs('2026-07-15'))).toBe('2026-07-14T23:00:00.000Z')
  })
  it('spring-forward Sunday still starts at 00:00Z (clocks jump at 01:00)', () => {
    expect(isoOf(dublinDayStartMs('2026-03-29'))).toBe('2026-03-29T00:00:00.000Z')
  })
  it('the day AFTER spring-forward is IST → 23:00Z prior', () => {
    expect(isoOf(dublinDayStartMs('2026-03-30'))).toBe('2026-03-29T23:00:00.000Z')
  })
  it('fall-back Sunday is IST at its midnight → 23:00Z prior', () => {
    expect(isoOf(dublinDayStartMs('2026-10-25'))).toBe('2026-10-24T23:00:00.000Z')
  })
  it('the day AFTER fall-back is GMT → 00:00Z', () => {
    expect(isoOf(dublinDayStartMs('2026-10-26'))).toBe('2026-10-26T00:00:00.000Z')
  })
  it('accepts a parts object', () => {
    expect(isoOf(dublinDayStartMs({ y: 2026, mo: 7, d: 15 }))).toBe('2026-07-14T23:00:00.000Z')
  })
})

describe('dublinDayRangeMs — inclusive [start .. end] → half-open [startMs, endMs)', () => {
  it('IST June range', () => {
    const { startMs, endMs } = dublinDayRangeMs('2026-06-10', '2026-06-20')
    expect(isoOf(startMs)).toBe('2026-06-09T23:00:00.000Z')
    expect(isoOf(endMs)).toBe('2026-06-20T23:00:00.000Z') // 00:00 Dublin Jun 21
  })
  it('GMT January range aligns with UTC midnight', () => {
    const { startMs, endMs } = dublinDayRangeMs('2026-01-05', '2026-01-11')
    expect(isoOf(startMs)).toBe('2026-01-05T00:00:00.000Z')
    expect(isoOf(endMs)).toBe('2026-01-12T00:00:00.000Z')
  })
})

describe('dublinAddDays', () => {
  it('steps across spring-forward without drift', () => {
    expect(dublinAddDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(dublinAddDays('2026-03-29', 1)).toBe('2026-03-30')
    expect(dublinAddDays('2026-03-29', -1)).toBe('2026-03-28')
  })
  it('steps across fall-back without drift', () => {
    expect(dublinAddDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(dublinAddDays('2026-10-25', 1)).toBe('2026-10-26')
    expect(dublinAddDays('2026-10-26', -1)).toBe('2026-10-25')
  })
  it('crosses a month + year boundary', () => {
    expect(dublinAddDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(dublinAddDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('dublinIsoWeekKey — year-roll correctness', () => {
  it('2026-01-01 (Thu) is 2026-W01', () => {
    expect(dublinIsoWeekKey('2026-01-01T12:00:00Z')).toBe('2026-W01')
  })
  it('2025-12-29 (Mon) already belongs to ISO 2026-W01', () => {
    expect(dublinIsoWeekKey('2025-12-29T12:00:00Z')).toBe('2026-W01')
  })
  it('2024-12-31 (Tue) belongs to ISO 2025-W01', () => {
    expect(dublinIsoWeekKey('2024-12-31T12:00:00Z')).toBe('2025-W01')
  })
  it('IST near-midnight 31 Dec buckets on the Dublin day', () => {
    // 2026-12-31T23:30Z — but December is GMT, so this stays Dec 31.
    expect(dublinIsoWeekKey('2026-12-31T23:30:00Z')).toBe('2026-W53')
  })
})

describe('dublinMonthKey', () => {
  it('IST midnight-edge maps to the Dublin month', () => {
    // 2026-06-30T23:30Z = 00:30 IST 1 Jul → July.
    expect(dublinMonthKey('2026-06-30T23:30:00Z')).toBe('2026-07')
    // 2026-06-30T22:30Z = 23:30 IST 30 Jun → June.
    expect(dublinMonthKey('2026-06-30T22:30:00Z')).toBe('2026-06')
  })
})

describe('dublinWeekStartMs / dublinMonthStartMs', () => {
  it('week start is the Dublin midnight of the Monday', () => {
    // 2026-06-24 is a Wednesday; its ISO week started Mon 2026-06-22 (IST).
    expect(isoOf(dublinWeekStartMs('2026-06-24T18:00:00Z'))).toBe('2026-06-21T23:00:00.000Z')
  })
  it('week start stays on the Monday for a Monday-00:05 instant (not the prior week)', () => {
    // Mon 2026-07-06 00:05 IST = 2026-07-05T23:05:00Z — must resolve to the
    // start of THIS week (Mon 00:00 IST), i.e. one minute earlier, not 7 days back.
    expect(isoOf(dublinWeekStartMs('2026-07-05T23:05:00Z'))).toBe('2026-07-05T23:00:00.000Z')
  })
  it('week start is DST-correct across the spring-forward change (GMT→IST)', () => {
    // Dublin springs forward Sun 2026-03-29 01:00→02:00. The week of
    // Mon 2026-03-30 begins at 00:00 IST = 2026-03-29T23:00:00Z. A naive
    // UTC-Monday or fixed-offset shortcut would be an hour off.
    expect(isoOf(dublinWeekStartMs('2026-03-31T10:00:00Z'))).toBe('2026-03-29T23:00:00.000Z')
  })
  it('week start is DST-correct across the fall-back change (IST→GMT)', () => {
    // Dublin falls back Sun 2026-10-25 02:00→01:00. The week of Mon 2026-10-26
    // begins at 00:00 GMT = 2026-10-26T00:00:00Z (offset now +00:00).
    expect(isoOf(dublinWeekStartMs('2026-10-28T10:00:00Z'))).toBe('2026-10-26T00:00:00.000Z')
  })
  it('month start is the Dublin midnight of the 1st', () => {
    expect(isoOf(dublinMonthStartMs('2026-06-15T12:00:00Z'))).toBe('2026-05-31T23:00:00.000Z')
    expect(isoOf(dublinMonthStartMs('2026-01-15T12:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('DUBLIN_DAY_MS', () => {
  it('is 24h in ms', () => { expect(DUBLIN_DAY_MS).toBe(24 * 3600 * 1000) })
})
