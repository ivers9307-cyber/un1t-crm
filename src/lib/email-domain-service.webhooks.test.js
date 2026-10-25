// W1.E3 — a tenant Postmark server is born with its streams and webhooks.
//
// provisionEmailDomain used to persist the server token and move straight on
// to the domain: the server had only outbound+inbound streams and no webhooks,
// so a tenant campaign (MessageStream 'broadcast') would be refused and no
// bounce/open/spam/subscription event ever reached /api/webhooks/postmark.
// Now, after the server token is persisted, the two idempotent helpers run
// with the SERVER token and webhooks_registered_at is stamped. A failure there
// is recorded as last_error, leaves the stamp NULL (so the next provision or
// verify call retries) and does NOT block the domain. All ids are synthetic.

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

import { provisionEmailDomain, verifyEmailDomain } from './email-domain-service.js'
import {
  createTenantServer,
  createTenantDomain,
  getTenantDomain,
  ensureTenantServerStreams,
  ensureTenantServerWebhooks,
} from '@/lib/postmark-account'
import { logWarn } from '@/lib/log'

// Stateful fake of the one table: the stored row (or null), every upsert
// patch merged in order and recorded.
function fakeDb(initialRow) {
  const state = { row: initialRow ? { ...initialRow } : null, patches: [] }
  const db = {
    state,
    from: (table) => {
      expect(table).toBe('tenant_email_domains')
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }) }),
        upsert: (patch) => {
          state.patches.push(patch)
          state.row = { ...(state.row || {}), ...patch }
          return { select: () => ({ single: async () => ({ data: state.row, error: null }) }) }
        },
      }
    },
  }
  return db
}

const SHAPED = {
  id: 55, dkimPendingHost: 'pm._domainkey.mail.gyma.example', dkimPendingValue: 'k=rsa;x',
  dkimVerified: false, returnPathDomain: 'pm-bounces.mail.gyma.example', returnPathCnameValue: 'pm.mtasv.net',
  returnPathVerified: false,
}
const ARGS = { orgId: 'org-a', orgName: 'Gym A', sendingDomain: 'mail.gyma.example', createdBy: 'u-1' }

beforeEach(() => {
  vi.clearAllMocks()
  createTenantServer.mockResolvedValue({ id: 101, serverToken: 'srv-tok' })
  createTenantDomain.mockResolvedValue(SHAPED)
  getTenantDomain.mockResolvedValue(SHAPED)
  ensureTenantServerStreams.mockResolvedValue({ created: true })
  ensureTenantServerWebhooks.mockResolvedValue({ created: ['outbound', 'broadcast'] })
})

describe('provisionEmailDomain — streams + webhooks on a fresh server (W1.E3)', () => {
  it('after the server token is persisted it registers streams + webhooks with the SERVER token and stamps webhooks_registered_at', async () => {
    const db = fakeDb(null)
    const row = await provisionEmailDomain(db, ARGS)

    // Order: the token is persisted BEFORE any server-token call, so a crash
    // between the two never loses the server.
    const tokenPatchIdx = db.state.patches.findIndex((p) => p.postmark_server_token === 'srv-tok')
    expect(tokenPatchIdx).toBe(0)
    expect(ensureTenantServerStreams).toHaveBeenCalledWith('srv-tok')
    expect(ensureTenantServerWebhooks).toHaveBeenCalledWith('srv-tok')
    expect(ensureTenantServerStreams.mock.invocationCallOrder[0]).toBeLessThan(ensureTenantServerWebhooks.mock.invocationCallOrder[0])

    const stamp = db.state.patches.find((p) => 'webhooks_registered_at' in p)
    expect(stamp.webhooks_registered_at).toEqual(expect.any(String))
    expect(row.webhooks_registered_at).toEqual(expect.any(String))
    expect(row.status).toBe('verifying')
    expect(row.last_error).toBeNull()
    expect(createTenantDomain).toHaveBeenCalledWith('mail.gyma.example')
  })

  it('a webhook failure records last_error, leaves the stamp NULL and still creates the domain', async () => {
    ensureTenantServerWebhooks.mockRejectedValue(new Error('Postmark server API error: Webhook limit reached.'))
    const db = fakeDb(null)
    const row = await provisionEmailDomain(db, ARGS)

    expect(createTenantDomain).toHaveBeenCalledTimes(1)
    expect(row.postmark_domain_id).toBe(55)
    expect(row.status).toBe('verifying')
    expect(row.webhooks_registered_at ?? null).toBeNull()
    // Tenant-facing: says what did not happen and what to press, with the
    // cause in brackets; the raw message goes to the log.
    expect(row.last_error).toBe('Event webhooks were not registered on the sending server (Postmark server API error: Webhook limit reached.). Press Verify to retry.')
    expect(logWarn).toHaveBeenCalledWith('tenant-email-domain', expect.stringMatching(/webhook/i), expect.objectContaining({ orgId: 'org-a', err: 'Postmark server API error: Webhook limit reached.' }))
    // The message never carries the server token.
    expect(JSON.stringify(db.state.patches.map((p) => p.last_error))).not.toContain('srv-tok')
  })

  it('a stream failure is handled the same way and the webhooks are not attempted on that pass', async () => {
    ensureTenantServerStreams.mockRejectedValue(new Error('Postmark server API error: HTTP 500'))
    const db = fakeDb(null)
    const row = await provisionEmailDomain(db, ARGS)
    expect(ensureTenantServerWebhooks).not.toHaveBeenCalled()
    expect(row.webhooks_registered_at ?? null).toBeNull()
    expect(row.last_error).toMatch(/^Event webhooks were not registered on the sending server \(.*HTTP 500.*\)\. Press Verify to retry\.$/)
    expect(row.postmark_domain_id).toBe(55)
  })

  it('a later provision call on a row with a NULL stamp retries (idempotent) and stamps on success', async () => {
    const db = fakeDb({
      organization_id: 'org-a', postmark_server_id: 101, postmark_server_token: 'srv-tok',
      postmark_domain_id: 55, status: 'verifying', webhooks_registered_at: null, last_error: 'earlier failure',
    })
    const row = await provisionEmailDomain(db, ARGS)
    expect(createTenantServer).not.toHaveBeenCalled()
    expect(createTenantDomain).not.toHaveBeenCalled()
    expect(ensureTenantServerStreams).toHaveBeenCalledWith('srv-tok')
    expect(ensureTenantServerWebhooks).toHaveBeenCalledWith('srv-tok')
    expect(row.webhooks_registered_at).toEqual(expect.any(String))
    expect(row.last_error).toBeNull()
  })

  it('a stamped row is never re-registered', async () => {
    const db = fakeDb({
      organization_id: 'org-a', postmark_server_id: 101, postmark_server_token: 'srv-tok',
      postmark_domain_id: 55, status: 'verifying', webhooks_registered_at: '2026-10-10T10:00:00.000Z',
    })
    await provisionEmailDomain(db, ARGS)
    expect(ensureTenantServerStreams).not.toHaveBeenCalled()
    expect(ensureTenantServerWebhooks).not.toHaveBeenCalled()
  })
})

describe('verifyEmailDomain — the verify button is the retry an operator can reach (W1.E3)', () => {
  it('retries registration on a NULL stamp before re-checking DNS, and stamps on success', async () => {
    const db = fakeDb({
      organization_id: 'org-a', postmark_server_id: 101, postmark_server_token: 'srv-tok',
      postmark_domain_id: 55, status: 'verifying', webhooks_registered_at: null,
    })
    const res = await verifyEmailDomain(db, 'org-a')
    expect(res.row.webhooks_registered_at).toEqual(expect.any(String))
    expect(ensureTenantServerWebhooks).toHaveBeenCalledWith('srv-tok')
  })

  it('a registration failure during verify keeps the verify result and surfaces last_error', async () => {
    ensureTenantServerWebhooks.mockRejectedValue(new Error('Postmark server API error: HTTP 503'))
    const db = fakeDb({
      organization_id: 'org-a', postmark_server_id: 101, postmark_server_token: 'srv-tok',
      postmark_domain_id: 55, status: 'verifying', webhooks_registered_at: null,
    })
    const res = await verifyEmailDomain(db, 'org-a')
    expect(res.row).toBeTruthy()
    expect(res.row.webhooks_registered_at ?? null).toBeNull()
    expect(res.row.last_error).toMatch(/^Event webhooks were not registered.*HTTP 503.*Press Verify to retry\.$/)
  })

  it('does nothing extra once stamped', async () => {
    const db = fakeDb({
      organization_id: 'org-a', postmark_server_id: 101, postmark_server_token: 'srv-tok',
      postmark_domain_id: 55, status: 'verifying', webhooks_registered_at: '2026-10-10T10:00:00.000Z',
    })
    await verifyEmailDomain(db, 'org-a')
    expect(ensureTenantServerStreams).not.toHaveBeenCalled()
  })
})
