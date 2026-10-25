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
  ensureTenantServerStreams: vi.fn(),
  ensureTenantServerWebhooks: vi.fn(),
}))

import { loadEmailDomainRow, provisionEmailDomain, verifyEmailDomain } from './email-domain-service.js'
import { createTenantServer, verifyTenantDomainDkim } from '@/lib/postmark-account'
import { logError } from '@/lib/log'

const PG = 'canceling statement due to statement timeout'
const PLAIN = 'Could not read the email domain just now, so nothing was changed. Try again.'
const failingDb = () => ({
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: PG } }) }) }),
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

  // The thrown message reaches operators: the POST route stores it as
  // last_error (shown by the status endpoint) and answers it in its 502.
  // It must be plain copy; the Postgres text goes to the structured log.
  it('the thrown message is plain copy, with the raw Postgres text only in the log', async () => {
    const err = await loadEmailDomainRow(failingDb(), 'org-a').catch((e) => e)
    expect(err.message).toBe(PLAIN)
    expect(err.message).not.toContain(PG)
    expect(logError).toHaveBeenCalledWith('tenant-email-domain', expect.any(String), expect.objectContaining({ orgId: 'org-a', err: PG }))
  })
})
