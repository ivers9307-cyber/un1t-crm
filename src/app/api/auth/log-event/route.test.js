// AUDIT-SEC.2 — the public auth-audit endpoint must be rate-limited and must
// not let a client-asserted `ok:true` masquerade as an authoritative success.
//
// log-event is unauthenticated for sign_in / reset (by design — the Supabase
// JS auth calls never touch our Node server, so the client reports the outcome
// afterwards). That makes it abusable: an attacker can flood audit_events with
// forged sign-in rows for any email. These tests pin (a) an IP rate limit and
// (b) that client-reported events are stored tagged `source: 'client_claim'`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date(0), retryAfterSec: 0 })),
  getClientIp: vi.fn((request) => request.headers.get('x-forwarded-for') || 'unknown'),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => null) }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))

import { checkRateLimit } from '@/lib/rate-limit'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'
import { POST } from './route.js'

const IP = '203.0.113.9'

function req(body) {
  return new Request('http://test.local/api/auth/log-event', {
    method: 'POST',
    headers: { 'x-forwarded-for': IP, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Unknown-email profiles lookup → { data: null } so the handler runs its
// unauthenticated (client-claim) branch to completion.
function mockNoProfile() {
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockNoProfile()
})

describe('log-event rate limiting', () => {
  it('rejects with 429 when the IP limiter is exhausted, keyed by IP', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })
    const res = await POST(req({ action: 'auth.sign_in', ok: true, email: 'victim@example.com' }))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    expect(checkRateLimit.mock.calls[0][1]).toBe(`log-event:${IP}`)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('lets a request through and writes the audit row when under the limit', async () => {
    const res = await POST(req({ action: 'auth.sign_in', ok: false, email: 'victim@example.com' }))
    expect(res.status).toBe(200)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })
})

describe('log-event client-asserted integrity', () => {
  it('tags unauthenticated sign-in events as source: client_claim', async () => {
    await POST(req({ action: 'auth.sign_in', ok: true, email: 'victim@example.com' }))
    const payload = logAuditEvent.mock.calls[0][0]
    expect(payload.details.source).toBe('client_claim')
    // ok is still captured, but only alongside the client_claim tag so it can
    // never be read back as an authoritative success.
    expect(payload.details.ok).toBe(true)
  })
})
