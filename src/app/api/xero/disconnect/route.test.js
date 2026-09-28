// SECFIX.1 — POST /api/xero/disconnect judges OWNER at the body's location.
//
// The defect: the only role gate was `user.role` (the ACTIVE studio's role),
// followed by a membership check. An owner at A who is staff at B could, with
// A active, disconnect B's Xero organisation and purge B's account, contact
// and tax-rate mirrors.
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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { LOC_B, person, ownerAtTargetCases, recordingDb } from '../../../../../tests/helpers/owner-at-location-callers.js'

let rec
beforeEach(() => {
  vi.clearAllMocks()
  rec = recordingDb()
  createServerClient.mockReturnValue(rec.db)
})

const disconnect = (locationId) => POST(new Request('http://localhost/api/xero/disconnect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ location_id: locationId }),
}))

const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Not permitted' } },
  hidden: { status: 403, body: { success: false, error: 'Not a member of that location' } },
}

describe('POST /api/xero/disconnect — owner at the location acted on', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await disconnect(LOC_B)
    const body = await res.json()
    if (outcome === 'pass') {
      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(rec.calls).toContainEqual(['xero_connections', 'delete'])
      expect(rec.calls).toContainEqual(['xero_connections', 'eq', 'location_id', LOC_B])
      for (const t of ['xero_accounts', 'xero_contacts', 'xero_tax_rates']) {
        expect(rec.calls).toContainEqual([t, 'eq', 'location_id', LOC_B])
      }
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(rec.calls).toEqual([])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await disconnect(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(rec.calls).toEqual([])
  })

  it('401 with no user (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await disconnect(LOC_B)
    expect(res.status).toBe(401)
    expect(rec.calls).toEqual([])
  })
})
