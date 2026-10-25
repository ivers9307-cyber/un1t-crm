// W1.S1c — the self-serve onboarding payload carries the brand of the
// organisation the host runs events through, for the "<host> × <brand>"
// heading; never a literal gym.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-onboarding-tokens', () => ({ verifyHostOnboardingToken: vi.fn() }))
vi.mock('@/lib/payments/stripe-connect', () => ({ retrieveAccountStatus: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/host-org-brand', () => ({ resolveHostOrgBrand: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyHostOnboardingToken } from '@/lib/host-onboarding-tokens'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'

const HOST = {
  id: 'h1',
  name: 'Pride Training Club',
  organization_id: 'org-1',
  payment_provider: 'stripe_connect',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  stripe_connected_account_id: 'acct_1',
  onboarding_completed_at: '2026-09-01T00:00:00Z',
}

function makeDb(host) {
  const selects = []
  const b = new Proxy({}, {
    get(_, method) {
      if (method === 'then') { const p = Promise.resolve({ data: host, error: null }); return p.then.bind(p) }
      return (...args) => { if (method === 'select') selects.push(args[0]); return b }
    },
  })
  return { db: { from: () => b }, selects }
}

const call = () => GET(new Request('http://x/api/public/host-connect/tok'), { params: Promise.resolve({ token: 'tok' }) })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
  verifyHostOnboardingToken.mockReturnValue({ hostId: 'h1' })
})

describe('GET /api/public/host-connect/[token]', () => {
  it("returns the host's organisation brand and short name", async () => {
    const { db, selects } = makeDb(HOST)
    createServerClient.mockReturnValue(db)
    resolveHostOrgBrand.mockResolvedValue({ name: 'UN1T Dublin', shortName: 'UN1T' })
    const json = await (await call()).json()
    expect(json.data).toMatchObject({ name: 'Pride Training Club', brand: 'UN1T Dublin', brand_short: 'UN1T' })
    expect(selects[0]).toContain('organization_id')
    expect(resolveHostOrgBrand).toHaveBeenCalledWith(db, HOST)
  })

  it('an invalid token answers 400 without reading anything', async () => {
    verifyHostOnboardingToken.mockReturnValue(null)
    const res = await call()
    expect(res.status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
