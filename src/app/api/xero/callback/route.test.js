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
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listConnectedTenants, XeroError } from '@/lib/xero/client'
import { logError } from '@/lib/log'

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
  expect(res.headers.get('location')).toContain('xero_error=not_permitted')
  expect(exchangeAuthorizationCode).not.toHaveBeenCalled()
}
const expectPassed = (res) => {
  expect(exchangeAuthorizationCode).toHaveBeenCalledWith('abc')
  expect(res.headers.get('location')).not.toContain('not_permitted')
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

  it('a state that does not match the cookie answers state_mismatch on /settings', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    const res = await callback(LOC_A, { cookieMatches: false })
    expect(res.headers.get('location')).toBe('http://localhost/settings?xero_error=state_mismatch')
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
    expect(res.headers.get('location')).toBe(`http://localhost/settings/locations/${LOC_A}?tab=xero&xero_error=taken_read_failed`)
    expect(upsert).not.toHaveBeenCalled()
  })
})

// CHANNELREAD.1 — the callback redirects with a CODE the landing page maps to
// copy (src/lib/xero/callback-notice.js). No free text, no org name, no
// Postgres or Xero message ever rides in the URL; the raw detail is logged.
describe('GET /api/xero/callback — outcome codes', () => {
  const TENANT = { tenantId: 't-1', tenantName: 'Synthetic Org One', tenantType: 'ORGANISATION' }
  const TENANT_2 = { tenantId: 't-2', tenantName: 'Synthetic Org Two', tenantType: 'ORGANISATION' }
  const db = ({ existing = [], upsertError = null } = {}) => {
    const upsert = vi.fn(() => Promise.resolve({ error: upsertError }))
    createServerClient.mockReturnValue({
      from: vi.fn(() => ({ select: () => Promise.resolve({ data: existing, error: null }), upsert })),
    })
    return upsert
  }
  const at = (params) => `http://localhost/settings/locations/${LOC_A}?tab=xero&${params}`

  beforeEach(() => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
  })

  it('success on a one-org login → xero_connected=1 and no org name in the URL', async () => {
    listConnectedTenants.mockResolvedValue([TENANT])
    const upsert = db()
    const res = await callback(LOC_A)
    expect(upsert).toHaveBeenCalled()
    expect(res.headers.get('location')).toBe(at('xero_connected=1'))
  })

  it('success when the pick was arbitrary → xero_orgs carries the count', async () => {
    listConnectedTenants.mockResolvedValue([TENANT, TENANT_2])
    db()
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe(at('xero_connected=1&xero_orgs=2'))
  })

  it('Xero declined → declined, and the provider value is logged not echoed', async () => {
    const res = await GET(new NextRequest(
      'http://localhost/api/xero/callback?error=access_denied&state=nonce-1.' + LOC_A,
      { headers: { cookie: `xero_oauth_state=nonce-1.${LOC_A}` } },
    ))
    expect(res.headers.get('location')).toBe(at('xero_error=declined'))
    expect(res.headers.get('location')).not.toContain('access_denied')
  })

  it('no code → missing_code', async () => {
    const res = await GET(new NextRequest(
      'http://localhost/api/xero/callback?state=nonce-1.' + LOC_A,
      { headers: { cookie: `xero_oauth_state=nonce-1.${LOC_A}` } },
    ))
    expect(res.headers.get('location')).toBe(at('xero_error=missing_code'))
  })

  it('no tenants → no_tenants', async () => {
    listConnectedTenants.mockResolvedValue([])
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe(at('xero_error=no_tenants'))
  })

  it('every org taken → all_taken, with no org or location name in the URL', async () => {
    listConnectedTenants.mockResolvedValue([TENANT])
    const upsert = db({ existing: [{ tenant_id: 't-1', location_id: LOC_B, locations: { name: 'Synthetic Other Studio' } }] })
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe(at('xero_error=all_taken'))
    expect(upsert).not.toHaveBeenCalled()
  })

  it('a failed save → save_failed; the Postgres text goes to the log, not the URL', async () => {
    listConnectedTenants.mockResolvedValue([TENANT])
    db({ upsertError: { message: 'duplicate key value violates unique constraint' } })
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe(at('xero_error=save_failed'))
    expect(logError).toHaveBeenCalledWith('xero-callback', expect.any(String), expect.objectContaining({ err: 'duplicate key value violates unique constraint' }))
  })

  it('a Xero failure → xero_error; its message is logged', async () => {
    exchangeAuthorizationCode.mockRejectedValue(new XeroError('invalid_grant'))
    const res = await callback(LOC_A)
    expect(res.headers.get('location')).toBe(at('xero_error=xero_error'))
    expect(logError).toHaveBeenCalledWith('xero-callback', expect.any(String), expect.objectContaining({ err: 'invalid_grant' }))
  })

  it('the hub\'s return_to still wins, with the same codes', async () => {
    listConnectedTenants.mockResolvedValue([TENANT])
    db()
    const rt = Buffer.from('/settings/integrations-hub').toString('base64url')
    const state = `nonce-1.${LOC_A}.${rt}`
    const res = await GET(new NextRequest(
      `http://localhost/api/xero/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `xero_oauth_state=${state}` } },
    ))
    expect(res.headers.get('location')).toBe('http://localhost/settings/integrations-hub?xero_connected=1')
  })
})
