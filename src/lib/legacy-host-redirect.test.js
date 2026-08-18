// REPSET-P6.S2 — unit tests for the pure legacy-host redirect decision.
//
// The proxy consults decideLegacyHostRedirect() on every request. It must:
//   - stay completely inert unless REDIRECT_LEGACY_CRM_HOST=1 (enabled flag)
//   - match ONLY the exact legacy CRM host (crm.un1tdublin.com) — never the
//     marketing site (un1tdublin.com), tenant brand hosts, or the canonical
//     repset host itself
//   - redirect ONLY safe idempotent methods (GET/HEAD)
//   - never touch /api/* (kiosk heartbeats, bridge/fleet agents, webhooks),
//     /auth/callback or /reset-password (in-flight PKCE links carry
//     old-domain verifier cookies — the estate's known reset-PKCE failure
//     class; a cross-domain hop strands the code verifier)
//   - preserve the FULL path + query (the kiosk heartbeat lives in ?device=)
//   - use 308 so clients keep method + body semantics

import { describe, it, expect } from 'vitest'
import { decideLegacyHostRedirect, LEGACY_CRM_HOST, CANONICAL_CRM_ORIGIN } from './legacy-host-redirect.js'

function decide(overrides = {}) {
  return decideLegacyHostRedirect({
    enabled: true,
    host: LEGACY_CRM_HOST,
    method: 'GET',
    pathname: '/',
    search: '',
    ...overrides,
  })
}

describe('decideLegacyHostRedirect', () => {
  it('exports the expected host constants', () => {
    expect(LEGACY_CRM_HOST).toBe('crm.un1tdublin.com')
    expect(CANONICAL_CRM_ORIGIN).toBe('https://crm.repset.ie')
  })

  // ── Enabled flag (default OFF) ─────────────────────────────────────
  it('returns null when disabled, even for a perfect match', () => {
    expect(decide({ enabled: false })).toBeNull()
  })

  it('returns null when enabled is undefined (env unset)', () => {
    expect(decide({ enabled: undefined })).toBeNull()
  })

  // ── Host matching ──────────────────────────────────────────────────
  it('redirects the exact legacy CRM host', () => {
    expect(decide()).toEqual({
      status: 308,
      location: 'https://crm.repset.ie/',
    })
  })

  it('matches case-insensitively and ignores a port suffix', () => {
    expect(decide({ host: 'CRM.UN1TDUBLIN.COM' })).not.toBeNull()
    expect(decide({ host: 'crm.un1tdublin.com:443' })).not.toBeNull()
  })

  it('never touches the marketing host (un1tdublin.com)', () => {
    expect(decide({ host: 'un1tdublin.com' })).toBeNull()
    expect(decide({ host: 'www.un1tdublin.com' })).toBeNull()
  })

  it('never touches other brand / tenant hosts or the canonical host', () => {
    expect(decide({ host: 'pay.ccfautos.com' })).toBeNull()
    expect(decide({ host: 'crm.repset.ie' })).toBeNull()
    expect(decide({ host: 'app.champfitness.ie' })).toBeNull()
    expect(decide({ host: 'localhost:3000' })).toBeNull()
    expect(decide({ host: '' })).toBeNull()
    expect(decide({ host: undefined })).toBeNull()
  })

  // ── Method gating ──────────────────────────────────────────────────
  it('redirects GET and HEAD only', () => {
    expect(decide({ method: 'GET' })).not.toBeNull()
    expect(decide({ method: 'HEAD' })).not.toBeNull()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(decide({ method })).toBeNull()
    }
  })

  // ── Path exclusions ────────────────────────────────────────────────
  it('never redirects /api/* (kiosk heartbeats, bridges, fleet, webhooks)', () => {
    expect(decide({ pathname: '/api/auth/studio-heartbeat', search: '?device=abc' })).toBeNull()
    expect(decide({ pathname: '/api/bridge/heartbeat' })).toBeNull()
    expect(decide({ pathname: '/api/webhooks/twilio/status' })).toBeNull()
    expect(decide({ pathname: '/api/openapi.json' })).toBeNull()
  })

  it('never redirects /auth/callback or /reset-password (in-flight PKCE)', () => {
    expect(decide({ pathname: '/auth/callback' })).toBeNull()
    expect(decide({ pathname: '/auth/callback', search: '?code=xyz' })).toBeNull()
    expect(decide({ pathname: '/reset-password' })).toBeNull()
    expect(decide({ pathname: '/reset-password', search: '?token_hash=abc' })).toBeNull()
  })

  it('excludes by path segment, not raw prefix', () => {
    // Hypothetical sibling pages must not be swallowed by the exclusions…
    expect(decide({ pathname: '/reset-password-info' })).not.toBeNull()
    // …while nested segments under the excluded paths stay excluded.
    expect(decide({ pathname: '/auth/callback/next' })).toBeNull()
    expect(decide({ pathname: '/reset-password/confirm' })).toBeNull()
  })

  // ── URL construction ───────────────────────────────────────────────
  it('preserves the full path + query string', () => {
    expect(decide({ pathname: '/studio-login', search: '?device=kiosk-1&x=2' })).toEqual({
      status: 308,
      location: 'https://crm.repset.ie/studio-login?device=kiosk-1&x=2',
    })
  })

  it('handles a missing search gracefully', () => {
    expect(decide({ pathname: '/dashboard', search: undefined })).toEqual({
      status: 308,
      location: 'https://crm.repset.ie/dashboard',
    })
  })
})
