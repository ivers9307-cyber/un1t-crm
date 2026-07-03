// Tests for heart-rate.js — pure helper, no mocks needed.

import { describe, it, expect } from 'vitest'
import {
  ZONE_DEFS,
  resolveMaxHr,
  resolveScoringConfig,
  SCORING_DEFAULTS,
  zoneForBpm,
  summariseSession,
  zoneBreakdown,
  BURN_THRESHOLD_SECONDS,
  burnSeconds,
  isBurn,
  effortPointsFromZones,
  emptyRunningSummary,
  normaliseRunningState,
  applyBatchToRunningSummary,
  flushRunningSummary,
  MAX_SAMPLE_GAP_SECONDS,
} from './heart-rate.js'

// ── ZONE_DEFS shape ──────────────────────────────────────────────

describe('ZONE_DEFS', () => {
  it('defines 5 zones with strictly increasing thresholds', () => {
    expect(ZONE_DEFS).toHaveLength(5)
    for (let i = 1; i < ZONE_DEFS.length; i++) {
      expect(ZONE_DEFS[i].pctMin).toBeGreaterThanOrEqual(ZONE_DEFS[i - 1].pctMin)
    }
  })
  it('has the standard Myzone thresholds (60/70/80/90)', () => {
    expect(ZONE_DEFS.map((z) => z.pctMin)).toEqual([0, 0.60, 0.70, 0.80, 0.90])
  })
  it('points scale 1..5 for Z1..Z5', () => {
    expect(ZONE_DEFS.map((z) => z.points)).toEqual([1, 2, 3, 4, 5])
  })
})

// ── resolveMaxHr ─────────────────────────────────────────────────

describe('resolveMaxHr', () => {
  const ref = new Date('2026-05-08T00:00:00Z').getTime()

  it('uses contact.max_hr_override when present and in range', () => {
    expect(resolveMaxHr({ max_hr_override: 195 }, ref)).toBe(195)
  })
  it('ignores override out of [100, 240]', () => {
    expect(resolveMaxHr({ max_hr_override: 50, dob: '1990-05-08' }, ref)).not.toBe(50)
    expect(resolveMaxHr({ max_hr_override: 300, dob: '1990-05-08' }, ref)).not.toBe(300)
  })
  it('falls back to Tanaka 208 - 0.7 * age', () => {
    // Born 1990-05-08, ref 2026-05-08 → age 36, Tanaka = 208 - 25.2 = 182.8 → 183
    expect(resolveMaxHr({ dob: '1990-05-08' }, ref)).toBe(183)
  })
  it('returns 180 default when no dob and no override', () => {
    expect(resolveMaxHr({}, ref)).toBe(180)
    expect(resolveMaxHr(null, ref)).toBe(180)
  })
  it('clamps Tanaka result into [140, 220]', () => {
    // 100-year-old: 208 - 70 = 138 → clamps to 140
    expect(resolveMaxHr({ dob: '1926-01-01' }, ref)).toBe(140)
  })
})

// ── zoneForBpm ───────────────────────────────────────────────────

describe('zoneForBpm', () => {
  // Reference: maxHr = 200 → 60% = 120, 70% = 140, 80% = 160, 90% = 180.
  it('returns Z1 (grey) below 60% of max', () => {
    expect(zoneForBpm(100, 200).id).toBe(1)
    expect(zoneForBpm(119, 200).id).toBe(1)
  })
  it('returns Z2 (blue) at 60-69%', () => {
    expect(zoneForBpm(120, 200).id).toBe(2)
    expect(zoneForBpm(139, 200).id).toBe(2)
  })
  it('returns Z3 (green) at 70-79%', () => {
    expect(zoneForBpm(140, 200).id).toBe(3)
    expect(zoneForBpm(159, 200).id).toBe(3)
  })
  it('returns Z4 (yellow) at 80-89%', () => {
    expect(zoneForBpm(160, 200).id).toBe(4)
    expect(zoneForBpm(179, 200).id).toBe(4)
  })
  it('returns Z5 (red) at 90%+', () => {
    expect(zoneForBpm(180, 200).id).toBe(5)
    expect(zoneForBpm(220, 200).id).toBe(5) // above max, still Z5
  })
  it('returns Z1 for non-finite or invalid input', () => {
    expect(zoneForBpm(NaN, 200).id).toBe(1)
    expect(zoneForBpm(150, 0).id).toBe(1)
  })
})

// ── summariseSession ─────────────────────────────────────────────

describe('summariseSession', () => {
  const max = 200

  it('returns empty zone tally for empty samples', () => {
    const out = summariseSession([], max)
    expect(out.zonesSeconds).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
    expect(out.effortPoints).toBe(0)
    expect(out.avgHrBpm).toBe(null)
    expect(out.peakHrBpm).toBe(null)
  })

  it('handles non-array gracefully', () => {
    const out = summariseSession(null, max)
    expect(out.totalSeconds).toBe(0)
  })

  it('counts seconds in each zone using gap-to-next-sample', () => {
    // 1Hz samples for 60 seconds at 145 bpm → all in Z3
    const samples = []
    const start = new Date('2026-05-08T10:00:00Z').getTime()
    for (let i = 0; i < 60; i++) {
      samples.push({ recorded_at: new Date(start + i * 1000).toISOString(), bpm: 145 })
    }
    const out = summariseSession(samples, max)
    // Last sample contributes 1s by default; 59 gaps + 1 = 60s
    expect(out.zonesSeconds[3]).toBeGreaterThanOrEqual(59)
    expect(out.zonesSeconds[3]).toBeLessThanOrEqual(60)
    // 60s in Z3 = 60 * 3/60 = 3 points
    expect(out.effortPoints).toBe(3)
  })

  it('peak + avg correct across mixed bpms', () => {
    const samples = [
      { recorded_at: '2026-05-08T10:00:00Z', bpm: 100 },
      { recorded_at: '2026-05-08T10:00:01Z', bpm: 200 },
      { recorded_at: '2026-05-08T10:00:02Z', bpm: 150 },
    ]
    const out = summariseSession(samples, max)
    expect(out.peakHrBpm).toBe(200)
    expect(out.avgHrBpm).toBe(150) // (100 + 200 + 150) / 3
  })

  it('caps a long gap to 5s (dropout protection)', () => {
    // Two samples 60s apart shouldn't count as 60s in the first sample's zone.
    const samples = [
      { recorded_at: '2026-05-08T10:00:00Z', bpm: 145 }, // Z3
      { recorded_at: '2026-05-08T10:01:00Z', bpm: 145 }, // Z3, 60s later
    ]
    const out = summariseSession(samples, max)
    // First sample contributes 5s (capped), second contributes 1s default = 6s.
    expect(out.zonesSeconds[3]).toBeLessThanOrEqual(6)
  })

  it('drops samples with non-finite bpm or recorded_at', () => {
    const samples = [
      { recorded_at: 'not a date', bpm: 145 },
      { recorded_at: '2026-05-08T10:00:00Z', bpm: NaN },
      { recorded_at: '2026-05-08T10:00:01Z', bpm: 150 },
    ]
    const out = summariseSession(samples, max)
    expect(out.totalSeconds).toBeGreaterThan(0)
    expect(out.peakHrBpm).toBe(150)
  })

  it('points calculation: 30 min in Z2 + 30 min in Z4 = 90 points', () => {
    // 1Hz samples, 1800 in Z2 (130 bpm = 65%) then 1800 in Z4 (170 bpm = 85%)
    const samples = []
    const start = new Date('2026-05-08T10:00:00Z').getTime()
    for (let i = 0; i < 1800; i++) {
      samples.push({ recorded_at: new Date(start + i * 1000).toISOString(), bpm: 130 })
    }
    for (let i = 0; i < 1800; i++) {
      samples.push({ recorded_at: new Date(start + (1800 + i) * 1000).toISOString(), bpm: 170 })
    }
    const out = summariseSession(samples, max)
    // 30 min Z2 = 60 points, 30 min Z4 = 120 points → total 180.
    // (one boundary sample is allocated as a 1-second tail to the
    // last bpm, so 90 = roughly half — actually we expect ≈ 180.)
    expect(out.effortPoints).toBeGreaterThanOrEqual(178)
    expect(out.effortPoints).toBeLessThanOrEqual(180)
  })
})

// ── zoneBreakdown ────────────────────────────────────────────────

describe('zoneBreakdown', () => {
  it('returns 5 zones with seconds + percent when given populated tally', () => {
    const out = zoneBreakdown({ 1: 0, 2: 600, 3: 1200, 4: 600, 5: 0 })
    expect(out).toHaveLength(5)
    expect(out.find((z) => z.id === 3).seconds).toBe(1200)
    expect(out.find((z) => z.id === 3).percent).toBeCloseTo(0.5, 5)
  })

  it('handles string keys (postgres jsonb round-trip)', () => {
    const out = zoneBreakdown({ '3': 600 })
    expect(out.find((z) => z.id === 3).seconds).toBe(600)
  })

  it('returns all zeros when given null/undefined/non-object', () => {
    expect(zoneBreakdown(null).every((z) => z.seconds === 0)).toBe(true)
    expect(zoneBreakdown(undefined).every((z) => z.seconds === 0)).toBe(true)
    expect(zoneBreakdown('string').every((z) => z.seconds === 0)).toBe(true)
  })

  it('percent sums to ~1 when there are seconds', () => {
    const out = zoneBreakdown({ 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 })
    const total = out.reduce((a, b) => a + b.percent, 0)
    expect(total).toBeCloseTo(1, 5)
  })
})

// ── resolveScoringConfig ─────────────────────────────────────────

describe('resolveScoringConfig', () => {
  it('returns defaults when settings absent', () => {
    const c = resolveScoringConfig({})
    expect(c.participationPoints).toBe(50)
    expect(c.zonePoints).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 })
    // Defaults track the exported SCORING_DEFAULTS contract.
    expect(c.participationPoints).toBe(SCORING_DEFAULTS.participation_points)
    expect(c.zonePoints).toEqual(SCORING_DEFAULTS.zone_points)
  })
  it('overrides from locations.settings.scoring, partial-merges', () => {
    const c = resolveScoringConfig({ settings: { scoring: { participation_points: 25, zone_points: { 5: 8 } } } })
    expect(c.participationPoints).toBe(25)
    expect(c.zonePoints[5]).toBe(8)
    expect(c.zonePoints[1]).toBe(1)
  })
  it('ignores non-numeric garbage and falls back to defaults', () => {
    const c = resolveScoringConfig({ settings: { scoring: { participation_points: 'x', zone_points: { 3: 'y' } } } })
    expect(c.participationPoints).toBe(50)
    expect(c.zonePoints[3]).toBe(3)
  })
})

describe('summariseSession with configurable zonePoints', () => {
  const minuteInZ5 = Array.from({ length: 61 }, (_, i) => ({ recorded_at: new Date(Date.parse('2026-06-21T10:00:00Z') + i * 1000).toISOString(), bpm: 190 }))
  it('uses default zone points when no opts (byte-identical behaviour)', () => {
    const a = summariseSession(minuteInZ5, 200)
    const b = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:5 } })
    expect(a.effortPoints).toBe(b.effortPoints)
  })
  it('honours custom zone points (double Z5 → more points)', () => {
    const base = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:5 } })
    const dbl = summariseSession(minuteInZ5, 200, { zonePoints: { 1:1,2:2,3:3,4:4,5:10 } })
    expect(dbl.effortPoints).toBeGreaterThan(base.effortPoints)
  })
})

// ── The Burn (burnSeconds / isBurn) ──────────────────────────────

describe('burnSeconds', () => {
  it('sums Zone 4 + Zone 5 seconds', () => {
    expect(burnSeconds({ 4: 300, 5: 120 })).toBe(420)
  })
  it('ignores Zones 1-3', () => {
    expect(burnSeconds({ 1: 1000, 2: 1000, 3: 1000, 4: 60 })).toBe(60)
  })
  it('handles zone5-only', () => {
    expect(burnSeconds({ 5: 800 })).toBe(800)
  })
  it('handles postgres jsonb string keys', () => {
    expect(burnSeconds({ '4': 300, '5': 120 })).toBe(420)
  })
  it('returns 0 for missing/partial/invalid input (no throw)', () => {
    expect(burnSeconds(null)).toBe(0)
    expect(burnSeconds(undefined)).toBe(0)
    expect(burnSeconds({})).toBe(0)
    expect(burnSeconds('nope')).toBe(0)
    expect(burnSeconds({ 4: 'x', 5: NaN })).toBe(0)
    expect(burnSeconds({ 1: 500 })).toBe(0) // no Z4/Z5 keys at all
  })
})

describe('isBurn', () => {
  it('exposes the 12-minute (720s) threshold', () => {
    expect(BURN_THRESHOLD_SECONDS).toBe(720)
  })
  it('earns a Burn at exactly 720s combined (boundary)', () => {
    expect(isBurn({ 4: 720 })).toBe(true)
    expect(isBurn({ 4: 600, 5: 120 })).toBe(true) // Z4+Z5 combo = 720
  })
  it('no Burn just under threshold (719s)', () => {
    expect(isBurn({ 4: 600, 5: 119 })).toBe(false)
    expect(isBurn({ 4: 719 })).toBe(false)
  })
  it('earns a Burn on zone5 alone when ≥ threshold', () => {
    expect(isBurn({ 5: 720 })).toBe(true)
    expect(isBurn({ 5: 900 })).toBe(true)
  })
  it('does not earn a Burn from Zones 1-3 no matter how long', () => {
    expect(isBurn({ 1: 5000, 2: 5000, 3: 5000 })).toBe(false)
  })
  it('safe on missing/partial zones (no Burn, no throw)', () => {
    expect(isBurn(null)).toBe(false)
    expect(isBurn(undefined)).toBe(false)
    expect(isBurn({})).toBe(false)
    expect(isBurn({ 4: 300 })).toBe(false) // 5 min only
  })
})

// ── incremental running summary ↔ summariseSession equivalence ────
//
// THE GATE (audit W2/#11). The live TV board reads the running aggregate we
// maintain on heart_rate_sessions at ingest instead of re-scanning every
// hr_sample every 2s poll. For that to be correct the incremental fold
// (applyBatchToRunningSummary) — for ANY split of the stream into batches —
// must, after flushRunningSummary attributes the pending last sample, produce
// the IDENTICAL zones_seconds / effort_points / peak / avg as the one-shot
// summariseSession(fullStream). These tests prove that across steady streams,
// >5s gaps, dropouts, single/empty streams, varied zones, and every batch
// split, and separately assert the bounded ≤5s live pending-tail.

describe('effortPointsFromZones', () => {
  it('matches the inline points math summariseSession used to do', () => {
    // 60s Z3 = 3 points, 120s Z5 = 10 points → 13 total.
    expect(effortPointsFromZones({ 3: 60, 5: 120 })).toBe(13)
  })
  it('floors at the end (partial sub-minute rounds down)', () => {
    // 59s Z3 = 59*3/60 = 2.95 → floor 2.
    expect(effortPointsFromZones({ 3: 59 })).toBe(2)
  })
  it('tolerates jsonb string keys and honours a zonePoints override', () => {
    expect(effortPointsFromZones({ '3': 60 }, { 3: 10 })).toBe(10)
  })
  it('is 0 for empty/missing/null', () => {
    expect(effortPointsFromZones({})).toBe(0)
    expect(effortPointsFromZones(null)).toBe(0)
  })
})

describe('applyBatchToRunningSummary ↔ summariseSession equivalence', () => {
  const max = 200

  // Build a sample stream from [bpm, gapMsToNext] pairs anchored at t0.
  const t0 = Date.UTC(2026, 6, 3, 9, 0, 0)
  const streamFrom = (pairs, base = t0) => {
    const out = []
    let t = base
    for (const [bpm, gapMs] of pairs) {
      out.push({ recorded_at: new Date(t).toISOString(), bpm })
      t += gapMs
    }
    return out
  }

  // Every way to split an array of length n into contiguous batches (including
  // empty batches interleaved, to exercise the "empty batch is a no-op" path).
  const contiguousSplits = (arr) => {
    const splits = []
    const n = arr.length
    // Split at every subset of the n-1 internal boundaries.
    for (let mask = 0; mask < (1 << Math.max(0, n - 1)); mask++) {
      const batches = []
      let start = 0
      for (let i = 0; i < n - 1; i++) {
        if (mask & (1 << i)) { batches.push(arr.slice(start, i + 1)); start = i + 1 }
      }
      batches.push(arr.slice(start))
      splits.push(batches)
    }
    return splits
  }

  // Fold a list of batches, then flush → the finalised summary.
  const foldAndFlush = (batches, maxHr, opts = {}) => {
    let state = emptyRunningSummary()
    for (const b of batches) state = applyBatchToRunningSummary(state, b, maxHr, opts)
    return flushRunningSummary(state, { ...opts, maxHr })
  }

  const assertEquivalent = (stream, maxHr = max, opts = {}) => {
    const oneShot = summariseSession(stream, maxHr, opts)
    for (const batches of contiguousSplits(stream)) {
      const inc = foldAndFlush(batches, maxHr, opts)
      expect(inc.zonesSeconds).toEqual(oneShot.zonesSeconds)
      expect(inc.effortPoints).toBe(oneShot.effortPoints)
      expect(inc.peakHrBpm).toBe(oneShot.peakHrBpm)
      expect(inc.avgHrBpm).toBe(oneShot.avgHrBpm)
      expect(inc.totalSeconds).toBe(oneShot.totalSeconds)
    }
  }

  it('steady 1Hz stream, all zones, EVERY batch split', () => {
    // 10 samples at 1s spacing, climbing through the zones.
    const stream = streamFrom([
      [100, 1000], [125, 1000], [145, 1000], [165, 1000], [185, 1000],
      [170, 1000], [150, 1000], [130, 1000], [110, 1000], [190, 1000],
    ])
    assertEquivalent(stream)
  })

  it('irregular spacing (2s / 3s / 4s gaps, all ≤ cap)', () => {
    const stream = streamFrom([[120, 2000], [140, 3000], [160, 4000], [180, 2000], [100, 1000]])
    assertEquivalent(stream)
  })

  it('>5s gaps (dropouts) are capped at 5s per sample, EVERY split', () => {
    const stream = streamFrom([[130, 30000], [150, 12000], [170, 6000], [190, 1000]])
    assertEquivalent(stream)
  })

  it('a mix of tiny and huge gaps', () => {
    const stream = streamFrom([[100, 500], [200, 60000], [140, 5000], [160, 5001], [120, 100]])
    assertEquivalent(stream)
  })

  it('single-sample stream (last-sample flat-1s rule)', () => {
    assertEquivalent(streamFrom([[155, 0]]))
  })

  it('two-sample stream', () => {
    assertEquivalent(streamFrom([[130, 3000], [175, 0]]))
  })

  it('empty stream', () => {
    const oneShot = summariseSession([], max)
    const inc = foldAndFlush([[]], max)
    expect(inc.zonesSeconds).toEqual(oneShot.zonesSeconds)
    expect(inc.effortPoints).toBe(0)
    expect(inc.peakHrBpm).toBe(null)
    expect(inc.avgHrBpm).toBe(null)
    expect(inc.totalSeconds).toBe(0)
  })

  it('honours an operator zonePoints override identically', () => {
    const stream = streamFrom([[120, 1000], [145, 1000], [185, 1000], [165, 1000]])
    assertEquivalent(stream, max, { zonePoints: { 1: 1, 2: 2, 3: 3, 4: 8, 5: 12 } })
  })

  it('equivalence holds under a different maxHr (zone boundaries shift)', () => {
    const stream = streamFrom([[100, 1000], [130, 2000], [150, 1000], [175, 1000]])
    assertEquivalent(stream, 170)
  })

  it('longer stream (40 samples) across many random-ish splits', () => {
    const pairs = []
    for (let i = 0; i < 40; i++) {
      const bpm = 90 + ((i * 37) % 110)          // 90..199, deterministic wander
      const gap = 1000 + ((i * 1300) % 9000)     // 1s..~10s, crosses the 5s cap
      pairs.push([bpm, gap])
    }
    const stream = streamFrom(pairs)
    // 2^39 splits is intractable; sample a spread of representative splits.
    const oneShot = summariseSession(stream, max)
    const splitPoints = [[10], [20], [1, 39], [13, 26], [5, 10, 15, 20, 25, 30, 35], []]
    for (const cuts of splitPoints) {
      const batches = []
      let start = 0
      for (const c of cuts) { batches.push(stream.slice(start, c)); start = c }
      batches.push(stream.slice(start))
      const inc = foldAndFlush(batches, max)
      expect(inc.zonesSeconds).toEqual(oneShot.zonesSeconds)
      expect(inc.effortPoints).toBe(oneShot.effortPoints)
      expect(inc.peakHrBpm).toBe(oneShot.peakHrBpm)
      expect(inc.avgHrBpm).toBe(oneShot.avgHrBpm)
    }
    // Per-sample batches (worst case: one sample per batch) must also match.
    const perSample = stream.map((s) => [s])
    const inc1 = foldAndFlush(perSample, max)
    expect(inc1.zonesSeconds).toEqual(oneShot.zonesSeconds)
    expect(inc1.effortPoints).toBe(oneShot.effortPoints)
  })

  it('drops non-finite bpm / bad recorded_at the same way summariseSession does', () => {
    const stream = [
      { recorded_at: new Date(t0).toISOString(), bpm: 120 },
      { recorded_at: new Date(t0 + 1000).toISOString(), bpm: NaN },      // dropped
      { recorded_at: 'not-a-date', bpm: 150 },                            // dropped
      { recorded_at: new Date(t0 + 2000).toISOString(), bpm: 175 },
    ]
    assertEquivalent(stream)
  })
})

describe('applyBatchToRunningSummary — live pending-tail bound', () => {
  const max = 200
  const t0 = Date.UTC(2026, 6, 3, 9, 0, 0)
  const s = (offsetMs, bpm) => ({ recorded_at: new Date(t0 + offsetMs).toISOString(), bpm })

  it('the LIVE (un-flushed) value under-counts total time by at most 5s vs the one-shot', () => {
    // Fold the whole stream as one batch but DO NOT flush: this is exactly what
    // the live board reads. It must be behind summariseSession by no more than
    // the pending sample's not-yet-known gap (≤ MAX_SAMPLE_GAP_SECONDS).
    const stream = [s(0, 120), s(1000, 145), s(2000, 175), s(4000, 190)]
    const live = applyBatchToRunningSummary(emptyRunningSummary(), stream, max)
    const liveTotal = Object.values(live.zonesSeconds).reduce((a, b) => a + b, 0)
    const oneShotTotal = summariseSession(stream, max).totalSeconds
    const deficit = oneShotTotal - liveTotal
    expect(deficit).toBeGreaterThanOrEqual(0)
    expect(deficit).toBeLessThanOrEqual(MAX_SAMPLE_GAP_SECONDS)
    // And flushing closes it exactly.
    const flushed = flushRunningSummary(live, { maxHr: max })
    expect(flushed.totalSeconds).toBe(oneShotTotal)
  })

  it('effort_points live value is never AHEAD of the finalised value', () => {
    const stream = [s(0, 185), s(1000, 190), s(2000, 195), s(3000, 188)]
    const live = applyBatchToRunningSummary(emptyRunningSummary(), stream, max)
    const finalPts = summariseSession(stream, max).effortPoints
    expect(live.effortPoints).toBeLessThanOrEqual(finalPts)
  })
})

describe('applyBatchToRunningSummary — state round-trip / normalisation', () => {
  const max = 200
  const t0 = Date.UTC(2026, 6, 3, 9, 0, 0)

  it('normaliseRunningState reads jsonb string keys + DB column aliases', () => {
    const persisted = {
      zones_seconds: { '1': 10, '3': 20 },
      live_sum_bpm: 300,
      live_sample_count: 2,
      peak_hr_bpm: 175,
      live_last_bpm: 150,
      live_last_at: new Date(t0).toISOString(),
    }
    const st = normaliseRunningState(persisted)
    expect(st.zonesSeconds).toEqual({ 1: 10, 2: 0, 3: 20, 4: 0, 5: 0 })
    expect(st.sumBpm).toBe(300)
    expect(st.sampleCount).toBe(2)
    expect(st.peakBpm).toBe(175)
    expect(st.lastBpm).toBe(150)
    expect(st.lastAtMs).toBe(t0)
  })

  it('a persisted-then-reloaded state continues the fold identically to a single in-memory fold', () => {
    // Simulate: batch A folded, state persisted to DB columns + reloaded, batch B folded.
    const A = [
      { recorded_at: new Date(t0).toISOString(), bpm: 120 },
      { recorded_at: new Date(t0 + 1000).toISOString(), bpm: 145 },
    ]
    const B = [
      { recorded_at: new Date(t0 + 2000).toISOString(), bpm: 175 },
      { recorded_at: new Date(t0 + 3000).toISOString(), bpm: 190 },
    ]
    // In-memory continuous fold.
    let mem = applyBatchToRunningSummary(emptyRunningSummary(), A, max)
    mem = applyBatchToRunningSummary(mem, B, max)

    // DB round-trip: serialise state A to the column shape, reload, fold B.
    const st1 = applyBatchToRunningSummary(emptyRunningSummary(), A, max)
    const columns = {
      zones_seconds: st1.zonesSeconds,
      live_sum_bpm: st1.sumBpm,
      live_sample_count: st1.sampleCount,
      peak_hr_bpm: st1.peakBpm,
      live_last_bpm: st1.lastBpm,
      live_last_at: new Date(st1.lastAtMs).toISOString(),
    }
    const reloaded = applyBatchToRunningSummary(columns, B, max)

    expect(reloaded.zonesSeconds).toEqual(mem.zonesSeconds)
    expect(reloaded.sumBpm).toBe(mem.sumBpm)
    expect(reloaded.sampleCount).toBe(mem.sampleCount)
    expect(reloaded.peakBpm).toBe(mem.peakBpm)
    expect(flushRunningSummary(reloaded, { maxHr: max })).toEqual(flushRunningSummary(mem, { maxHr: max }))
  })
})
