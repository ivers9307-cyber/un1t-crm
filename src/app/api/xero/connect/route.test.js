// SECFIX.1 — GET /api/xero/connect judges OWNER at the location the OAuth
// flow is started for.
//
// The defect: the only role gate was `user.role` (the ACTIVE studio's role),
// followed by a membership check. An owner at A who is staff at B could, with
// A active, start (and, with the callback, complete) a Xero connect for B.
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, the role
// helpers are REAL. Getting past the gate = the authorize URL was built and
// the state cookie set. All ids are synthetic.

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
vi.mock('@/lib/xero/client', () => ({ buildAuthorizeUrl: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { buildAuthorizeUrl } from '@/lib/xero/client'
import { LOC_B, person, ownerAtTargetCases } from '../../../../../tests/helpers/owner-at-location-callers.js'

beforeEach(() => {
  vi.clearAllMocks()
  buildAuthorizeUrl.mockReturnValue('https://login.xero.test/identity/connect/authorize?x=1')
})

const connect = (locationId) => GET(new NextRequest(`http://localhost/api/xero/connect?location_id=${locationId}`))

const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Not permitted' } },
  hidden: { status: 403, body: { success: false, error: 'Not a member of that location' } },
}

describe('GET /api/xero/connect — owner at the location acted on', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await connect(LOC_B)
    if (outcome === 'pass') {
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('https://login.xero.test/identity/connect/authorize?x=1')
      const state = buildAuthorizeUrl.mock.calls[0][0].state
      expect(state.split('.')[1]).toBe(LOC_B)
      expect(res.cookies.get('xero_oauth_state')?.value).toBe(state)
      return
    }
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL[outcome])
    expect(buildAuthorizeUrl).not.toHaveBeenCalled()
    expect(res.cookies.get('xero_oauth_state')).toBeUndefined()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await connect(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(buildAuthorizeUrl).not.toHaveBeenCalled()
  })

  it('redirects to login with no user (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await connect(LOC_B)
    expect(res.headers.get('location')).toBe('http://localhost/login')
    expect(buildAuthorizeUrl).not.toHaveBeenCalled()
  })
})
