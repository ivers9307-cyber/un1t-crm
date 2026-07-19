// Tests for the connection-health grading decision (INTEG-A3).
//
// We unit-test the exported pure pieces — decideConnectionHealth (what
// the daily cron writes for a given channel_connections row) and
// isMetaAuthError (which Graph failures may flip a connection to
// 'error') — so a regression to the sweep semantics (e.g. clobbering a
// specific last_error with the generic expiry line, or "recovering" a
// row that was flagged for a non-expiry reason) is caught immediately.
// Mirrors the pattern in src/lib/postmark-webhook-auth.test.js — pull
// the predicate out of the route, leave the Supabase plumbing alone.

import { describe, it, expect } from 'vitest'
import {
  decideConnectionHealth,
  isMetaAuthError,
  isExpiryLifecycleMessage,
  expiryDateLabel,
  EXPIRY_SOON_DAYS,
} from './connection-health'

const NOW = new Date('2026-07-19T12:00:00Z')
const days = (n) => new Date(NOW.getTime() + n * 86400000).toISOString()
const label = (n) => days(n).slice(0, 10)

const row = (overrides = {}) => ({
  id: 'c-1',
  status: 'connected',
  last_error: null,
  token_expires_at: days(53),
  ...overrides,
})

describe('decideConnectionHealth', () => {
  it('leaves a healthy connected row alone', () => {
    expect(decideConnectionHealth(row(), NOW)).toBeNull()
  })

  it('returns null for a null/absent row', () => {
    expect(decideConnectionHealth(null, NOW)).toBeNull()
  })

  it('has no signal without token_expires_at (just-pasted token — lifecycle stamps nulled)', () => {
    expect(decideConnectionHealth(row({ token_expires_at: null }), NOW)).toBeNull()
    expect(decideConnectionHealth(row({ token_expires_at: 'not-a-date' }), NOW)).toBeNull()
  })

  it('never grades a not_connected row, even with a dead token', () => {
    expect(decideConnectionHealth(row({ status: 'not_connected', token_expires_at: days(-5) }), NOW)).toBeNull()
  })

  // ── expiring soon ──────────────────────────────────────────────────
  it('flips connected → action_needed inside the warning window', () => {
    expect(decideConnectionHealth(row({ token_expires_at: days(5) }), NOW)).toEqual({
      status: 'action_needed',
      last_error: `Access token expires ${label(5)}`,
    })
  })

  it('treats the window boundary as inside (exactly EXPIRY_SOON_DAYS away)', () => {
    expect(decideConnectionHealth(row({ token_expires_at: days(EXPIRY_SOON_DAYS) }), NOW)).toEqual({
      status: 'action_needed',
      last_error: `Access token expires ${label(EXPIRY_SOON_DAYS)}`,
    })
  })

  it('does not re-write an already-flagged action_needed row (no daily churn)', () => {
    const r = row({ status: 'action_needed', last_error: `Access token expires ${label(5)}`, token_expires_at: days(5) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  it('does not downgrade an error row to action_needed inside the window', () => {
    const r = row({ status: 'error', last_error: 'Meta: something broke', token_expires_at: days(5) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  // ── expired ────────────────────────────────────────────────────────
  it('flips an expired connected row to error with the expiry message', () => {
    expect(decideConnectionHealth(row({ token_expires_at: days(-3) }), NOW)).toEqual({
      status: 'error',
      last_error: `Access token expired ${label(-3)}`,
    })
  })

  it('upgrades an expiring-soon flag to expired once the date passes', () => {
    const r = row({ status: 'action_needed', last_error: `Access token expires ${label(-1)}`, token_expires_at: days(-1) })
    expect(decideConnectionHealth(r, NOW)).toEqual({
      status: 'error',
      last_error: `Access token expired ${label(-1)}`,
    })
  })

  it('escalates status but keeps a more specific existing last_error', () => {
    const r = row({ last_error: 'Meta: (#10) permission denied', token_expires_at: days(-2) })
    expect(decideConnectionHealth(r, NOW)).toEqual({ status: 'error' })
  })

  it('is idempotent once the expired state is fully written', () => {
    const r = row({ status: 'error', last_error: `Access token expired ${label(-3)}`, token_expires_at: days(-3) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  it('leaves an error row with a specific last_error fully alone when expired', () => {
    const r = row({ status: 'error', last_error: 'Meta: (#10) permission denied', token_expires_at: days(-2) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  // ── recovery after a renewed token ─────────────────────────────────
  it('recovers action_needed back to connected once the token is renewed', () => {
    const r = row({ status: 'action_needed', last_error: `Access token expires ${label(3)}`, token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toEqual({ status: 'connected', last_error: null })
  })

  it('recovers a bare action_needed (no last_error) too', () => {
    const r = row({ status: 'action_needed', last_error: null, token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toEqual({ status: 'connected', last_error: null })
  })

  it('does NOT recover an action_needed row flagged for a non-expiry reason', () => {
    const r = row({ status: 'action_needed', last_error: 'Display name review pending', token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  it('recovers an expiry-errored row once the token is renewed', () => {
    const r = row({ status: 'error', last_error: `Access token expired ${label(-40)}`, token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toEqual({ status: 'connected', last_error: null })
  })

  it('does NOT self-heal an error row whose cause is unknown (no last_error)', () => {
    const r = row({ status: 'error', last_error: null, token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })

  it('does NOT self-heal an error row with a specific last_error', () => {
    const r = row({ status: 'error', last_error: 'Meta: (#10) permission denied', token_expires_at: days(58) })
    expect(decideConnectionHealth(r, NOW)).toBeNull()
  })
})

describe('isMetaAuthError', () => {
  it('treats HTTP 401 as an auth error regardless of body', () => {
    expect(isMetaAuthError(null, 401)).toBe(true)
  })

  it('treats OAuthException as an auth error', () => {
    expect(isMetaAuthError({ type: 'OAuthException', code: 190, message: 'Error validating access token' }, 400)).toBe(true)
  })

  it('treats code 190 as an auth error even without the type (string or number)', () => {
    expect(isMetaAuthError({ code: 190 }, 400)).toBe(true)
    expect(isMetaAuthError({ code: '190' }, 400)).toBe(true)
  })

  it('does not classify ordinary Graph failures as auth errors', () => {
    expect(isMetaAuthError({ type: 'GraphMethodException', code: 100, message: '(#100) Invalid parameter' }, 400)).toBe(false)
    expect(isMetaAuthError({}, 400)).toBe(false)
    expect(isMetaAuthError(null, 500)).toBe(false)
    expect(isMetaAuthError(undefined, undefined)).toBe(false)
  })
})

describe('isExpiryLifecycleMessage', () => {
  it('matches both lifecycle forms and nothing else', () => {
    expect(isExpiryLifecycleMessage('Access token expires 2026-07-24')).toBe(true)
    expect(isExpiryLifecycleMessage('Access token expired 2026-07-10')).toBe(true)
    expect(isExpiryLifecycleMessage('Meta: (#10) permission denied')).toBe(false)
    expect(isExpiryLifecycleMessage('Access token expired yesterday')).toBe(false)
    expect(isExpiryLifecycleMessage(null)).toBe(false)
    expect(isExpiryLifecycleMessage(undefined)).toBe(false)
  })
})

describe('expiryDateLabel', () => {
  it('formats ISO strings and Dates to YYYY-MM-DD, null on garbage', () => {
    expect(expiryDateLabel('2026-09-15T05:00:00+00:00')).toBe('2026-09-15')
    expect(expiryDateLabel(new Date('2026-09-15T05:00:00Z'))).toBe('2026-09-15')
    expect(expiryDateLabel(null)).toBe(null)
    expect(expiryDateLabel('not-a-date')).toBe(null)
  })
})
