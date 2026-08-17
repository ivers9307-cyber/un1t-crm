import { describe, it, expect } from 'vitest'
import { METRICS, inbodyBookend } from './inbody.js'

// A scan anchored to a UTC instant, with the three tracked metrics + score.
const scan = (iso, over = {}) => ({
  scanned_at: iso,
  weight_kg: 80,
  smm_kg: 34,
  pbf_percent: 20,
  inbody_score: 70,
  ...over,
})

const ms = (iso) => Date.parse(iso)

describe('METRICS', () => {
  it('is the single source of the three tracked metrics with directions', () => {
    expect(METRICS.map((m) => m.key)).toEqual(['weight_kg', 'smm_kg', 'pbf_percent'])
    const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m]))
    expect(byKey.weight_kg.betterWhenLower).toBe(true)
    expect(byKey.smm_kg.betterWhenLower).toBe(false)
    expect(byKey.pbf_percent.betterWhenLower).toBe(true)
    // Each carries the fields the UI needs.
    for (const m of METRICS) {
      expect(m).toMatchObject({
        key: expect.any(String),
        label: expect.any(String),
        short: expect.any(String),
        unit: expect.any(String),
        dp: expect.any(Number),
      })
    }
  })
})

describe('inbodyBookend — baseline selection', () => {
  const window = { fromMs: ms('2026-06-01T00:00:00Z'), toMs: ms('2026-06-30T23:59:59Z') }

  it('picks the latest scan on/before the window start as the baseline', () => {
    const scans = [
      scan('2026-05-01T12:00:00Z', { weight_kg: 90 }), // older pre-window
      scan('2026-05-20T12:00:00Z', { weight_kg: 85 }), // latest pre-window → baseline
      scan('2026-06-25T12:00:00Z', { weight_kg: 80 }), // latest in-window → latest
    ]
    const b = inbodyBookend(scans, window)
    expect(b).not.toBeNull()
    expect(b.baseline.scanned_at).toBe('2026-05-20T12:00:00Z')
    expect(b.latest.scanned_at).toBe('2026-06-25T12:00:00Z')
  })

  it('falls back to the earliest in-window scan when no scan precedes the window', () => {
    const scans = [
      scan('2026-06-03T12:00:00Z', { weight_kg: 88 }), // earliest in-window → baseline
      scan('2026-06-10T12:00:00Z', { weight_kg: 86 }),
      scan('2026-06-28T12:00:00Z', { weight_kg: 82 }), // latest in-window → latest
    ]
    const b = inbodyBookend(scans, window)
    expect(b.baseline.scanned_at).toBe('2026-06-03T12:00:00Z')
    expect(b.latest.scanned_at).toBe('2026-06-28T12:00:00Z')
  })

  it('treats a scan exactly on fromMs as a valid pre-window baseline', () => {
    const scans = [
      scan('2026-06-01T00:00:00Z', { weight_kg: 84 }), // exactly on fromMs
      scan('2026-06-20T12:00:00Z', { weight_kg: 81 }),
    ]
    const b = inbodyBookend(scans, window)
    expect(b.baseline.scanned_at).toBe('2026-06-01T00:00:00Z')
    expect(b.latest.scanned_at).toBe('2026-06-20T12:00:00Z')
  })

  it('ignores scans after toMs when choosing the latest', () => {
    const scans = [
      scan('2026-05-25T12:00:00Z', { weight_kg: 85 }), // baseline (pre-window)
      scan('2026-06-15T12:00:00Z', { weight_kg: 80 }), // latest on/before toMs
      scan('2026-07-05T12:00:00Z', { weight_kg: 78 }), // after toMs — ignored
    ]
    const b = inbodyBookend(scans, window)
    expect(b.latest.scanned_at).toBe('2026-06-15T12:00:00Z')
  })
})

describe('inbodyBookend — deltas and improvement direction', () => {
  const window = { fromMs: ms('2026-06-01T00:00:00Z'), toMs: ms('2026-06-30T23:59:59Z') }

  it('computes per-metric from/to/delta and flags improvement per betterWhenLower', () => {
    const scans = [
      scan('2026-05-30T12:00:00Z', { weight_kg: 85, smm_kg: 33, pbf_percent: 24, inbody_score: 68 }),
      scan('2026-06-28T12:00:00Z', { weight_kg: 82, smm_kg: 35, pbf_percent: 20, inbody_score: 74 }),
    ]
    const b = inbodyBookend(scans, window)
    const byKey = Object.fromEntries(b.metrics.map((m) => [m.key, m]))

    // Weight ↓ 3kg = improved (betterWhenLower).
    expect(byKey.weight_kg.from).toBe(85)
    expect(byKey.weight_kg.to).toBe(82)
    expect(byKey.weight_kg.delta).toBe(-3)
    expect(byKey.weight_kg.improved).toBe(true)

    // Muscle ↑ 2kg = improved (better when higher).
    expect(byKey.smm_kg.delta).toBe(2)
    expect(byKey.smm_kg.improved).toBe(true)

    // Body fat ↓ 4% = improved.
    expect(byKey.pbf_percent.delta).toBe(-4)
    expect(byKey.pbf_percent.improved).toBe(true)

    // Score ↑ 6 = improved.
    expect(b.score).toEqual({ from: 68, to: 74, delta: 6, improved: true })
  })

  it('flags regressions as NOT improved', () => {
    const scans = [
      scan('2026-05-30T12:00:00Z', { weight_kg: 80, smm_kg: 36, pbf_percent: 18, inbody_score: 75 }),
      scan('2026-06-28T12:00:00Z', { weight_kg: 84, smm_kg: 34, pbf_percent: 22, inbody_score: 70 }),
    ]
    const b = inbodyBookend(scans, window)
    const byKey = Object.fromEntries(b.metrics.map((m) => [m.key, m]))
    expect(byKey.weight_kg.improved).toBe(false)   // gained weight
    expect(byKey.smm_kg.improved).toBe(false)      // lost muscle
    expect(byKey.pbf_percent.improved).toBe(false) // gained fat
    expect(b.score.improved).toBe(false)           // score dropped
  })

  it('leaves delta/improved null when a metric field is absent on either bookend', () => {
    const scans = [
      scan('2026-05-30T12:00:00Z', { smm_kg: null }),
      scan('2026-06-28T12:00:00Z', { smm_kg: 35 }),
    ]
    const b = inbodyBookend(scans, window)
    const byKey = Object.fromEntries(b.metrics.map((m) => [m.key, m]))
    expect(byKey.smm_kg.from).toBeNull()
    expect(byKey.smm_kg.delta).toBeNull()
    expect(byKey.smm_kg.improved).toBeNull()
    // Other metrics still resolve normally.
    expect(byKey.weight_kg.delta).toBe(0)
  })

  it('tolerates a missing inbody_score (score delta null)', () => {
    const scans = [
      scan('2026-05-30T12:00:00Z', { inbody_score: undefined }),
      scan('2026-06-28T12:00:00Z', { inbody_score: 74 }),
    ]
    const b = inbodyBookend(scans, window)
    expect(b.score).toEqual({ from: null, to: 74, delta: null, improved: null })
  })
})

describe('inbodyBookend — null cases', () => {
  const window = { fromMs: ms('2026-06-01T00:00:00Z'), toMs: ms('2026-06-30T23:59:59Z') }

  it('returns null with fewer than 2 usable scans', () => {
    expect(inbodyBookend([scan('2026-06-10T12:00:00Z')], window)).toBeNull()
    expect(inbodyBookend([], window)).toBeNull()
    expect(inbodyBookend(null, window)).toBeNull()
    expect(inbodyBookend(undefined, window)).toBeNull()
  })

  it('ignores scans with an unparseable/absent scanned_at', () => {
    const scans = [
      scan(null),
      scan('not-a-date'),
      scan('2026-06-20T12:00:00Z'),
    ]
    // Only one usable scan → null.
    expect(inbodyBookend(scans, window)).toBeNull()
  })

  it('returns null when no scan lies on/before toMs (all after the window)', () => {
    const scans = [
      scan('2026-07-10T12:00:00Z'),
      scan('2026-07-20T12:00:00Z'),
    ]
    expect(inbodyBookend(scans, window)).toBeNull()
  })

  it('returns null when only one distinct bookend scan spans the window', () => {
    // Two scans but both are before the window start → baseline is the later
    // pre-window scan and there is no in-window/end scan to pair with.
    const scans = [
      scan('2026-05-10T12:00:00Z'),
      scan('2026-05-20T12:00:00Z'),
    ]
    // latest on/before toMs is the 05-20 scan, baseline on/before fromMs is
    // also 05-20 → same scan, not spanning → null.
    expect(inbodyBookend(scans, window)).toBeNull()
  })

  it('returns null for an invalid window', () => {
    const scans = [scan('2026-06-05T12:00:00Z'), scan('2026-06-25T12:00:00Z')]
    expect(inbodyBookend(scans, { fromMs: NaN, toMs: ms('2026-06-30T00:00:00Z') })).toBeNull()
    expect(inbodyBookend(scans, { fromMs: ms('2026-06-30T00:00:00Z'), toMs: ms('2026-06-01T00:00:00Z') })).toBeNull()
    expect(inbodyBookend(scans, undefined)).toBeNull()
  })
})
