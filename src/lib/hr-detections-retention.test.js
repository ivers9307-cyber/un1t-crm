// src/lib/hr-detections-retention.test.js — mirrors hr-retention.test.js.
import { describe, it, expect } from 'vitest'
import {
  HR_DETECTIONS_RETENTION_DAYS,
  HR_DETECTIONS_PRUNE_BATCH,
  HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN,
  detectionsRetentionCutoff,
  isDetectionsCutoffSafe,
  wouldExceedDetectionsDeleteCap,
} from './hr-detections-retention'

describe('constants', () => {
  it('30-day window, bounded batches', () => {
    expect(HR_DETECTIONS_RETENTION_DAYS).toBe(30)
    expect(HR_DETECTIONS_PRUNE_BATCH).toBe(500)
    expect(HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN).toBe(5000)
    // The cap must be a whole number of batches so the run stops cleanly.
    expect(HR_DETECTIONS_PRUNE_MAX_DELETES_PER_RUN % HR_DETECTIONS_PRUNE_BATCH).toBe(0)
  })
})

describe('detectionsRetentionCutoff', () => {
  it('subtracts the retention window from now', () => {
    const now = new Date('2026-08-04T12:00:00Z')
    expect(detectionsRetentionCutoff(now).toISOString()).toBe('2026-07-05T12:00:00.000Z')
  })

  it('honours a custom day count', () => {
    const now = new Date('2026-08-04T00:00:00Z')
    expect(detectionsRetentionCutoff(now, 7).toISOString()).toBe('2026-07-28T00:00:00.000Z')
  })

  it('rejects an invalid now', () => {
    expect(() => detectionsRetentionCutoff('not-a-date')).toThrow()
  })

  it('rejects a non-positive day count', () => {
    expect(() => detectionsRetentionCutoff(new Date(), 0)).toThrow()
    expect(() => detectionsRetentionCutoff(new Date(), -1)).toThrow()
  })
})

describe('isDetectionsCutoffSafe — guards against touching recent data', () => {
  const now = new Date('2026-08-04T12:00:00Z')

  it('accepts a correctly-computed 30-day cutoff', () => {
    expect(isDetectionsCutoffSafe(detectionsRetentionCutoff(now), now)).toBe(true)
  })

  it('rejects a cutoff at "now" (misconfig: days=0 would land here)', () => {
    expect(isDetectionsCutoffSafe(now, now)).toBe(false)
  })

  it('rejects a future cutoff (clock skew)', () => {
    const future = new Date('2026-09-01T00:00:00Z')
    expect(isDetectionsCutoffSafe(future, now)).toBe(false)
  })

  it('rejects a cutoff only a few days back (window shrunk by misconfig)', () => {
    const fiveDaysBack = detectionsRetentionCutoff(now, 5)
    expect(isDetectionsCutoffSafe(fiveDaysBack, now)).toBe(false)
  })

  it('accepts a cutoff comfortably older than the window', () => {
    const old = detectionsRetentionCutoff(now, 90)
    expect(isDetectionsCutoffSafe(old, now)).toBe(true)
  })

  it('rejects invalid inputs', () => {
    expect(isDetectionsCutoffSafe('x', now)).toBe(false)
    expect(isDetectionsCutoffSafe(now, 'x')).toBe(false)
  })
})

describe('wouldExceedDetectionsDeleteCap', () => {
  it('allows batches up to the cap exactly', () => {
    expect(wouldExceedDetectionsDeleteCap(0, 5000)).toBe(false)
    expect(wouldExceedDetectionsDeleteCap(4500, 500)).toBe(false)
  })

  it('stops the batch that would cross the cap', () => {
    expect(wouldExceedDetectionsDeleteCap(5000, 1)).toBe(true)
    expect(wouldExceedDetectionsDeleteCap(4999, 2)).toBe(true)
  })

  it('honours a custom cap', () => {
    expect(wouldExceedDetectionsDeleteCap(9, 1, 10)).toBe(false)
    expect(wouldExceedDetectionsDeleteCap(10, 1, 10)).toBe(true)
  })
})
