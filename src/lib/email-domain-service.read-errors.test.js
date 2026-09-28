// CHANNELREAD.1 — loadEmailDomainRow discarded its read error and returned
// null ("no domain"). provisionEmailDomain reads through it: on a blip it
// minted a SECOND Postmark server and overwrote the stored server id + token
// (upsert on the org PK). All ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getOwnerOrganizationIds: () => [] }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/postmark-account', () => ({
  createTenantServer: vi.fn(),
  createTenantDomain: vi.fn(),
  getTenantDomain: vi.fn(),
  verifyTenantDomainDkim: vi.fn(),
  verifyTenantReturnPath: vi.fn(),
  domainIsFullyVerified: vi.fn(() => false),
}))

import { loadEmailDomainRow, provisionEmailDomain, verifyEmailDomain } from './email-domain-service.js'
import { createTenantServer, verifyTenantDomainDkim } from '@/lib/postmark-account'

const failingDb = () => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    upsert: vi.fn(),
  }),
})

beforeEach(() => vi.clearAllMocks())

describe('email-domain-service — a failed read is not "no domain" (CHANNELREAD.1)', () => {
  it('loadEmailDomainRow throws instead of returning null', async () => {
    await expect(loadEmailDomainRow(failingDb(), 'org-a')).rejects.toThrow(/Could not read the email domain/)
  })

  it('provisionEmailDomain creates no Postmark server when the read fails', async () => {
    await expect(provisionEmailDomain(failingDb(), { orgId: 'org-a', orgName: 'Gym A', sendingDomain: 'mail.gyma.example' }))
      .rejects.toThrow(/Could not read the email domain/)
    expect(createTenantServer).not.toHaveBeenCalled()
  })

  it('verifyEmailDomain reports readFailed, never notProvisioned, and calls Postmark for nothing', async () => {
    const res = await verifyEmailDomain(failingDb(), 'org-a')
    expect(res.readFailed).toBe(true)
    expect(res.notProvisioned).toBeUndefined()
    expect(verifyTenantDomainDkim).not.toHaveBeenCalled()
  })
})
