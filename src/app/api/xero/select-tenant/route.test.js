// SECFIX.1 — GET and POST /api/xero/select-tenant judge OWNER at the location
// acted on (query / body `location_id`).
//
// The defect: `permitted()` read `user.role`, the ACTIVE studio's role, then
// the route checked only membership. An owner at A who is staff at B could,
// with A active, POST { location_id: B } to switch B's Xero organisation, which
// purges B's xero_accounts / xero_contacts / xero_tax_rates mirrors and
// re-primes them from another company's books (one location = one Xero org).
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, the role
// helpers are REAL. All ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn(), listConnectedTenants: vi.fn() }))
vi.mock('@/lib/xero/accounts-sync', () => ({ pullAccounts: vi.fn() }))
vi.mock('@/lib/xero/tax-rates-sync', () => ({ pullTaxRates: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { withFreshToken, listConnectedTenants } from '@/lib/xero/client'
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'
import { LOC_B, person, ownerAtTargetCases, recordingDb } from '../../../../../tests/helpers/owner-at-location-callers.js'

const TENANTS = [
  { tenantId: 'tenant-1', tenantName: 'Synthetic One Ltd', tenantType: 'ORGANISATION' },
  { tenantId: 'tenant-2', tenantName: 'Synthetic Two Ltd', tenantType: 'ORGANISATION' },
]

let rec
beforeEach(() => {
  vi.clearAllMocks()
  rec = recordingDb({
    xero_connections: { single: { tenant_id: 'tenant-1' }, list: [{ tenant_id: 'tenant-1', location_id: LOC_B, locations: { name: 'Synthetic B' } }] },
  })
  createServerClient.mockReturnValue(rec.db)
  withFreshToken.mockResolvedValue({ conn: { access_token: 'at' } })
  listConnectedTenants.mockResolvedValue(TENANTS)
})

const list = (locationId) => GET(new Request(`http://localhost/api/xero/select-tenant?location_id=${locationId}`))
const select = (locationId, tenantId = 'tenant-2') => POST(new Request('http://localhost/api/xero/select-tenant', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ location_id: locationId, tenant_id: tenantId }),
}))

const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: { status: 404, body: { success: false, error: 'Not found' } },
}

const PURGED_TABLES = ['xero_accounts', 'xero_contacts', 'xero_tax_rates']

describe('GET /api/xero/select-tenant — owner at the location asked about', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await list(LOC_B)
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(body.data.current_tenant_id).toBe('tenant-1')
      expect(withFreshToken).toHaveBeenCalledWith(LOC_B)
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(createServerClient).not.toHaveBeenCalled()
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await list(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})

describe('POST /api/xero/select-tenant — owner at the location whose org is switched', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await select(LOC_B)
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(body.data).toMatchObject({ changed: true, tenant_id: 'tenant-2' })
      expect(rec.calls).toContainEqual(['xero_connections', 'eq', 'location_id', LOC_B])
      for (const t of PURGED_TABLES) expect(rec.calls).toContainEqual([t, 'eq', 'location_id', LOC_B])
      expect(pullAccounts).toHaveBeenCalledWith(LOC_B)
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    // Refused before anything is read, switched or purged.
    expect(createServerClient).not.toHaveBeenCalled()
    expect(rec.calls).toEqual([])
    expect(pullAccounts).not.toHaveBeenCalled()
    expect(pullTaxRates).not.toHaveBeenCalled()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await select(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(rec.calls).toEqual([])
  })

  it('401 with no user (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await select(LOC_B)).status).toBe(401)
  })
})
