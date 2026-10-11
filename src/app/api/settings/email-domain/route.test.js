// INTEG-B3 — access matrix + secret-redaction for the tenant email-domain
// routes. Owner-of-org / master only; cross-org 404; add-on gate on POST;
// 503 when the account token is unset; the server token is NEVER returned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ __service: true })) }))
vi.mock('@/lib/tenant-email', () => ({
  orgHasEmailDomainAddon: vi.fn(),
  tenantEmailStatePayload: vi.fn((row, meta) => ({ status: row ? row.status : 'not_configured', addon_active: !!meta.addonActive })),
}))
vi.mock('@/lib/email-domain-service', async () => {
  const actual = await vi.importActual('@/lib/email-domain-service')
  return { ...actual, loadEmailDomainRow: vi.fn(), provisionEmailDomain: vi.fn() }
})

import { GET, POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { orgHasEmailDomainAddon } from '@/lib/tenant-email'
import { loadEmailDomainRow, provisionEmailDomain } from '@/lib/email-domain-service'
import { createServerClient } from '@/lib/supabase'

const ownerA = {
  id: 'owner-a',
  role: 'owner',
  activeOrganization: { id: 'org-a', name: 'Gym A' },
  organizationsById: { 'org-a': { id: 'org-a', name: 'Gym A' } },
  rolesByLocation: { 'loc-a1': 'owner' },
  orgAdminOrgIds: ['org-a'], // C18 ORGROLE.1: an org admin of org A
  locations: [{ id: 'loc-a1', organization_id: 'org-a' }],
}
const master = {
  id: 'root', role: 'master',
  activeOrganization: { id: 'org-a', name: 'Gym A' },
  organizationsById: { 'org-a': { id: 'org-a', name: 'Gym A' } },
  rolesByLocation: {}, orgAdminOrgIds: [], locations: [],
}
const staff = { id: 's', role: 'staff', activeOrganization: { id: 'org-a' }, rolesByLocation: { 'loc-a1': 'staff' }, orgAdminOrgIds: [], locations: [{ id: 'loc-a1', organization_id: 'org-a' }] }

function getReq(query = '') { return new Request(`http://x/api/settings/email-domain${query}`) }
function postReq(body) {
  return new Request('http://x/api/settings/email-domain', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POSTMARK_ACCOUNT_TOKEN = 'acct-tok'
  loadEmailDomainRow.mockResolvedValue(null)
  orgHasEmailDomainAddon.mockResolvedValue(true)
})
afterEach(() => { delete process.env.POSTMARK_ACCOUNT_TOKEN })

describe('GET /api/settings/email-domain', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq())).status).toBe(401)
  })

  it('403 for staff', async () => {
    getCurrentUser.mockResolvedValue(staff)
    expect((await GET(getReq())).status).toBe(403)
  })

  it('403 for a studio owner with no org_admin grant (C18 ORGROLE.1)', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerA, orgAdminOrgIds: [] })
    expect((await GET(getReq())).status).toBe(403)
  })

  it('503 when the account token is unset', async () => {
    delete process.env.POSTMARK_ACCOUNT_TOKEN
    getCurrentUser.mockResolvedValue(ownerA)
    expect((await GET(getReq())).status).toBe(503)
  })

  it('owner gets their org status (200)', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(loadEmailDomainRow).toHaveBeenCalledWith(expect.anything(), 'org-a')
  })

  it('owner probing a FOREIGN org id → 404 (not 403)', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    expect((await GET(getReq('?organization_id=org-b'))).status).toBe(404)
  })

  it('master can target any org', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await GET(getReq('?organization_id=org-z'))
    expect(res.status).toBe(200)
    expect(loadEmailDomainRow).toHaveBeenCalledWith(expect.anything(), 'org-z')
  })
})

describe('POST /api/settings/email-domain', () => {
  it('403 add-on required when the org lacks the add-on', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    orgHasEmailDomainAddon.mockResolvedValue(false)
    const res = await POST(postReq({ domain: 'mail.gyma.com' }))
    expect(res.status).toBe(403)
    expect(provisionEmailDomain).not.toHaveBeenCalled()
  })

  it('400 on an invalid domain', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await POST(postReq({ domain: 'nodots' }))
    expect(res.status).toBe(400)
  })

  it('provisions and NEVER returns the server token', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    provisionEmailDomain.mockResolvedValue({
      organization_id: 'org-a', status: 'verifying',
      postmark_server_token: 'srv-SECRET', sending_domain: 'mail.gyma.com',
    })
    const res = await POST(postReq({ domain: 'mail.gyma.com' }))
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('srv-SECRET')
    expect(provisionEmailDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: 'org-a', sendingDomain: 'mail.gyma.com' }))
  })
})

// ADOPTDOMAIN.1 — only a platform master may adopt a domain the platform's
// Postmark account already holds; the route says which caller this is, from
// the PROFILE role, and answers the operator-neutral refusal as a 409.
describe('POST /api/settings/email-domain — adopting an existing account domain (ADOPTDOMAIN.1)', () => {
  it('passes isMaster: true for a platform master', async () => {
    getCurrentUser.mockResolvedValue({ ...master, isMaster: true, profileRole: 'master' })
    provisionEmailDomain.mockResolvedValue({ organization_id: 'org-a', status: 'live' })
    const res = await POST(postReq({ domain: 'gyma.com', from_local: 'Sales' }))
    expect(res.status).toBe(200)
    expect(provisionEmailDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isMaster: true, fromLocal: 'sales' }))
  })

  it('passes isMaster: false for an org admin who is not a master', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerA, profileRole: 'owner' })
    provisionEmailDomain.mockResolvedValue({ organization_id: 'org-a', status: 'verifying' })
    await POST(postReq({ domain: 'gyma.com' }))
    expect(provisionEmailDomain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isMaster: false }))
  })

  it('answers the refusal as a 409 with the operator-neutral message, and stamps last_error', async () => {
    const actual = await vi.importActual('@/lib/email-domain-service')
    const taken = new Error(actual.emailDomainTakenMessage('gyma.com'))
    taken.code = actual.EMAIL_DOMAIN_TAKEN_CODE
    provisionEmailDomain.mockRejectedValue(taken)
    const updates = []
    createServerClient.mockReturnValue({
      from: () => ({ update: (patch) => { updates.push(patch); return { eq: () => Promise.resolve({ error: null }) } } }),
    })
    getCurrentUser.mockResolvedValue({ ...ownerA, profileRole: 'owner' })
    const res = await POST(postReq({ domain: 'gyma.com' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('This domain is already registered on the platform. Use a subdomain such as mail.gyma.com, or contact support.')
    expect(updates[0].last_error).toBe(body.error)
  })

  it('any other provisioning failure is still a 502', async () => {
    provisionEmailDomain.mockRejectedValue(new Error('Postmark account API error: Invalid domain name.'))
    createServerClient.mockReturnValue({
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    })
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await POST(postReq({ domain: 'gyma.com' }))
    expect(res.status).toBe(502)
  })
})

describe('GET /api/settings/email-domain — a failed read (CHANNELREAD.1)', () => {
  it('500s instead of answering "not configured"', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    loadEmailDomainRow.mockRejectedValue(new Error('Could not read the email domain: boom'))
    const res = await GET(getReq())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })
})

// CHANNELREAD.1 — the provision path reads through loadEmailDomainRow. When
// that read fails, the POST catch stores the error as last_error (the status
// endpoint shows it) and answers it in its 502, so it must be plain copy,
// never "Could not read the email domain: <postgres message>".
describe('POST /api/settings/email-domain — a failed read during provision (CHANNELREAD.1)', () => {
  it('stores and answers a plain message, never the Postgres text', async () => {
    const PG = 'canceling statement due to statement timeout'
    const actual = await vi.importActual('@/lib/email-domain-service')
    const readDb = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: PG } }) }) }) }),
    }
    const readErr = await actual.loadEmailDomainRow(readDb, 'org-a').catch((e) => e)
    provisionEmailDomain.mockRejectedValue(readErr)
    const updates = []
    createServerClient.mockReturnValue({
      from: () => ({ update: (patch) => { updates.push(patch); return { eq: () => Promise.resolve({ error: null }) } } }),
    })
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await POST(postReq({ domain: 'mail.gyma.com' }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('Could not read the email domain just now, so nothing was changed. Try again.')
    expect(body.error).not.toContain(PG)
    expect(updates).toHaveLength(1)
    expect(updates[0].last_error).toBe('Could not read the email domain just now, so nothing was changed. Try again.')
  })
})
