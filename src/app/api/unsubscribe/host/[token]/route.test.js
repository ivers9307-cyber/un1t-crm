// HOST-CONSENT.1 — the RFC 8058 one-click target for host emails.
// toListUnsubscribeUrl rewrites /unsubscribe/host/<t> → /api/unsubscribe/host/<t>,
// which 404'd until this route existed: Gmail's POST was silently lost.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-unsubscribe', () => ({ verifyHostUnsubToken: vi.fn() }))
vi.mock('@/lib/host-consent', () => ({ revokeHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }) }))
vi.mock('@/lib/postmark-suppressions', () => ({ suppressAtPostmark: vi.fn().mockResolvedValue({ ok: 1, failed: [] }) }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '5.5.5.5',
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitResponse: vi.fn(() => new Response('rl', { status: 429 })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { POST, GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { revokeHostConsent } from '@/lib/host-consent'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import { checkRateLimit } from '@/lib/rate-limit'

function stubDb({ host = { id: 'h-1', postmark_stream_id: 'colm-events' }, contact = { email: 'pat@x.ie' } } = {}) {
  return {
    from: (table) => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === 'event_hosts' ? host : table === 'contacts' ? contact : null, error: null }),
      }
      return chain
    },
  }
}
const req = () => new Request('http://localhost/api/unsubscribe/host/tok', { method: 'POST' })
const props = { params: Promise.resolve({ token: 'tok' }) }

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true })
  revokeHostConsent.mockResolvedValue({ ok: true, changed: true })
  suppressAtPostmark.mockResolvedValue({ ok: 1, failed: [] })
})

describe('POST /api/unsubscribe/host/[token]', () => {
  it('revokes host consent, pushes the host-stream suppression, answers 200 with no body required', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    createServerClient.mockReturnValue(stubDb())
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(revokeHostConsent).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', source: 'host_one_click_unsubscribe', ipAddress: '5.5.5.5' })
    expect(suppressAtPostmark).toHaveBeenCalledWith('pat@x.ie', { stream: 'colm-events' })
    // UNSUB-RL.1 — a VALID token is never rate-limited, only invalid ones
    // spend the per-IP budget.
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
  it('skips the Postmark push when the host has no stream yet', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    createServerClient.mockReturnValue(stubDb({ host: { id: 'h-1', postmark_stream_id: null } }))
    expect((await POST(req(), props)).status).toBe(200)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })
  it('404s an invalid token without touching the database', async () => {
    verifyHostUnsubToken.mockReturnValue(null)
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(404)
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('429s when the per-IP invalid-token budget is spent', async () => {
    verifyHostUnsubToken.mockReturnValue(null)
    checkRateLimit.mockResolvedValue({ allowed: false })
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(429)
  })
  it('a repeat click is a 200 no-op', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    revokeHostConsent.mockResolvedValueOnce({ ok: true, changed: false })
    createServerClient.mockReturnValue(stubDb())
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.changed).toBe(false)
  })
  it('404s when the host cannot be found', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    createServerClient.mockReturnValue(stubDb({ host: null }))
    expect((await POST(req(), props)).status).toBe(404)
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('a failed write is a 500, never a false success', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    revokeHostConsent.mockResolvedValueOnce({ ok: false, changed: false, error: 'boom' })
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(500)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })
})

describe('GET /api/unsubscribe/host/[token]', () => {
  it('redirects a browser GET to the landing page, which does the same write', async () => {
    const res = await GET(new Request('http://localhost/api/unsubscribe/host/tok'), props)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toMatch(/\/unsubscribe\/host\/tok$/)
  })
})
