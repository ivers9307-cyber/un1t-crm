// GET /api/cron/stripe-connect-apple-pay-domains — HOSTAPPLEPAY.1.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/payments/apple-pay-domains', () => ({
  listCheckoutDomains: vi.fn(),
  listConnectedAccounts: vi.fn(),
  ensureAccountDomains: vi.fn(),
}))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { listCheckoutDomains, listConnectedAccounts, ensureAccountDomains } = await import('@/lib/payments/apple-pay-domains')

const env = { ...process.env }
const req = (auth = 'Bearer s3cret') => new Request('http://localhost/api/cron/stripe-connect-apple-pay-domains', {
  headers: auth ? { authorization: auth } : {},
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 's3cret'
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  listCheckoutDomains.mockResolvedValue({ domains: ['un1tdublin.com', 'crm.repset.ie'], tenantReadFailed: false })
  listConnectedAccounts.mockResolvedValue([{ accountId: 'acct_h', kind: 'host', id: 'h1' }])
  ensureAccountDomains.mockResolvedValue({
    ok: true,
    results: [
      { domain: 'un1tdublin.com', action: 'created', applePay: 'active' },
      { domain: 'crm.repset.ie', action: 'exists', applePay: 'active' },
    ],
  })
})
afterEach(() => { process.env = { ...env } })

describe('GET /api/cron/stripe-connect-apple-pay-domains', () => {
  it('401s without the cron secret and does nothing', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
    expect(listConnectedAccounts).not.toHaveBeenCalled()
  })

  it('registers every domain on every connected account and stamps', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(ensureAccountDomains).toHaveBeenCalledWith('acct_h', ['un1tdublin.com', 'crm.repset.ie'])
    const body = await res.json()
    expect(body.data).toEqual(expect.objectContaining({ accounts: 1, domains: 2, created: 1, failed_accounts: 0, apple_pay_inactive: 0 }))
    expect(stampHeartbeat).toHaveBeenCalledWith('stripe-connect-apple-pay-domains', expect.objectContaining({ created: 1 }))
  })

  it('an Apple Pay status Stripe left inactive is reported but still stamps', async () => {
    ensureAccountDomains.mockResolvedValue({ ok: true, results: [{ domain: 'un1tdublin.com', action: 'revalidated', applePay: 'inactive' }] })
    const body = await (await GET(req())).json()
    expect(body.data.inactive).toEqual([{ account: 'acct_h', domain: 'un1tdublin.com' }])
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a failed account is logged, the rest still run, and the run does not stamp', async () => {
    listConnectedAccounts.mockResolvedValue([
      { accountId: 'acct_1', kind: 'host', id: 'h1' },
      { accountId: 'acct_2', kind: 'location', id: 'l1' },
    ])
    ensureAccountDomains
      .mockResolvedValueOnce({ ok: false, error: 'down', results: [] })
      .mockResolvedValueOnce({ ok: true, results: [] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(ensureAccountDomains).toHaveBeenCalledTimes(2)
    expect((await res.json()).data.failed_accounts).toBe(1)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed tenant domain read does not stamp', async () => {
    listCheckoutDomains.mockResolvedValue({ domains: ['crm.repset.ie'], tenantReadFailed: true })
    await GET(req())
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed accounts read is a 500 with no stamp', async () => {
    listConnectedAccounts.mockRejectedValue(new Error('db down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a deployment without Stripe skips and stamps', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(listConnectedAccounts).not.toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('stripe-connect-apple-pay-domains', { skipped: 'stripe_not_configured' })
  })
})
