// TRAINERSROLE.1 — GET /api/locations/[id]/unifi-users (every UniFi Access
// user at the studio's controller: names, emails, employee numbers) judges the
// caller's role AT THE PATH LOCATION. StaffForm calls it once per studio a
// staff member is assigned to, whichever studio is active, so the old
// `user.role` check let a manager at A who is staff at B read B's list.
// @/lib/auth is REAL; only getCurrentUser is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(),
  listUnifiUsers: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getUnifiConfig, listUnifiUsers } from '@/lib/unifi-access'
import { ROLE_GATE_CASES, LOC_B } from '../_role-gate-cases.js'

const USERS = [{ id: 'uu-1', full_name: 'Coach One', user_email: 'coach.one@example.com', employee_number: '7', status: 'ACTIVE', nfc_count: 1 }]
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

describe('GET unifi-users — role judged at the path location', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb()
    createServerClient.mockReturnValue(db)
    getUnifiConfig.mockResolvedValue({ configured: true })
    listUnifiUsers.mockResolvedValue(USERS)
  })

  it.each(ROLE_GATE_CASES)('%s', async (_label, caller, target, status, error) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await call(target)
    expect(res.status).toBe(status)
    if (status === 200) {
      expect(await res.json()).toEqual({ success: true, users: USERS, count: 1 })
    } else {
      expect(await res.json()).toEqual({ success: false, error })
      expect(db.from).not.toHaveBeenCalled()
      expect(listUnifiUsers).not.toHaveBeenCalled()
    }
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(LOC_B)
    expect(res.status).toBe(401)
    expect(listUnifiUsers).not.toHaveBeenCalled()
  })
})
