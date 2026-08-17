// Tests for POST /api/staff (staff create / invite)
//
// Coverage:
//   - 401 when no user
//   - 403 when caller is neither master nor owner at the active location
//   - happy path: inviteUserByEmail is called with the invitee's email and
//     metadata carrying BOTH full_name and the positive `invited_for: 'staff'`
//     marker (Phase 0a of the Repset merge program — the DB trigger
//     handle_new_user() will soon REQUIRE this marker to mint a staff
//     profile; the route must stamp it before that migration ships)
//   - 409 when auth reports the user already exists

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/staff', () => ({ listStaffForUser: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.example.com') }))
vi.mock('@/lib/staff-write', () => ({
  sparsifyAssignmentPermissions: vi.fn(({ assignments }) =>
    Promise.resolve(assignments.map((a) => ({ ...a, permissions: {} })))
  ),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001'

function mockDb({ inviteError } = {}) {
  const inviteUserByEmail = vi.fn((_email, _opts) =>
    Promise.resolve(inviteError
      ? { data: null, error: inviteError }
      : { data: { user: { id: 'new-user-id' } }, error: null }
    )
  )
  const db = {
    auth: { admin: { inviteUserByEmail } },
    from: vi.fn((table) => {
      if (table === 'profiles') {
        return {
          update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({
                data: { id: 'new-user-id', full_name: 'New Coach', profile_locations: [] },
                error: null,
              })),
            })),
          })),
        }
      }
      if (table === 'profile_locations') {
        return {
          delete: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          insert: vi.fn(() => Promise.resolve({ error: null })),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, inviteUserByEmail }
}

const postReq = (body) => new Request('http://localhost/api/staff', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const ownerUser = {
  id: 'caller-1',
  isMaster: false,
  role: 'owner',
  rolesByLocation: { [LOC]: 'owner' },
  locations: [{ id: LOC }],
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/staff', () => {
  it('401 when not authenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(postReq({ email: 'new@example.com', full_name: 'New Coach' }))
    expect(res.status).toBe(401)
  })

  it('403 when caller is neither master nor owner', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: LOC }] })
    const res = await POST(postReq({ email: 'new@example.com', full_name: 'New Coach' }))
    expect(res.status).toBe(403)
  })

  it('invites with full_name AND the invited_for staff marker in metadata', async () => {
    getCurrentUser.mockResolvedValue(ownerUser)
    const { db, inviteUserByEmail } = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(postReq({
      email: 'new@example.com',
      full_name: 'New Coach',
      assignments: [{ location_id: LOC, role: 'staff' }],
    }))

    expect(res.status).toBe(201)
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1)
    const [email, opts] = inviteUserByEmail.mock.calls[0]
    expect(email).toBe('new@example.com')
    // Phase 0a marker: handle_new_user() will require a positive
    // invited_for='staff' stamp to mint a staff profile. full_name must
    // survive alongside it.
    expect(opts.data).toEqual({ full_name: 'New Coach', invited_for: 'staff' })
    expect(opts.redirectTo).toBe('https://crm.example.com/reset-password')
  })

  it('409 with user_exists code when auth says the email is taken', async () => {
    getCurrentUser.mockResolvedValue(ownerUser)
    const { db } = mockDb({ inviteError: { message: 'A user with this email address has already been registered' } })
    createServerClient.mockReturnValue(db)

    const res = await POST(postReq({ email: 'dupe@example.com', full_name: 'Dupe' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('user_exists')
  })
})
