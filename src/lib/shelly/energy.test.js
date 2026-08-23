import { describe, it, expect } from 'vitest'
import { rollDailyEnergy } from './energy'

const at = (s) => `2026-07-06T${s}.000Z`

describe('rollDailyEnergy', () => {
  it('first sample ever opens today with zero consumption', () => {
    expect(rollDailyEnergy(null, { total_wh: 1000, at: at('06:00:00') }, '2026-07-06')).toEqual({
      day: '2026-07-06', wh_start: 1000, wh_last: 1000, wh_total: 0, samples: 1, resets: 0,
      first_sample_at: at('06:00:00'), last_sample_at: at('06:00:00'),
    })
  })
  it('same day accumulates the positive delta', () => {
    const prev = { day: '2026-07-06', wh_start: 1000, wh_last: 1000, wh_total: 0, samples: 1, resets: 0, first_sample_at: at('06:00:00'), last_sample_at: at('06:00:00') }
    expect(rollDailyEnergy(prev, { total_wh: 1007.5, at: at('06:01:00') }, '2026-07-06')).toMatchObject({ wh_last: 1007.5, wh_total: 7.5, samples: 2, last_sample_at: at('06:01:00') })
  })
  it('a new day starts from yesterday\'s wh_last so the straddling minute lands in today', () => {
    const prev = { day: '2026-07-05', wh_start: 900, wh_last: 1000, wh_total: 100, samples: 1440, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 1003, at: at('00:00:30') }, '2026-07-06')).toMatchObject({ day: '2026-07-06', wh_start: 1000, wh_last: 1003, wh_total: 3, samples: 1, resets: 0 })
  })
  it('a drop to under half the previous value is a reset: count from zero and record it', () => {
    const prev = { day: '2026-07-06', wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 12, at: at('10:00:00') }, '2026-07-06')).toMatchObject({ wh_last: 12, wh_total: 52, resets: 1 })
  })
  it('a small rollback (flash-save lag after a power cut) counts nothing and is not a reset', () => {
    const prev = { day: '2026-07-06', wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 49990, at: at('10:00:00') }, '2026-07-06')).toMatchObject({ wh_last: 49990, wh_total: 40, resets: 0 })
  })
  it('non-finite or negative totals produce no row', () => {
    expect(rollDailyEnergy(null, { total_wh: null, at: 'x' }, '2026-07-06')).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: -1, at: 'x' }, '2026-07-06')).toBe(null)
  })
})

// Everything below is about the row and the sample arriving as HOSTILE
// SHAPES: PostgREST hands numerics back as strings, a device can report an
// absent reading, and every column here is NOT NULL with a >= 0 CHECK.
const DAY = '2026-07-06'
const today = (over = {}) => ({
  day: DAY, wh_start: 1000, wh_last: 1000, wh_total: 0, samples: 1, resets: 0,
  first_sample_at: at('06:00:00'), last_sample_at: at('06:00:00'), ...over,
})
const NUMERIC_COLS = ['wh_start', 'wh_last', 'wh_total', 'samples', 'resets']

describe('rollDailyEnergy — unusable samples', () => {
  // Number('') === 0, Number(false) === 0, Number([]) === 0 and Number(null)
  // === 0: coercing with Number() and testing isFinite reads every one of
  // these as a real 0 Wh counter and mints a row from it. Number(true) === 1
  // is worse still — a fabricated 1 Wh reading.
  it('rejects the shapes Number() would silently turn into a reading', () => {
    for (const v of [null, undefined, '', '   ', false, true, [], [5], {}, 'abc', NaN, Infinity, -Infinity, -0.5]) {
      expect(rollDailyEnergy(null, { total_wh: v, at: at('06:00:00') }, DAY), String(v)).toBe(null)
    }
  })
  it('rejects a missing sample, and a missing or blank timestamp (both columns are NOT NULL)', () => {
    expect(rollDailyEnergy(null, null, DAY)).toBe(null)
    expect(rollDailyEnergy(null, undefined, DAY)).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: 1000 }, DAY)).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: 1000, at: '' }, DAY)).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: 1000, at: '   ' }, DAY)).toBe(null)
    expect(rollDailyEnergy(null, { total_wh: 1000, at: 42 }, DAY)).toBe(null)
    expect(rollDailyEnergy(today(), { total_wh: 1001, at: null }, DAY)).toBe(null)
  })
  it('rejects a total past the column ceiling, which is corruption rather than a reading', () => {
    // numeric(14,3) holds 11 integer digits, and a uint32 Wh counter caps at
    // 4.29e9 — so 1e11 is unstorable AND impossible. One unstorable row fails
    // the bulk upsert for every device at the location.
    for (const v of [1e11, 1e11 + 1, 1e12, 9.9e15, '1e11', '100000000000']) {
      expect(rollDailyEnergy(null, { total_wh: v, at: at('06:00:00') }, DAY), String(v)).toBe(null)
    }
    // The boundary is exclusive: the largest storable reading still rolls.
    expect(rollDailyEnergy(null, { total_wh: 1e11 - 1, at: at('06:00:00') }, DAY))
      .toMatchObject({ wh_last: 99999999999, wh_total: 0 })
  })
  it('a ceiling-breaking sample does not disturb the day it was rejected from', () => {
    const prev = today({ wh_total: 40, samples: 10 })
    expect(rollDailyEnergy(prev, { total_wh: 1e12, at: at('06:01:00') }, DAY)).toBe(null)
    // The next good sample carries on from the row as if nothing happened.
    expect(rollDailyEnergy(prev, { total_wh: 1003, at: at('06:02:00') }, DAY))
      .toMatchObject({ wh_total: 43, samples: 11 })
  })
  it('accepts a numeric string total (a stringly-typed body is cheap to tolerate)', () => {
    expect(rollDailyEnergy(today(), { total_wh: '1007.500', at: at('06:01:00') }, DAY))
      .toMatchObject({ wh_last: 1007.5, wh_total: 7.5 })
  })
  it('0 Wh is a real reading from a fresh counter, not junk', () => {
    expect(rollDailyEnergy(null, { total_wh: 0, at: at('06:00:00') }, DAY))
      .toMatchObject({ wh_start: 0, wh_last: 0, wh_total: 0, samples: 1 })
  })
})

describe('rollDailyEnergy — numerics arriving as strings from PostgREST', () => {
  it('coerces every numeric column on the way out, so none reaches the upsert as a string', () => {
    const prev = today({ wh_start: '1000.000', wh_last: '1000.000', wh_total: '0.000', samples: '1', resets: '0' })
    const row = rollDailyEnergy(prev, { total_wh: 1007.5, at: at('06:01:00') }, DAY)
    expect(row).toMatchObject({ wh_start: 1000, wh_last: 1007.5, wh_total: 7.5, samples: 2, resets: 0 })
    for (const k of NUMERIC_COLS) {
      expect(typeof row[k], k).toBe('number')
      expect(Number.isFinite(row[k]), k).toBe(true)
      expect(row[k] >= 0, k).toBe(true)
    }
  })
  it('a past day whose wh_last is a string still seeds today from it', () => {
    const prev = { day: '2026-07-05', wh_start: '900.000', wh_last: '1000.000', wh_total: '100.000', samples: '1440', resets: '0', first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 1003, at: at('00:00:30') }, DAY))
      .toMatchObject({ day: DAY, wh_start: 1000, wh_last: 1003, wh_total: 3, samples: 1 })
  })
  it('junk numerics never leak NaN into a NOT NULL column', () => {
    const prev = today({ wh_start: 'oops', wh_last: 'oops', wh_total: 'oops', samples: 'oops', resets: 'oops' })
    const row = rollDailyEnergy(prev, { total_wh: 1003, at: at('06:01:00') }, DAY)
    for (const k of NUMERIC_COLS) {
      expect(Number.isFinite(row[k]), k).toBe(true)
      expect(row[k] >= 0, k).toBe(true)
    }
    // No readable baseline, so nothing is counted — rather than a whole
    // counter's worth of consumption being invented from a delta off zero.
    expect(row).toMatchObject({ wh_last: 1003, wh_total: 0, samples: 1, resets: 0 })
  })
  it('a negative stored column is corruption, not a baseline: it must not inflate the delta', () => {
    // Every column carries a >= 0 CHECK, so a negative one cannot have been
    // written by this file. Using -5 as the baseline would book 5 Wh that
    // never flowed; ignoring it counts nothing this tick instead.
    const prev = today({ wh_last: -5, wh_total: -40, samples: -3, resets: -1 })
    const row = rollDailyEnergy(prev, { total_wh: 1003, at: at('06:01:00') }, DAY)
    expect(row).toMatchObject({ wh_last: 1003, wh_total: 0, samples: 1, resets: 0 })
    for (const k of NUMERIC_COLS) expect(row[k] >= 0, k).toBe(true)
  })
  it('samples and resets stay whole numbers even when the stored count is fractional', () => {
    // samples/resets are counts in an integer column: 1.5 + 1 = 2.5 would be
    // rejected outright, so a fractional stored count is truncated first.
    const row = rollDailyEnergy(today({ samples: '1.5', resets: '2.9', wh_last: 50000 }), { total_wh: 5, at: at('06:01:00') }, DAY)
    expect(row).toMatchObject({ samples: 2, resets: 3 })
    expect(Number.isInteger(row.samples)).toBe(true)
    expect(Number.isInteger(row.resets)).toBe(true)
  })
  it('an unreadable count folds to zero rather than failing the location\'s write', () => {
    const row = rollDailyEnergy(today({ samples: 'x', resets: -4 }), { total_wh: 1001, at: at('06:01:00') }, DAY)
    expect(row).toMatchObject({ samples: 1, resets: 0 })
  })
  it('an absent first_sample_at is filled from this sample rather than upserting null', () => {
    const prev = today({ first_sample_at: null })
    expect(rollDailyEnergy(prev, { total_wh: 1001, at: at('06:01:00') }, DAY))
      .toMatchObject({ first_sample_at: at('06:01:00'), last_sample_at: at('06:01:00') })
  })
  it('carries the row\'s other columns through so the cron can upsert it whole', () => {
    const prev = today({ device_id: 'dev-uuid', location_id: 'loc-uuid' })
    expect(rollDailyEnergy(prev, { total_wh: 1001, at: at('06:01:00') }, DAY))
      .toMatchObject({ device_id: 'dev-uuid', location_id: 'loc-uuid' })
  })
})

describe('rollDailyEnergy — the day key', () => {
  it('stamps the canonical local day, never the shape the previous row carried', () => {
    const prev = today({ day: '2026-07-06T00:00:00+00:00' })
    const row = rollDailyEnergy(prev, { total_wh: 1007.5, at: at('06:01:00') }, DAY)
    // Same local day, so the row continues (samples 2) — and the stale
    // timestamp shape does not survive into the (device_id, day) upsert key.
    expect(row).toMatchObject({ day: DAY, samples: 2, wh_total: 7.5 })
  })
  it('tolerates a hydrated Date for day rather than restarting the day', () => {
    const prev = today({ day: new Date('2026-07-06T00:00:00Z') })
    expect(rollDailyEnergy(prev, { total_wh: 1007.5, at: at('06:01:00') }, DAY))
      .toMatchObject({ day: DAY, samples: 2, wh_total: 7.5 })
  })
  it('an unreadable day is treated as a different day: under-report, never over-report', () => {
    const prev = today({ day: null, wh_total: 40, samples: 10 })
    // The 40 Wh already banked against an unknown day must not be inherited.
    expect(rollDailyEnergy(prev, { total_wh: 1003, at: at('06:01:00') }, DAY))
      .toMatchObject({ day: DAY, wh_start: 1000, wh_last: 1003, wh_total: 3, samples: 1 })
  })
  it('a cron outage of several days still lands the whole gap in today', () => {
    const prev = { day: '2026-07-01', wh_start: 900, wh_last: 1000, wh_total: 100, samples: 12, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    expect(rollDailyEnergy(prev, { total_wh: 5000, at: at('09:00:00') }, DAY))
      .toMatchObject({ day: DAY, wh_start: 1000, wh_total: 4000, samples: 1 })
  })
})

describe('rollDailyEnergy — resets and rollbacks', () => {
  it('a drop to exactly half is a rollback, not a reset (the rule is UNDER half)', () => {
    const prev = today({ wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10 })
    expect(rollDailyEnergy(prev, { total_wh: 25000, at: at('10:00:00') }, DAY))
      .toMatchObject({ wh_last: 25000, wh_total: 40, resets: 0 })
  })
  it('one Wh under half is a reset', () => {
    const prev = today({ wh_start: 50000, wh_last: 50000, wh_total: 40, samples: 10 })
    expect(rollDailyEnergy(prev, { total_wh: 24999, at: at('10:00:00') }, DAY))
      .toMatchObject({ wh_last: 24999, wh_total: 25039, resets: 1 })
  })
  it('a zero baseline cannot produce a reset (0 is not under 0/2)', () => {
    const prev = today({ wh_start: 0, wh_last: 0, wh_total: 0 })
    expect(rollDailyEnergy(prev, { total_wh: 0, at: at('06:01:00') }, DAY))
      .toMatchObject({ wh_last: 0, wh_total: 0, resets: 0, samples: 2 })
  })
  it('resets accumulate across the day rather than overwriting', () => {
    const prev = today({ wh_start: 50000, wh_last: 50000, wh_total: 40, resets: 2, samples: 10 })
    expect(rollDailyEnergy(prev, { total_wh: 5, at: at('10:00:00') }, DAY)).toMatchObject({ resets: 3 })
  })
  it('a reset across midnight is counted on the new day', () => {
    const prev = { day: '2026-07-05', wh_start: 40000, wh_last: 50000, wh_total: 100, samples: 1440, resets: 0, first_sample_at: 'x', last_sample_at: 'y' }
    // wh_start is the last reading before the day opened, so it can exceed
    // wh_last after a reset — exactly why wh_total is never wh_last - wh_start.
    expect(rollDailyEnergy(prev, { total_wh: 12, at: at('00:00:30') }, DAY))
      .toMatchObject({ day: DAY, wh_start: 50000, wh_last: 12, wh_total: 12, resets: 1, samples: 1 })
  })
})

describe('rollDailyEnergy — the row invariant, swept', () => {
  // The cron upserts a whole location in ONE bulk call, so a single NaN,
  // null, string or stale day does not spoil one device's day — it fails the
  // write for every device at that location. Whatever shape goes in, a
  // returned row is always upsertable.
  it('every row it returns is upsertable, whatever shape the row and sample had', () => {
    const prevRows = [
      null, undefined, 'nonsense', 42, [], {},
      today(),
      today({ day: '2026-07-05' }),
      today({ day: '2026-07-06T00:00:00+00:00' }),
      today({ day: new Date('2026-07-06T00:00:00Z') }),
      today({ day: null }),
      today({ wh_start: '1000.000', wh_last: '1000.000', wh_total: '0.000', samples: '1', resets: '0' }),
      today({ wh_start: 'x', wh_last: 'x', wh_total: 'x', samples: 'x', resets: 'x' }),
      today({ wh_start: -1, wh_last: -1, wh_total: -1, samples: -1, resets: -1 }),
      today({ wh_last: NaN, wh_total: NaN, samples: NaN, resets: NaN }),
      today({ samples: '1.5', resets: '0.5' }),
      today({ wh_last: 50000, wh_total: 40 }),
      today({ first_sample_at: null, last_sample_at: undefined }),
    ]
    const totals = [0, 1, 12, 999.9995, 1000, 1007.5, '1007.500', 50000, 1e9]
    let produced = 0
    for (const prev of prevRows) {
      for (const total_wh of totals) {
        const row = rollDailyEnergy(prev, { total_wh, at: at('06:01:00') }, DAY)
        expect(row, JSON.stringify({ prev, total_wh })).not.toBe(null)
        produced++
        expect(row.day).toBe(DAY)
        for (const k of NUMERIC_COLS) {
          expect(typeof row[k], k).toBe('number')
          expect(Number.isFinite(row[k]), k).toBe(true)
          expect(row[k] >= 0, k).toBe(true)
          // numeric(14,3): never more than three decimals.
          expect(String(row[k]).split('.')[1]?.length ?? 0, k).toBeLessThanOrEqual(3)
        }
        expect(row.samples).toBeGreaterThanOrEqual(1)
        // Counts, not measurements: whole numbers, and inside the ceiling.
        for (const k of ['samples', 'resets']) expect(Number.isInteger(row[k]), k).toBe(true)
        for (const k of ['wh_start', 'wh_last', 'wh_total']) expect(row[k], k).toBeLessThan(1e11)
        for (const k of ['first_sample_at', 'last_sample_at']) {
          expect(typeof row[k], k).toBe('string')
          expect(row[k].trim(), k).not.toBe('')
        }
      }
    }
    expect(produced).toBe(prevRows.length * totals.length)
  })
})

describe('rollDailyEnergy — numeric(14,3) precision', () => {
  it('does not accumulate float drift into wh_total', () => {
    const prev = today({ wh_start: 1000, wh_last: 1000.1, wh_total: 0.1 })
    const row = rollDailyEnergy(prev, { total_wh: 1000.3, at: at('06:02:00') }, DAY)
    // 0.1 + (1000.3 - 1000.1) is 0.30000000000000004 in binary floating point.
    expect(row.wh_total).toBe(0.3)
    expect(row.wh_last).toBe(1000.3)
  })
  it('rounds to three decimals, the column\'s scale', () => {
    const prev = today({ wh_start: 0, wh_last: 0, wh_total: 0 })
    const row = rollDailyEnergy(prev, { total_wh: 1.00049, at: at('06:01:00') }, DAY)
    expect(row.wh_total).toBe(1)
    expect(row.wh_last).toBe(1)
  })
  it('a long run of thirds never grows a fourth decimal', () => {
    let row = rollDailyEnergy(null, { total_wh: 0, at: at('06:00:00') }, DAY)
    for (let i = 1; i <= 100; i++) row = rollDailyEnergy(row, { total_wh: i / 3, at: at('06:00:00') }, DAY)
    for (const k of ['wh_total', 'wh_last']) {
      expect(String(row[k]).split('.')[1]?.length ?? 0, k).toBeLessThanOrEqual(3)
    }
    expect(row.wh_total).toBeCloseTo(100 / 3, 2)
  })
})
