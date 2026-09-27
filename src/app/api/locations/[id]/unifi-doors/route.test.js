// TRAINERSROLE.1 — GET /api/locations/[id]/unifi-doors judges the caller's
// role AT THE PATH LOCATION, symmetric with /unifi-users (StaffForm's door
// picker calls it per assignment location too). @/lib/auth is REAL; only
// getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(),
  listDoors: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getUnifiConfig, listDoors } from '@/lib/unifi-access'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const call = (id) => GET({}, { params: Promise.resolve({ id }) })

function fakeDb() {
  const from = vi.fn(() => ({
    select: () => ({
      eq: (_col, id) => ({
        maybeSingle: () => Promise.resolve({ data: { id, name: 'Studio', settings: {} }, error: null }),
      }),
    }),
  }))
  return { from }
}

describe('GET unifi-doors — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb()
    createServerClient.mockReturnValue(db)
    getUnifiConfig.mockResolvedValue({ configured: true })
    listDoors.mockResolvedValue([{ id: 'door-1', name: 'Front door' }])
  })

  it.each(ROLE_GATE_CASES)('%s', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, doors: [{ id: 'door-1', name: 'Front door' }], count: 1 })
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(db.from).not.toHaveBeenCalled()
      expect(listDoors).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(listDoors).not.toHaveBeenCalled()
  })
})
