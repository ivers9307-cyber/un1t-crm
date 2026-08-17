// Tests for live-view.js — pure model, no mocks needed.

import { describe, it, expect } from 'vitest'
import {
  liveViewModel,
  burnMinutes,
  minutesToBurn,
  formatElapsed,
  STALE_AFTER_MS,
  BURN_COLOR,
} from './live-view.js'
import { BURN_THRESHOLD_SECONDS, ZONE_DEFS } from './heart-rate.js'

// A fixed "now" so elapsed/stale are deterministic.
const NOW = Date.parse('2026-07-03T10:30:00Z')

function openSession(over = {}) {
  return {
    id: 's1',
    started_at: '2026-07-03T10:00:00Z', // 30 min ago
    ended_at: null,
    last_sample_at: '2026-07-03T10:29:58Z', // 2s ago — fresh
    live_last_at: '2026-07-03T10:29:58Z',
    live_last_bpm: 150,
    max_hr_used: 180,
    zones_seconds: { 1: 100, 2: 200, 3: 300, 4: 400, 5: 50 },
    effort_points: 42,
    peak_hr_bpm: 176,
    avg_hr_bpm: 138,
    class_name: 'ENT1TY',
    ...over,
  }
}

describe('liveViewModel — zone from live bpm', () => {
  it('resolves the current zone from live_last_bpm at max_hr_used', () => {
    // 150 / 180 = 0.833 → Zone 4 (80-90%)
    const m = liveViewModel(openSession(), NOW)
    expect(m.currentBpm).toBe(150)
    expect(m.zone.id).toBe(4)
    expect(m.zone.label).toBe('Zone 4')
    expect(m.maxHr).toBe(180)
  })

  it('90% of max lands in Zone 5 (right-open intervals)', () => {
    const m = liveViewModel(openSession({ live_last_bpm: 162 }), NOW) // 162/180 = 0.90
    expect(m.zone.id).toBe(5)
  })

  it('is null-safe on a missing bpm — no zone, no throw', () => {
    const m = liveViewModel(openSession({ live_last_bpm: null }), NOW)
    expect(m.currentBpm).toBeNull()
    expect(m.zone).toBeNull()
  })

  it('has no zone when max_hr_used is missing', () => {
    const m = liveViewModel(openSession({ max_hr_used: null }), NOW)
    expect(m.currentBpm).toBe(150)
    expect(m.zone).toBeNull()
    expect(m.maxHr).toBeNull()
  })

  it('drops a zero / negative bpm to null', () => {
    expect(liveViewModel(openSession({ live_last_bpm: 0 }), NOW).currentBpm).toBeNull()
    expect(liveViewModel(openSession({ live_last_bpm: -5 }), NOW).currentBpm).toBeNull()
  })
})

describe('liveViewModel — points, peak, avg', () => {
  it('surfaces running effort points / peak / avg', () => {
    const m = liveViewModel(openSession(), NOW)
    expect(m.effortPoints).toBe(42)
    expect(m.peakBpm).toBe(176)
    expect(m.avgBpm).toBe(138)
  })

  it('clamps effort points to a non-negative integer', () => {
    expect(liveViewModel(openSession({ effort_points: null }), NOW).effortPoints).toBe(0)
    expect(liveViewModel(openSession({ effort_points: -3 }), NOW).effortPoints).toBe(0)
    expect(liveViewModel(openSession({ effort_points: 12.7 }), NOW).effortPoints).toBe(13)
  })
})

describe('liveViewModel — Burn progress + minutes-to-burn', () => {
  it('not yet burning: reports remaining seconds/minutes toward 12 min in Z4+', () => {
    // Z4+Z5 = 400 + 50 = 450s of 720s
    const m = liveViewModel(openSession(), NOW)
    expect(m.burnSeconds).toBe(450)
    expect(m.isBurn).toBe(false)
    expect(m.secondsToBurn).toBe(BURN_THRESHOLD_SECONDS - 450) // 270
    expect(m.burnProgress).toBeCloseTo(450 / 720, 5)
    expect(minutesToBurn(m.zonesSeconds)).toBe(Math.ceil(270 / 60)) // 5
  })

  it('earned the Burn: ≥12 min in Z4+ → isBurn true, 0 to go, progress capped at 1', () => {
    const m = liveViewModel(openSession({ zones_seconds: { 4: 600, 5: 200 } }), NOW) // 800 ≥ 720
    expect(m.isBurn).toBe(true)
    expect(m.secondsToBurn).toBe(0)
    expect(m.burnProgress).toBe(1)
    expect(minutesToBurn(m.zonesSeconds)).toBe(0)
    expect(burnMinutes(m.zonesSeconds)).toBe(13) // floor(800/60)
  })

  it('exactly at threshold is a Burn', () => {
    const m = liveViewModel(openSession({ zones_seconds: { 4: BURN_THRESHOLD_SECONDS } }), NOW)
    expect(m.isBurn).toBe(true)
    expect(m.secondsToBurn).toBe(0)
  })
})

describe('liveViewModel — stale', () => {
  it('fresh sample → not stale', () => {
    expect(liveViewModel(openSession(), NOW).stale).toBe(false)
  })

  it('sample older than STALE_AFTER_MS → stale', () => {
    const old = new Date(NOW - STALE_AFTER_MS - 1000).toISOString()
    expect(liveViewModel(openSession({ last_sample_at: old, live_last_at: old }), NOW).stale).toBe(true)
  })

  it('a freshly-created session with no samples is NOT stale (falls back to started_at)', () => {
    const m = liveViewModel(
      openSession({ started_at: new Date(NOW - 5000).toISOString(), last_sample_at: null, live_last_at: null }),
      NOW,
    )
    expect(m.stale).toBe(false)
  })

  it('an ended session is never "stale" (it is done, not reconnecting)', () => {
    const old = new Date(NOW - STALE_AFTER_MS - 1000).toISOString()
    const m = liveViewModel(openSession({ last_sample_at: old, ended_at: new Date(NOW).toISOString() }), NOW)
    expect(m.stale).toBe(false)
    expect(m.ended).toBe(true)
  })
})

describe('liveViewModel — ended + elapsed + className', () => {
  it('ended_at set → ended true', () => {
    const m = liveViewModel(openSession({ ended_at: '2026-07-03T10:29:00Z' }), NOW)
    expect(m.ended).toBe(true)
  })

  it('open session → ended false', () => {
    expect(liveViewModel(openSession(), NOW).ended).toBe(false)
  })

  it('elapsed seconds from started_at, clamped at zero for a future start', () => {
    expect(liveViewModel(openSession(), NOW).elapsedSeconds).toBe(30 * 60)
    const future = liveViewModel(openSession({ started_at: new Date(NOW + 5000).toISOString() }), NOW)
    expect(future.elapsedSeconds).toBe(0)
  })

  it('carries the class name (or null)', () => {
    expect(liveViewModel(openSession(), NOW).className).toBe('ENT1TY')
    expect(liveViewModel(openSession({ class_name: null }), NOW).className).toBeNull()
    expect(liveViewModel(openSession({ class_name: '' }), NOW).className).toBeNull()
  })
})

describe('liveViewModel — null-safe (no open session)', () => {
  it('null session → fully zeroed, inactive model, no throw', () => {
    const m = liveViewModel(null, NOW)
    expect(m.active).toBe(false)
    expect(m.ended).toBe(false)
    expect(m.stale).toBe(false)
    expect(m.currentBpm).toBeNull()
    expect(m.zone).toBeNull()
    expect(m.effortPoints).toBe(0)
    expect(m.zonesSeconds).toEqual({})
    expect(m.isBurn).toBe(false)
    expect(m.secondsToBurn).toBe(BURN_THRESHOLD_SECONDS)
    expect(m.burnProgress).toBe(0)
    expect(m.elapsedSeconds).toBe(0)
    expect(m.className).toBeNull()
  })

  it('undefined session behaves like null', () => {
    expect(liveViewModel(undefined, NOW).active).toBe(false)
  })

  it('tolerates a non-object zones_seconds', () => {
    const m = liveViewModel(openSession({ zones_seconds: 'nope' }), NOW)
    expect(m.zonesSeconds).toEqual({})
    expect(m.burnSeconds).toBe(0)
  })
})

describe('formatElapsed', () => {
  it('formats sub-hour as M:SS', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(9)).toBe('0:09')
    expect(formatElapsed(65)).toBe('1:05')
    expect(formatElapsed(1800)).toBe('30:00')
  })

  it('formats over an hour as H:MM:SS', () => {
    expect(formatElapsed(3661)).toBe('1:01:01')
    expect(formatElapsed(3600)).toBe('1:00:00')
  })

  it('clamps junk to 0:00', () => {
    expect(formatElapsed(-5)).toBe('0:00')
    expect(formatElapsed(NaN)).toBe('0:00')
    expect(formatElapsed(undefined)).toBe('0:00')
  })
})

describe('BURN_COLOR', () => {
  it('is the Zone 4 (amber) accent', () => {
    expect(BURN_COLOR).toBe(ZONE_DEFS[3].color)
  })
})
