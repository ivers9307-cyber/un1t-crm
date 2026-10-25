import { describe, it, expect } from 'vitest'
import { FAILED_RETRY_BACKOFF_MS, failedRetryCutoffIso, buildAutoOffFailureAlert } from './ac-auto-off.js'

describe('failedRetryCutoffIso', () => {
  it('is exactly the backoff window before now', () => {
    const nowMs = Date.parse('2026-08-04T12:00:00.000Z')
    expect(failedRetryCutoffIso(nowMs)).toBe(new Date(nowMs - FAILED_RETRY_BACKOFF_MS).toISOString())
  })
  it('defaults to a one-hour backoff (the max alert rate per failing row)', () => {
    expect(FAILED_RETRY_BACKOFF_MS).toBe(60 * 60 * 1000)
  })
  it('accepts a custom backoff', () => {
    const nowMs = Date.parse('2026-08-04T12:00:00.000Z')
    expect(failedRetryCutoffIso(nowMs, 30 * 60_000)).toBe('2026-08-04T11:30:00.000Z')
  })
})

describe('buildAutoOffFailureAlert', () => {
  const device = { id: 'dev-1', label: 'Studio AC' }
  const location = { id: 'loc-1', name: 'Stillorgan', organization_id: 'org-1' }

  it('routes to the org with location attribution and the failure reason', () => {
    const alert = buildAutoOffFailureAlert({ device, location, failureReason: 'pod offline' })
    expect(alert.organizationId).toBe('org-1')
    expect(alert.locationId).toBe('loc-1')
    expect(alert.subject).toBe('AC auto-off failing at Stillorgan')
    expect(alert.htmlBody).toContain('Studio AC')
    expect(alert.htmlBody).toContain('Stillorgan')
    expect(alert.htmlBody).toContain('pod offline')
    expect(alert.pushBody).toContain('Studio AC')
    expect(alert.pushBody).toContain('pod offline')
  })
  it('degrades to ids / placeholders when labels are missing', () => {
    const alert = buildAutoOffFailureAlert({ device: { id: 'dev-1' }, location: { id: 'loc-1' }, failureReason: null })
    expect(alert.subject).toBe('AC auto-off failing at loc-1')
    expect(alert.htmlBody).toContain('dev-1')
    expect(alert.htmlBody).toContain('unknown error')
    expect(alert.organizationId).toBeNull()
  })
  it('truncates a runaway failure reason to 500 chars', () => {
    const alert = buildAutoOffFailureAlert({ device, location, failureReason: 'x'.repeat(2000) })
    expect(alert.pushBody.length).toBeLessThan(700)
  })
})

// AC-RETRY.1 — fast retry for transient vendor failures, quiet alerts.
import {
  FAST_RETRY_BACKOFF_MS, FAST_RETRY_MAX_ATTEMPTS, ALERT_AFTER_ATTEMPTS, ALERT_REPEAT_MS,
  isTransientVendorFailure, shouldRetryFailedRow, shouldAlertFailure,
} from './ac-auto-off.js'

const NOW = Date.parse('2026-10-03T08:10:32.000Z')
const agoIso = (ms) => new Date(NOW - ms).toISOString()
const TIMEOUT = 'Auto-off failed at 2026-10-03T08:05:32.252Z: AC vendor refused the request: Sensibo network error: The operation was aborted due to timeout'

describe('AC-RETRY.1 constants', () => {
  it('fast lane is one tick (under 5 min, so the ~30s-late cron does not skip a tick), capped at an hour of tries', () => {
    expect(FAST_RETRY_BACKOFF_MS).toBe(4 * 60_000)
    expect(FAST_RETRY_BACKOFF_MS).toBeLessThan(5 * 60_000)
    expect(FAST_RETRY_MAX_ATTEMPTS * 5 * 60_000).toBe(FAILED_RETRY_BACKOFF_MS)
    expect(ALERT_AFTER_ATTEMPTS).toBe(3)
    expect(ALERT_REPEAT_MS).toBe(60 * 60_000)
  })
})

describe('isTransientVendorFailure', () => {
  it('recognises the timeout / abort / network / rate-limit family', () => {
    expect(isTransientVendorFailure(TIMEOUT)).toBe(true)
    expect(isTransientVendorFailure('Sensibo network error: fetch failed')).toBe(true)
    expect(isTransientVendorFailure('API Limit exceeded. Lower the request rate')).toBe(true)
    expect(isTransientVendorFailure('Sensibo 429: slow down')).toBe(true)
    expect(isTransientVendorFailure('ECONNRESET')).toBe(true)
  })
  it('treats anything else as persistent', () => {
    expect(isTransientVendorFailure('Sensibo API key is missing — configure it in Location settings.')).toBe(false)
    expect(isTransientVendorFailure('Pod not found')).toBe(false)
    expect(isTransientVendorFailure(null)).toBe(false)
    expect(isTransientVendorFailure('')).toBe(false)
  })
})

describe('shouldRetryFailedRow', () => {
  const transientRow = (ageMs, attempts) => ({ updated_at: agoIso(ageMs), auto_off_attempts: attempts, failure_reason: TIMEOUT })
  const persistentRow = (ageMs, attempts) => ({ updated_at: agoIso(ageMs), auto_off_attempts: attempts, failure_reason: 'Pod not found' })

  it('retries a transient failure on the next tick (written 4m46s ago, like a real :05:46 write seen at :10:32)', () => {
    expect(shouldRetryFailedRow(transientRow(4 * 60_000 + 46_000, 1), NOW)).toBe(true)
  })
  it('does NOT retry a transient failure written less than the fast backoff ago (same tick)', () => {
    expect(shouldRetryFailedRow(transientRow(30_000, 1), NOW)).toBe(false)
  })
  it('drops a transient failure back to the hourly lane once the fast attempts are spent', () => {
    expect(shouldRetryFailedRow(transientRow(10 * 60_000, FAST_RETRY_MAX_ATTEMPTS), NOW)).toBe(false)
    expect(shouldRetryFailedRow(transientRow(FAILED_RETRY_BACKOFF_MS, FAST_RETRY_MAX_ATTEMPTS), NOW)).toBe(true)
  })
  it('keeps a persistent failure on the hourly lane', () => {
    expect(shouldRetryFailedRow(persistentRow(10 * 60_000, 1), NOW)).toBe(false)
    expect(shouldRetryFailedRow(persistentRow(FAILED_RETRY_BACKOFF_MS, 1), NOW)).toBe(true)
  })
  it('treats a missing attempt count as zero (rows that pre-date mig 704)', () => {
    expect(shouldRetryFailedRow({ updated_at: agoIso(5 * 60_000), failure_reason: TIMEOUT }, NOW)).toBe(true)
  })
  it('treats an unreadable updated_at as due — a row we cannot date must not sit in failed forever', () => {
    expect(shouldRetryFailedRow({ updated_at: null, failure_reason: 'Pod not found' }, NOW)).toBe(true)
    expect(shouldRetryFailedRow({ updated_at: 'garbage', failure_reason: 'Pod not found' }, NOW)).toBe(true)
  })
})

describe('shouldAlertFailure', () => {
  it('transient: silent for the first two misses, alerts on the third', () => {
    expect(shouldAlertFailure({ transient: true, attempts: 1, alertedAt: null, nowMs: NOW })).toBe(false)
    expect(shouldAlertFailure({ transient: true, attempts: 2, alertedAt: null, nowMs: NOW })).toBe(false)
    expect(shouldAlertFailure({ transient: true, attempts: 3, alertedAt: null, nowMs: NOW })).toBe(true)
  })
  it('persistent: alerts on the first miss — nothing about it clears on its own', () => {
    expect(shouldAlertFailure({ transient: false, attempts: 1, alertedAt: null, nowMs: NOW })).toBe(true)
  })
  it('repeats at most hourly while the row keeps failing', () => {
    expect(shouldAlertFailure({ transient: true, attempts: 4, alertedAt: agoIso(5 * 60_000), nowMs: NOW })).toBe(false)
    expect(shouldAlertFailure({ transient: true, attempts: 15, alertedAt: agoIso(ALERT_REPEAT_MS), nowMs: NOW })).toBe(true)
  })
  it('treats an unreadable alertedAt as never alerted', () => {
    expect(shouldAlertFailure({ transient: true, attempts: 3, alertedAt: 'garbage', nowMs: NOW })).toBe(true)
  })
})

describe('buildAutoOffFailureAlert — AC-RETRY.1 wording', () => {
  const device = { id: 'dev-1', label: 'Studio AC' }
  const location = { id: 'loc-1', name: 'Stillorgan', organization_id: 'org-1' }
  it('names the attempt count and the fast cadence for a transient failure', () => {
    const alert = buildAutoOffFailureAlert({ device, location, failureReason: 'timeout', attempts: 3, transient: true })
    expect(alert.htmlBody).toContain('3 attempts so far')
    expect(alert.htmlBody).toMatch(/every 5 minutes/)
    expect(alert.pushBody).toContain('3 attempts so far')
  })
  it('keeps the hourly wording for a persistent failure and omits the count on a first miss', () => {
    const alert = buildAutoOffFailureAlert({ device, location, failureReason: 'Pod not found', attempts: 1, transient: false })
    expect(alert.htmlBody).not.toContain('attempts so far')
    expect(alert.htmlBody).toMatch(/hourly/)
  })
})
