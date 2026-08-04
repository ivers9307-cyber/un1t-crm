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
