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

const ownerA = {
  id: 'owner-a',
  role: 'owner',
  activeOrganization: { id: 'org-a', name: 'Gym A' },
  organizationsById: { 'org-a': { id: 'org-a', name: 'Gym A' } },
  rolesByLocation: { 'loc-a1': 'owner' },
  orgAdminOrgIds: [],
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
