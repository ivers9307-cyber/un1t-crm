// HATCHTRACK.1 — POST /api/public/trial-purchases/[id]/checkout: a Hatch
// Street buyer goes back to payment for the purchase they already started.
// The purchase id is the capability; the answer is a checkout URL or a state,
// never anything about the buyer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), resume: vi.fn(), slugs: vi.fn(), org: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rateLimit, getClientIp: () => '1.2.3.4', rateLimitResponse: () => new Response('rate', { status: 429 }) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ marker: 'db' }) }))
vi.mock('@/lib/trial-purchase-un1t-resume', () => ({ resumeUn1tTrialCheckout: mocks.resume }))
vi.mock('@/lib/landing-pages', () => ({ listStudioPageSlugs: mocks.slugs, publicOrgIdForHost: mocks.org }))

import { POST } from './route'

const ID = '11111111-1111-4111-8111-111111111111'
const call = (id, body, raw) => POST(
  new Request(`http://x/api/public/trial-purchases/${id}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', host: 'www.un1tdublin.com' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
  { params: Promise.resolve({ id }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rateLimit.mockResolvedValue({ allowed: true })
  mocks.slugs.mockResolvedValue(['stillorgan', 'hatch-street'])
  mocks.org.mockResolvedValue('org-1')
  mocks.resume.mockResolvedValue({ kind: 'redirect', checkoutUrl: 'https://checkout.stripe.com/c/pay/x', reused: true, attempt: 1 })
})

describe('POST /api/public/trial-purchases/[id]/checkout', () => {
  it('answers the checkout to go to, for the id in the path and nothing else', async () => {
    const r = await call(ID, { return_path: '/hatch-street' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { purchaseId: ID, redirect_url: 'https://checkout.stripe.com/c/pay/x', reused: true } })
    expect(mocks.resume).toHaveBeenCalledWith({ marker: 'db' }, { purchaseId: ID, returnPath: '/hatch-street' })
  })

  it('a malformed id is 404 before the database, the limiter or un1t.online is touched', async () => {
    for (const id of ['abc', "x' or 1=1", '11111111-1111-4111-8111-11111111111', `${ID}0`]) {
      expect((await call(id, {})).status).toBe(404)
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it('is limited per purchase and per IP, before anything is resumed', async () => {
    await call(ID, {})
    expect(mocks.rateLimit.mock.calls.map((c) => c[1])).toEqual([`tpresume:${ID}`, 'tpresume-ip:1.2.3.4'])
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false })
    expect((await call(ID, {})).status).toBe(429)
    mocks.rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false })
    expect((await call(ID, {})).status).toBe(429)
    expect(mocks.resume).toHaveBeenCalledTimes(1)
  })

  it('the return path is allowlisted: an unknown or off-site one becomes /trial; no body at all is /trial', async () => {
    for (const [body, raw, expected] of [
      [{ return_path: '/dundrum' }, undefined, '/trial'],
      [{ return_path: 'https://evil.example/x' }, undefined, '/trial'],
      [{ return_path: '//evil.example' }, undefined, '/trial'],
      [{ return_path: '/stillorgan' }, undefined, '/stillorgan'],
      [undefined, undefined, '/trial'],
      [undefined, 'not json', '/trial'],
      [{ return_path: 42 }, undefined, '/trial'],
    ]) {
      mocks.resume.mockClear()
      await call(ID, body, raw)
      expect(mocks.resume.mock.calls[0][1].returnPath).toBe(expected)
    }
  })

  it('the studio slugs are read only when a studio page is named', async () => {
    await call(ID, { return_path: '/trial' })
    await call(ID, {})
    expect(mocks.slugs).not.toHaveBeenCalled()
    await call(ID, { return_path: '/hatch-street' })
    expect(mocks.slugs).toHaveBeenCalledTimes(1)
  })

  it('an unknown purchase is 404; a row that cannot be resumed is a 200 state the page shows', async () => {
    mocks.resume.mockResolvedValueOnce({ kind: 'not_found' })
    expect((await call(ID, {})).status).toBe(404)
    for (const state of ['granted', 'expired', 'help', 'pending', 'refused']) {
      mocks.resume.mockResolvedValueOnce({ kind: 'not_resumable', state })
      const r = await call(ID, {})
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ success: false, code: 'not_resumable', state })
    }
  })

  it('un1t.online busy or unreadable is 503 with words for the buyer and no internal code', async () => {
    mocks.resume.mockResolvedValueOnce({ kind: 'unavailable', code: 'UN1T_BUDGET' })
    const r = await call(ID, {})
    expect(r.status).toBe(503)
    const body = await r.json()
    expect(body).toEqual({ success: false, code: 'unavailable', error: 'We could not open the payment page just now. Please try again in a moment.' })
    expect(JSON.stringify(body)).not.toContain('UN1T_BUDGET')
  })

  it('no answer carries anything but the id, the URL and the state', async () => {
    mocks.resume.mockResolvedValueOnce({ kind: 'redirect', checkoutUrl: 'https://checkout.stripe.com/c/pay/x', reused: false, attempt: 3, row: { customer_email: 'sam@example.com', attribution: { client_ip: '203.0.113.9' } } })
    const text = JSON.stringify(await (await call(ID, {})).json())
    expect(text).not.toContain('sam@example.com')
    expect(text).not.toContain('203.0.113.9')
    expect(Object.keys(JSON.parse(text).data).sort()).toEqual(['purchaseId', 'redirect_url', 'reused'])
  })
})
