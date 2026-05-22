// Tests for glofox-data-quality.js — pure pack-credit freshness check.

import { describe, it, expect } from 'vitest'
import { isPackCreditDataStale, PACK_CREDIT_MAX_AGE_DAYS } from './glofox-data-quality.js'

const NOW = Date.parse('2026-05-22T12:00:00.000Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

describe('PACK-FRESHNESS.1 — isPackCreditDataStale', () => {
  it('is fresh when the last pack sync was within the threshold', () => {
    expect(isPackCreditDataStale(daysAgo(0.25), NOW)).toBe(false)
    expect(isPackCreditDataStale(daysAgo(1), NOW)).toBe(false)
    expect(isPackCreditDataStale(daysAgo(PACK_CREDIT_MAX_AGE_DAYS), NOW)).toBe(false)
  })

  it('is stale once the last pack sync is older than the threshold', () => {
    expect(isPackCreditDataStale(daysAgo(PACK_CREDIT_MAX_AGE_DAYS + 0.5), NOW)).toBe(true)
    expect(isPackCreditDataStale(daysAgo(7), NOW)).toBe(true)
  })

  it('treats a missing / null timestamp as stale', () => {
    expect(isPackCreditDataStale(null, NOW)).toBe(true)
    expect(isPackCreditDataStale(undefined, NOW)).toBe(true)
    expect(isPackCreditDataStale('', NOW)).toBe(true)
  })

  it('treats an unparseable timestamp as stale', () => {
    expect(isPackCreditDataStale('not-a-date', NOW)).toBe(true)
  })
})
