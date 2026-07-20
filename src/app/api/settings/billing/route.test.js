// INTEG-D1 — access matrix for GET /api/settings/billing.
// The billing page is owner+master ONLY, org-scoped to orgs the
// caller OWNS, with 404-not-403 on cross-org probes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/billing-page', () => ({ getBillingPageData: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { getBillingPageData } from '@/lib/billing-page'

beforeEach(() => {
  vi.clearAllMocks()
  getBillingPageData.mockResolvedValue({
    organization_id: 'org-a',
    month_start: '2026-07-01',
    pinned: false,
    locations: [],
    billing_contact: null,
    billing_contact_supported: false,
  })
})

function req(query = '') {
  return new Request(`http://x/api/settings/billing${query}`)
}

// Owner of org A: owner role at loc-a1, whose location row carries
// organization_id org-a (getOwnerOrganizationIds reads exactly this).
const ownerA = {
  id: 'owner-a',
  role: 'owner',
  activeOrganization: { id: 'org-a' },
  rolesByLocation: { 'loc-a1': 'owner' },
  locations: [{ id: 'loc-a1', organization_id: 'org-a' }],
}

const master = {
  id: 'root',
  role: 'master',
  activeOrganization: { id: 'org-a' },
  rolesByLocation: {},
  locations: [],
}

describe('GET /api/settings/billing — access matrix', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('403 for staff', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerA, role: 'staff' })
    expect((await GET(req())).status).toBe(403)
    expect(getBillingPageData).not.toHaveBeenCalled()
  })

  it('403 for manager (billing is owner+master, not ADMIN_ROLES)', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerA, role: 'manager' })
    expect((await GET(req())).status).toBe(403)
  })

  it('200 for an owner reading their own org (default = active org)', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(getBillingPageData).toHaveBeenCalledWith(expect.anything(), 'org-a')
    const json = await res.json()
    expect(json.success).toBe(true)
  })

  it('404 (NOT 403) when an owner of org A probes org B', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const res = await GET(req('?organization_id=00000000-0000-0000-0000-00000000000b'))
    expect(res.status).toBe(404)
    expect(getBillingPageData).not.toHaveBeenCalled()
    // indistinguishable from a nonexistent org
    const json = await res.json()
    expect(json.error).toBe('Not found')
  })

  it('master can target any org via ?organization_id', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await GET(req('?organization_id=00000000-0000-0000-0000-00000000000b'))
    expect(res.status).toBe(200)
    expect(getBillingPageData).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-00000000000b'
    )
  })

  it('master with no param reads the active org', async () => {
    getCurrentUser.mockResolvedValue(master)
    expect((await GET(req())).status).toBe(200)
    expect(getBillingPageData).toHaveBeenCalledWith(expect.anything(), 'org-a')
  })

  it('SAAS-4 org admin (no owner location role) reads their admin org', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'org-admin',
      role: 'owner', // org admins surface as synthetic owners at org locations
      activeOrganization: { id: 'org-a' },
      rolesByLocation: {},
      locations: [],
      orgAdminOrgIds: ['org-a'],
    })
    expect((await GET(req())).status).toBe(200)
    expect(getBillingPageData).toHaveBeenCalledWith(expect.anything(), 'org-a')
  })
})
