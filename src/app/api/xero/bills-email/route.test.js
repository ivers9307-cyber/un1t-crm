// SECFIX.1 — POST /api/xero/bills-email judges OWNER at the body's location.
//
// The defect: the only role gate was `user.role` (the ACTIVE studio's role),
// followed by a membership check. An owner at A who is staff at B could, with
// A active, repoint B's Xero bills email-in address.
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

const setAddress = (locationId) => POST(new Request('http://localhost/api/xero/bills-email', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ location_id: locationId, bills_email_address: 'bills@example.test' }),
}))

const REFUSAL = {
  forbidden: { status: 403, body: { success: false, error: 'Not permitted' } },
  hidden: { status: 403, body: { success: false, error: 'Not a member of that location' } },
}

describe('POST /api/xero/bills-email — owner at the location acted on', () => {
  it.each(ownerAtTargetCases())('%s', async (_label, caller, outcome) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await setAddress(LOC_B)
    const body = await res.json()
    if (outcome === 'pass') {
      expect({ status: res.status, body }).toEqual({ status: 200, body: { success: true } })
      expect(rec.calls).toContainEqual(['xero_connections', 'update', { bills_email_address: 'bills@example.test' }])
      expect(rec.calls).toContainEqual(['xero_connections', 'eq', 'location_id', LOC_B])
      return
    }
    expect({ status: res.status, body }).toEqual(REFUSAL[outcome])
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('staff everywhere is refused by the coarse pre-check with the same body', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await setAddress(LOC_B)
    expect({ status: res.status, body: await res.json() }).toEqual(REFUSAL.forbidden)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('401 with no user (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await setAddress(LOC_B)).status).toBe(401)
  })
})
