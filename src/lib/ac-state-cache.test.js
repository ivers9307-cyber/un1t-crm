// Tests for the cached-reading authority guard (SENSIBO-RATE.1 follow-up).
//
// The asymmetry under test: a cached vendor reading is always good
// enough to DISPLAY, but only a recent one may close a live session.
// Getting this backwards would close a session someone restarted at
// the wall panel, leaving the unit running with no auto-off — the
// failure mode the whole workstream exists to remove.

import { describe, it, expect } from 'vitest'
import { canCloseStaleSession, STALE_CLEANUP_MAX_AGE_MS } from './ac-state-cache.js'

const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const agoIso = (ms) => new Date(NOW - ms).toISOString()

describe('canCloseStaleSession', () => {
  it('allows a forced live read unconditionally', () => {
    expect(canCloseStaleSession({ wantsLive: true, observedAt: null, nowMs: NOW })).toBe(true)
    // Even an ancient cached stamp is irrelevant when we just read live.
    expect(canCloseStaleSession({ wantsLive: true, observedAt: agoIso(864e5), nowMs: NOW })).toBe(true)
  })

  it('allows a reading inside the freshness window', () => {
    expect(canCloseStaleSession({ observedAt: agoIso(60_000), nowMs: NOW })).toBe(true)
    expect(canCloseStaleSession({ observedAt: agoIso(STALE_CLEANUP_MAX_AGE_MS - 1000), nowMs: NOW })).toBe(true)
  })

  it('refuses a reading older than the window', () => {
    // The real case: one missed ac-external-rule tick and the reading
    // is no longer evidence of anything.
    expect(canCloseStaleSession({ observedAt: agoIso(STALE_CLEANUP_MAX_AGE_MS + 1), nowMs: NOW })).toBe(false)
    expect(canCloseStaleSession({ observedAt: agoIso(3600_000), nowMs: NOW })).toBe(false)
  })

  it('refuses when the device has never been observed', () => {
    // NULL last_state_at — a freshly added device before its first
    // cron tick. Must not be read as "observed off".
    expect(canCloseStaleSession({ observedAt: null, nowMs: NOW })).toBe(false)
    expect(canCloseStaleSession({ nowMs: NOW })).toBe(false)
    expect(canCloseStaleSession()).toBe(false)
  })

  it('refuses an unparseable timestamp rather than trusting it', () => {
    // Bad input may only ever make the guard STRICTER.
    expect(canCloseStaleSession({ observedAt: 'not-a-date', nowMs: NOW })).toBe(false)
    expect(canCloseStaleSession({ observedAt: '', nowMs: NOW })).toBe(false)
  })

  it('refuses a future timestamp — clock skew is not freshness', () => {
    expect(canCloseStaleSession({ observedAt: new Date(NOW + 60_000).toISOString(), nowMs: NOW })).toBe(false)
  })

  it('allows the window to be tightened by the caller', () => {
    expect(canCloseStaleSession({ observedAt: agoIso(120_000), nowMs: NOW, maxAgeMs: 60_000 })).toBe(false)
    expect(canCloseStaleSession({ observedAt: agoIso(30_000), nowMs: NOW, maxAgeMs: 60_000 })).toBe(true)
  })

  it('leaves room for a full cron tick — a 5-min-old reading still counts', () => {
    // ac-external-rule runs every 5 minutes; a window tighter than one
    // tick would mean the cleanup effectively never fires.
    expect(STALE_CLEANUP_MAX_AGE_MS).toBeGreaterThan(5 * 60_000)
    expect(canCloseStaleSession({ observedAt: agoIso(5 * 60_000), nowMs: NOW })).toBe(true)
  })
})
