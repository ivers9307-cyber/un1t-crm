// SHELLY-UI.6 — every branch of the health grader, with the two that exist
// for a reason pinned hardest:
//   * connected:false beats staleness (a deliberate Disconnect must not paint
//     the estate red and blame a connection the operator removed)
//   * connected:null never reaches red (a db blip on OUR side must not invent
//     a fault in THEIR hardware)

import { describe, it, expect } from 'vitest'
import { deviceHealth, HEALTH_FRESH_MS, HEALTH_STALE_MS, HEALTH_TONE_CLASSES } from './device-health.js'
import { STATE_REFRESH_MS } from './status.js'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const MIN = 60_000

const dev = (over = {}) => ({
  last_seen_at: ago(30_000),
  last_state: { online: true, output: true, apower: 12, aenergy_wh: 100, temperature_c: 30, source: 'schedule', at: ago(30_000) },
  ...over,
})

describe('deviceHealth — connection first', () => {
  it('grades a disconnected location dormant, never stale, however old the reading', () => {
    const h = deviceHealth(dev({ last_seen_at: ago(90 * MIN) }), { connected: false, nowMs: NOW })
    expect(h).toEqual({ tone: 'grey', label: 'Not connected', reason: 'not_connected' })
  })

  it('connected:false wins even over an offline reading and a missing last_seen_at', () => {
    expect(deviceHealth(dev({ last_state: { online: false } }), { connected: false, nowMs: NOW }).reason)
      .toBe('not_connected')
    expect(deviceHealth({ last_seen_at: null }, { connected: false, nowMs: NOW }).reason)
      .toBe('not_connected')
  })

  it('answers "connection unknown" when neither the connection nor a reading is known', () => {
    expect(deviceHealth({ last_seen_at: null }, { connected: null, nowMs: NOW }))
      .toEqual({ tone: 'grey', label: 'Connection unknown', reason: 'connection_unknown' })
  })

  it('treats an absent connected flag exactly like null', () => {
    expect(deviceHealth({ last_seen_at: null }, { nowMs: NOW }).reason).toBe('connection_unknown')
    expect(deviceHealth({ last_seen_at: null }, {}).reason).toBe('connection_unknown')
    expect(deviceHealth({ last_seen_at: null }).reason).toBe('connection_unknown')
  })

  it('caps an uncertain connection at amber — it never grades red', () => {
    const h = deviceHealth(dev({ last_seen_at: ago(45 * MIN) }), { connected: null, nowMs: NOW })
    expect(h.tone).toBe('amber')
    expect(h.reason).toBe('lagging_unverified')
    // The AGE is still reported — it is a true fact about the last reading.
    expect(h.label).toBe('Last seen 45 min ago')
  })

  it('still grades green/amber normally while the connection is unknown', () => {
    expect(deviceHealth(dev(), { connected: null, nowMs: NOW }).tone).toBe('green')
    expect(deviceHealth(dev({ last_seen_at: ago(HEALTH_FRESH_MS + MIN) }), { connected: null, nowMs: NOW }).reason).toBe('lagging')
  })
})

describe('deviceHealth — freshness', () => {
  it('never seen', () => {
    expect(deviceHealth({ last_seen_at: null }, { connected: true, nowMs: NOW }))
      .toEqual({ tone: 'grey', label: 'Waiting for first status', reason: 'never_seen' })
  })

  it('an unparseable last_seen_at is "never seen", not an age of NaN', () => {
    expect(deviceHealth({ last_seen_at: 'not-a-date' }, { connected: true, nowMs: NOW }).reason).toBe('never_seen')
  })

  it('an offline reading is grey Offline, not an age grade', () => {
    const d = dev({ last_seen_at: ago(30 * MIN), last_state: { online: false, output: null } })
    expect(deviceHealth(d, { connected: true, nowMs: NOW }))
      .toEqual({ tone: 'grey', label: 'Offline', reason: 'offline' })
  })

  it('online:null is not offline — it is graded by age', () => {
    const d = dev({ last_state: { online: null, output: null } })
    expect(deviceHealth(d, { connected: true, nowMs: NOW }).tone).toBe('green')
  })

  // SHELLY-UI.9b — the fresh window is sized to the engine's WRITE floor, not
  // its read cadence: reconcile.js reads every minute but only rewrites a row
  // when stateChanged says something moved, so a deadband-stable idle plug
  // advances last_seen_at only every STATE_REFRESH_MS. A window at or below
  // that floor grades a perfectly healthy idle plug amber for part of every
  // cycle. Pinned as a RELATION, not as a number, so raising the floor cannot
  // silently bring the flicker back.
  it('the fresh window is strictly longer than the engine refresh floor', () => {
    expect(HEALTH_FRESH_MS).toBeGreaterThan(STATE_REFRESH_MS)
    expect(HEALTH_STALE_MS).toBeGreaterThan(HEALTH_FRESH_MS)
    // An idle plug rewritten exactly on the floor must still read green.
    expect(deviceHealth(dev({ last_seen_at: ago(STATE_REFRESH_MS) }), { connected: true, nowMs: NOW }).reason)
      .toBe('fresh')
  })

  it('green up to and including the fresh window', () => {
    expect(deviceHealth(dev({ last_seen_at: ago(0) }), { connected: true, nowMs: NOW }).reason).toBe('fresh')
    expect(deviceHealth(dev({ last_seen_at: ago(HEALTH_FRESH_MS) }), { connected: true, nowMs: NOW }).reason).toBe('fresh')
  })

  it('amber just past the fresh window, with the age in minutes', () => {
    const h = deviceHealth(dev({ last_seen_at: ago(HEALTH_FRESH_MS + 1000) }), { connected: true, nowMs: NOW })
    expect(h.tone).toBe('amber')
    expect(h.label).toBe('Last seen 6 min ago')
  })

  it('amber up to and including the stale window', () => {
    const h = deviceHealth(dev({ last_seen_at: ago(HEALTH_STALE_MS) }), { connected: true, nowMs: NOW })
    expect(h.tone).toBe('amber')
    expect(h.label).toBe('Last seen 15 min ago')
  })

  it('red past the stale window', () => {
    const h = deviceHealth(dev({ last_seen_at: ago(HEALTH_STALE_MS + 1000) }), { connected: true, nowMs: NOW })
    expect(h).toEqual({ tone: 'red', label: 'Stale — check the Shelly connection', reason: 'stale' })
  })

  it('a clock-skewed future reading is green, not a negative age', () => {
    const h = deviceHealth(dev({ last_seen_at: new Date(NOW + 5 * MIN).toISOString() }), { connected: true, nowMs: NOW })
    expect(h.reason).toBe('fresh')
  })

  it('defaults nowMs to the real clock rather than producing NaN', () => {
    const h = deviceHealth({ last_seen_at: new Date().toISOString(), last_state: { online: true } }, { connected: true })
    expect(h.reason).toBe('fresh')
  })
})

describe('deviceHealth — tones', () => {
  it('every tone the grader can return has a chip class', () => {
    const tones = new Set([
      deviceHealth({ last_seen_at: null }, { connected: false }).tone,
      deviceHealth({ last_seen_at: null }, { connected: null }).tone,
      deviceHealth({ last_seen_at: null }, { connected: true }).tone,
      deviceHealth(dev(), { connected: true, nowMs: NOW }).tone,
      deviceHealth(dev({ last_seen_at: ago(HEALTH_FRESH_MS + MIN) }), { connected: true, nowMs: NOW }).tone,
      deviceHealth(dev({ last_seen_at: ago(60 * MIN) }), { connected: true, nowMs: NOW }).tone,
    ])
    expect([...tones].sort()).toEqual(['amber', 'green', 'grey', 'red'])
    for (const tone of tones) expect(HEALTH_TONE_CLASSES[tone]).toBeTruthy()
  })
})
