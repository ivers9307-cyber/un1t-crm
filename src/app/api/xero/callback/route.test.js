// SECFIX.1 — GET /api/xero/callback judges OWNER at the location carried in
// the OAuth `state`.
//
// The defect: the only gate was `user.role` (the role at the caller's ACTIVE
// studio) being owner/master. The location the connection is written for
// comes from `state`, which is checked only against the xero_oauth_state
// cookie — a value the caller's own browser holds — so any owner anywhere who
// completed OAuth with a crafted state could bind a Xero organisation to
// another tenant's location. One location = one Xero org, and a wrong binding
// files one company's bills into another's books.
//
// Now: hasRoleAtLocation(user, stateLocationId, ['owner']) (implies
// membership; masters pass via profileRole), answered with the route's
// existing "Not permitted" redirect, before the code exchange. The
// active-studio check becomes a coarse owner-anywhere pre-check.
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, the role
// helpers are REAL. Getting past the gate = the code exchange was reached.
// All ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/xero/client', () => ({
  exchangeAuthorizationCode: vi.fn(),
  listConnectedTenants: vi.fn(),
  XeroError: class XeroError extends Error {},
}))
vi.mock('@/lib/xero/accounts-sync', () => ({ pullAccounts: vi.fn() }))
vi.mock('@/lib/xero/tax-rates-sync', () => ({ pullTaxRates: vi.fn() }))
vi.mock('@/lib/xero/contacts-sync', () => ({ pullContacts: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listConnectedTenants } from '@/lib/xero/client'

const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
const LOC_B = 'b0000000-0000-4000-8000-00000000000b'

// A non-master caller: `roles` is { [locationId]: role }, `active` the active studio.
const person = (roles, active) => ({
  id: 'u0000000-0000-4000-8000-000000000001',
  isMaster: false,
  profileRole: 'staff',
  role: roles[active],
  activeLocation: { id: active },
  locations: Object.keys(roles).map((id) => ({ id })),
  rolesByLocation: { ...roles },
})
const MASTER = {
  id: 'u0000000-0000-4000-8000-00000000000m',
  isMaster: true,
  profileRole: 'master',
  role: 'master',
  locations: [],
  rolesByLocation: {},
}

const callback = (stateLocationId, { cookieMatches = true } = {}) => {
  const state = `nonce-1.${stateLocationId}`
  const cookie = cookieMatches ? state : 'nonce-other.x'
  return GET(new NextRequest(
    `http://localhost/api/xero/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `xero_oauth_state=${cookie}` } },
  ))
}

beforeEach(() => {
  vi.clearAllMocks()
  // Past the gate the exchange runs; no tenants ends the flow with a redirect.
  exchangeAuthorizationCode.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 })
  listConnectedTenants.mockResolvedValue([])
  createServerClient.mockReturnValue({ from: vi.fn(() => { throw new Error('unexpected db read') }) })
})

const expectRefused = (res) => {
  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toContain('error=Not+permitted')
  expect(exchangeAuthorizationCode).not.toHaveBeenCalled()
}
const expectPassed = (res) => {
  expect(exchangeAuthorizationCode).toHaveBeenCalledWith('abc')
  expect(res.headers.get('location')).not.toContain('Not+permitted')
}

describe('GET /api/xero/callback — owner at the OAuth state\'s location', () => {
  it('redirects to login with no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe('http://localhost/login')
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled()
  })

  it('an owner who does NOT belong to the state\'s location is refused before the code exchange (the missing membership check)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    expectRefused(await callback(LOC_B))
  })

  it('owner at the ACTIVE studio but staff at the state\'s location: refused', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner', [LOC_B]: 'staff' }, LOC_A))
    expectRefused(await callback(LOC_B))
  })

  it('owner at the state\'s location while a studio where they are staff is active: allowed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'staff', [LOC_B]: 'owner' }, LOC_A))
    expectPassed(await callback(LOC_B))
  })

  it('owner at the state\'s location, which is active: allowed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    expectPassed(await callback(LOC_A))
  })

  it('a manager at the state\'s location: refused', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'manager' }, LOC_A))
    expectRefused(await callback(LOC_A))
  })

  it('a master is allowed at any location', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expectPassed(await callback(LOC_B))
  })

  it('a state that does not match the cookie still answers OAuth state mismatch (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    const res = await callback(LOC_A, { cookieMatches: false })
    expect(res.headers.get('location')).toContain('error=OAuth+state+mismatch')
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled()
  })
})

// CHANNELREAD.1 — the "which orgs are already taken" read discarded its
// error, so on a blip chooseTenantToBind saw nothing taken and could bind
// this location to another location's org (the XERO-ONE-ORG.1 hazard).
describe('GET /api/xero/callback — a failed taken-orgs read binds nothing', () => {
  it('redirects with an error and never upserts', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    listConnectedTenants.mockResolvedValue([{ tenantId: 't-1', tenantName: 'Org One', tenantType: 'ORGANISATION' }])
    const upsert = vi.fn()
    createServerClient.mockReturnValue({
      from: vi.fn(() => ({
        select: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        upsert,
      })),
    })
    const res = await callback(LOC_A)
    expect(res.status).toBe(307)
    expect(decodeURIComponent(res.headers.get('location')).replace(/\+/g, ' '))
      .toContain('Could not check which Xero organisations are already connected, so nothing was changed. Try connecting again.')
    expect(upsert).not.toHaveBeenCalled()
  })
})
