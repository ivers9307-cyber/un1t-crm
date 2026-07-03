// src/lib/hr-retention.test.js
import { describe, it, expect } from 'vitest'
import {
  HR_RAW_RETENTION_MONTHS,
  HR_DOWNSAMPLE_BUCKET_SECONDS,
  HR_PRUNE_MAX_DELETES_PER_RUN,
  retentionCutoff,
  isCutoffSafe,
  bucketKey,
  planSessionDownsample,
  wouldExceedDeleteCap,
} from './hr-retention'

describe('constants', () => {
  it('12-month window, 30s bucket', () => {
    expect(HR_RAW_RETENTION_MONTHS).toBe(12)
    expect(HR_DOWNSAMPLE_BUCKET_SECONDS).toBe(30)
  })
})

describe('retentionCutoff', () => {
  it('subtracts the retention window from now (UTC)', () => {
    const now = new Date('2026-07-03T12:00:00Z')
    expect(retentionCutoff(now).toISOString()).toBe('2025-07-03T12:00:00.000Z')
  })

  it('honours a custom month count', () => {
    const now = new Date('2026-07-03T00:00:00Z')
    expect(retentionCutoff(now, 6).toISOString()).toBe('2026-01-03T00:00:00.000Z')
  })

  it('rejects an invalid now', () => {
    expect(() => retentionCutoff('not-a-date')).toThrow()
  })

  it('rejects a non-positive month count', () => {
    expect(() => retentionCutoff(new Date(), 0)).toThrow()
    expect(() => retentionCutoff(new Date(), -1)).toThrow()
  })
})

describe('isCutoffSafe — guards against touching recent data', () => {
  const now = new Date('2026-07-03T12:00:00Z')

  it('accepts a correctly-computed 12-month cutoff', () => {
    expect(isCutoffSafe(retentionCutoff(now), now)).toBe(true)
  })

  it('rejects a cutoff at "now" (misconfig: months=0 would land here)', () => {
    expect(isCutoffSafe(now, now)).toBe(false)
  })

  it('rejects a future cutoff (clock skew)', () => {
    const future = new Date('2026-08-01T00:00:00Z')
    expect(isCutoffSafe(future, now)).toBe(false)
  })

  it('rejects a cutoff only a few months back (window shrunk by misconfig)', () => {
    const threeMonthsBack = retentionCutoff(now, 3)
    expect(isCutoffSafe(threeMonthsBack, now)).toBe(false)
  })

  it('accepts a cutoff comfortably older than the window', () => {
    const old = retentionCutoff(now, 24)
    expect(isCutoffSafe(old, now)).toBe(true)
  })

  it('rejects invalid inputs', () => {
    expect(isCutoffSafe('x', now)).toBe(false)
    expect(isCutoffSafe(now, 'x')).toBe(false)
  })
})

describe('bucketKey — 30s UTC-anchored buckets', () => {
  it('floors to the 30-second boundary', () => {
    const a = bucketKey('2026-01-01T10:00:00Z')
    const b = bucketKey('2026-01-01T10:00:29Z')
    const c = bucketKey('2026-01-01T10:00:30Z')
    expect(a).toBe(b) // same bucket
    expect(c).not.toBe(a) // next bucket
    expect(c - a).toBe(30_000)
  })

  it('throws on an unparseable timestamp', () => {
    expect(() => bucketKey('nope')).toThrow()
  })
})

describe('planSessionDownsample — one representative per 30s bucket', () => {
  it('keeps the earliest sample in each bucket, deletes the rest', () => {
    const samples = [
      { recorded_at: '2026-01-01T10:00:00Z' }, // bucket A — kept (earliest)
      { recorded_at: '2026-01-01T10:00:05Z' }, // bucket A — deleted
      { recorded_at: '2026-01-01T10:00:29Z' }, // bucket A — deleted
      { recorded_at: '2026-01-01T10:00:30Z' }, // bucket B — kept (earliest)
      { recorded_at: '2026-01-01T10:00:59Z' }, // bucket B — deleted
    ]
    const { keep, delete: del } = planSessionDownsample(samples)
    expect(keep).toEqual(['2026-01-01T10:00:00.000Z', '2026-01-01T10:00:30.000Z'])
    expect(del).toEqual([
      '2026-01-01T10:00:05.000Z',
      '2026-01-01T10:00:29.000Z',
      '2026-01-01T10:00:59.000Z',
    ])
  })

  it('keeps the earliest even when rows arrive out of order', () => {
    const samples = [
      { recorded_at: '2026-01-01T10:00:20Z' },
      { recorded_at: '2026-01-01T10:00:05Z' }, // earliest in bucket A
      { recorded_at: '2026-01-01T10:00:10Z' },
    ]
    const { keep, delete: del } = planSessionDownsample(samples)
    expect(keep).toEqual(['2026-01-01T10:00:05.000Z'])
    expect(del).toEqual(['2026-01-01T10:00:20.000Z', '2026-01-01T10:00:10.000Z'])
  })

  it('is idempotent — a second pass on the kept set deletes nothing', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({
      recorded_at: new Date(Date.parse('2026-01-01T10:00:00Z') + i * 1000).toISOString(),
    }))
    const first = planSessionDownsample(samples)
    // 60 seconds → two 30s buckets → 2 kept, 58 deleted.
    expect(first.keep).toHaveLength(2)
    expect(first.delete).toHaveLength(58)
    const second = planSessionDownsample(first.keep.map(recorded_at => ({ recorded_at })))
    expect(second.delete).toHaveLength(0)
    expect(second.keep).toHaveLength(2)
  })

  it('handles empty / null input', () => {
    expect(planSessionDownsample([])).toEqual({ keep: [], delete: [] })
    expect(planSessionDownsample(null)).toEqual({ keep: [], delete: [] })
  })

  it('skips unparseable rows rather than scheduling them for delete', () => {
    const { keep, delete: del } = planSessionDownsample([
      { recorded_at: 'garbage' },
      { recorded_at: '2026-01-01T10:00:00Z' },
    ])
    expect(keep).toEqual(['2026-01-01T10:00:00.000Z'])
    expect(del).toEqual([])
  })

  it('deletes an exact-duplicate timestamp within a bucket, keeping one', () => {
    const { keep, delete: del } = planSessionDownsample([
      { recorded_at: '2026-01-01T10:00:00Z' },
      { recorded_at: '2026-01-01T10:00:00Z' },
    ])
    expect(keep).toHaveLength(1)
    expect(del).toHaveLength(1)
  })
})

describe('wouldExceedDeleteCap', () => {
  it('false when the run stays under the cap', () => {
    expect(wouldExceedDeleteCap(0, 100)).toBe(false)
    expect(wouldExceedDeleteCap(HR_PRUNE_MAX_DELETES_PER_RUN - 1, 1)).toBe(false)
  })
  it('true when the session would push the run over the cap', () => {
    expect(wouldExceedDeleteCap(HR_PRUNE_MAX_DELETES_PER_RUN, 1)).toBe(true)
    expect(wouldExceedDeleteCap(HR_PRUNE_MAX_DELETES_PER_RUN - 5, 10)).toBe(true)
  })
  it('honours a custom cap', () => {
    expect(wouldExceedDeleteCap(90, 20, 100)).toBe(true)
    expect(wouldExceedDeleteCap(80, 20, 100)).toBe(false)
  })
})
