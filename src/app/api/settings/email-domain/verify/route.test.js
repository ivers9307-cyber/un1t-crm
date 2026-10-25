// CHANNELREAD.1 — POST /api/settings/email-domain/verify when OUR read of the
// stored domain fails: a 500 that says nothing was checked, never the 409
// "No sending domain provisioned yet" (which would point the operator at
// set-up over a provisioned domain), and no Postmark call. The service is
// REAL (only its I/O is mocked), so this pins the whole read-failure path.
// All ids are synthetic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/tenant-email', () => ({
  orgHasEmailDomainAddon: vi.fn(async () => true),
  tenantEmailStatePayload: vi.fn((row) => ({ status: row?.status || 'not_configured' })),
}))
vi.mock('@/lib/postmark-account', () => ({
  isPostmarkAccountConfigured: () => true,
  createTenantServer: vi.fn(),
  createTenantDomain: vi.fn(),
  getTenantDomain: vi.fn(),
  verifyTenantDomainDkim: vi.fn(),
  verifyTenantReturnPath: vi.fn(),
  domainIsFullyVerified: vi.fn(() => false),
}))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { verifyTenantDomainDkim, getTenantDomain } from '@/lib/postmark-account'

const ownerA = {
  id: 'owner-a',
  role: 'owner',
  activeOrganization: { id: 'org-a', name: 'Synthetic Gym A' },
  organizationsById: { 'org-a': { id: 'org-a', name: 'Synthetic Gym A' } },
  rolesByLocation: { 'loc-a1': 'owner' },
  orgAdminOrgIds: ['org-a'], // C18 ORGROLE.1: an org admin of org A
  locations: [{ id: 'loc-a1', organization_id: 'org-a' }],
}
const PG = 'canceling statement due to statement timeout'
const req = () => new Request('http://x/api/settings/email-domain/verify', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
})
const dbReading = (answer) => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(answer) }) }),
    upsert: vi.fn(() => Promise.resolve({ error: null })),
  }),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ownerA)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/settings/email-domain/verify — a failed read (CHANNELREAD.1)', () => {
  it('500s with "nothing was checked", never 409 not-provisioned, and calls Postmark for nothing', async () => {
    createServerClient.mockReturnValue(dbReading({ data: null, error: { message: PG } }))
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe('Could not read the sending domain just now, so nothing was checked. Try again.')
    expect(body.error).not.toContain(PG)
    expect(verifyTenantDomainDkim).not.toHaveBeenCalled()
    expect(getTenantDomain).not.toHaveBeenCalled()
  })

  it('pin: a real "no row" is still the 409', async () => {
    createServerClient.mockReturnValue(dbReading({ data: null, error: null }))
    const res = await POST(req())
    expect(res.status).toBe(409)
  })
})
