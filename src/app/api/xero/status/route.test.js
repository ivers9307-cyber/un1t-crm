// SECFIX.1 — GET /api/xero/status judges OWNER at the location asked about.
//
// The defect: the only role gate was `user.role` (the ACTIVE studio's role),
// followed by a membership check. An owner at A who is staff at B could, with
// A active, read B's Xero connection (tenant, scopes, token timestamps).
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

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { LOC_B, person, ownerAtTargetCases, recordingDb } from '../../../../../tests/helpers/owner-at-location-callers.js'

const CONN = { tenant_id: 'tenant-1', tenant_name: 'Synthetic Org Ltd', tenant_type: 'ORGANISATION' }
let rec
beforeEach(() => {
  vi.clearAllMocks()
  rec = recordingDb({ xero_connections: { single: CONN } })
  createServerClient.mockReturnValue(rec.db)
})

const status = (locationId) => GET(new Request(`http://localhost/api/xero/status?location_id=${locationId}`))

const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Not permitted' } },
  hidden: { status: 403, body: { success: false, error: 'Not a member of that location' } },
}

describe('GET /api/xero/status — owner at the location asked about', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await status(LOC_B)
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(body).toEqual({ success: true, connected: true, connection: CONN })
      expect(rec.calls).toContainEqual(['xero_connections', 'eq', 'location_id', LOC_B])
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await status(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('401 with no user (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await status(LOC_B)).status).toBe(401)
  })
})
