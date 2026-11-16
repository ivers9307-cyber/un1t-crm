// PAYLINK.1 — POST /api/public/buy/[token]: the per-IP rate limit, the body
// (anything odd is no tick), and each answer's HTTP status. The work itself is
// startStaffLinkCheckout (src/lib/staff-payment-link-checkout.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ start: vi.fn(), limit: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ fake: true }) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: m.limit,
  getClientIp: () => '203.0.113.9',
  rateLimitResponse: (r, msg) => new Response(JSON.stringify({ success: false, error: msg }), { status: 429 }),
}))
vi.mock('@/lib/staff-payment-link-checkout', () => ({ startStaffLinkCheckout: m.start }))

import { POST } from './route'

const TOKEN = 'a'.repeat(43)
const req = (body, { raw = false } = {}) => new Request(`https://hatch.example.com/api/public/buy/${TOKEN}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body),
})
const call = (r) => POST(r, { params: Promise.resolve({ token: TOKEN }) })

beforeEach(() => {
  vi.clearAllMocks()
  m.limit.mockResolvedValue({ allowed: true })
  m.start.mockResolvedValue({ kind: 'expired' })
})

describe('POST /api/public/buy/[token]', () => {
  it('rate limited per IP: 429 and no work', async () => {
    m.limit.mockResolvedValue({ allowed: false })
    const res = await call(req({ acceptTerms: true }))
    expect(res.status).toBe(429)
    expect(m.limit).toHaveBeenCalledWith({ fake: true }, 'paylink:203.0.113.9', { max: 10, windowMs: 60_000 })
    expect(m.start).not.toHaveBeenCalled()
  })

  it('passes the tick through', async () => {
    await call(req({ acceptTerms: true }))
    expect(m.start).toHaveBeenCalledWith({ fake: true }, { token: TOKEN, acceptTerms: true })
  })

  it('a non-JSON or odd body is acceptTerms: false', async () => {
    for (const r of [req('not json', { raw: true }), req({ acceptTerms: 'yes' }), req([1, 2]), req(null)]) {
      m.start.mockClear()
      await call(r)
      expect(m.start.mock.calls[0][1].acceptTerms).toBe(false)
    }
  })

  it('maps each kind to its status', async () => {
    const cases = [
      [{ kind: 'redirect', url: 'https://checkout.stripe.com/c/x' }, 200, { kind: 'redirect', url: 'https://checkout.stripe.com/c/x' }],
      [{ kind: 'not_found' }, 404, { kind: 'not_found' }],
      [{ kind: 'unavailable' }, 503, { kind: 'unavailable' }],
      [{ kind: 'paid' }, 200, { kind: 'paid' }],
      [{ kind: 'expired' }, 200, { kind: 'expired' }],
      [{ kind: 'help', reason: 'account_ambiguous' }, 200, { kind: 'help' }],
      [{ kind: 'terms_required' }, 200, { kind: 'terms_required' }],
      [{ kind: 'confirming' }, 200, { kind: 'confirming' }],
    ]
    for (const [out, status, data] of cases) {
      m.start.mockResolvedValueOnce(out)
      const res = await call(req({}))
      expect(res.status, out.kind).toBe(status)
      expect((await res.json()).data, out.kind).toEqual(data)
    }
  })
})
