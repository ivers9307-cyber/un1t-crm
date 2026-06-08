// Tests for POST /api/contacts/[id]/invite-app
//
// Coverage:
//   - 401 when no user
//   - 403 when user is not master/owner/manager
//   - 403 when manager is at a different location (IDOR guard)
//   - 404 when contact doesn't exist
//   - 400 when contact has no email
//   - happy path: invite sent (kind='invite_sent')
//   - existing-user fallback: magic link resent (kind='magic_link_resent')
//   - error path: invite fails with non-existence reason → 400

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Mirror the real helper. The previous mock omitted it AND the user
  // fixtures set a non-existent `locationIds` field, so the location
  // guard was never actually exercised — it masked the production bug
  // where the route read `user.locationIds` (undefined) instead of
  // deriving ids from `user.locations`.
  getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function mockDb({ contact, contactError, inviteError, generateLinkError } = {}) {
  return {
    from: vi.fn((table) => {
      if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
      const single = vi.fn(() =>
        Promise.resolve(contactError ? { data: null, error: contactError } : { data: contact, error: null })
      )
      const eq = vi.fn(() => ({ single }))
      const select = vi.fn(() => ({ eq }))
      return { select }
    }),
    auth: {
      admin: {
        inviteUserByEmail: vi.fn((_email, _opts) =>
          Promise.resolve(inviteError
            ? { data: null, error: inviteError }
            : { data: { user: { id: 'new-user-id' } }, error: null }
          )
        ),
        generateLink: vi.fn((_opts) =>
          Promise.resolve(generateLinkError
            ? { data: null, error: generateLinkError }
            : { data: { properties: { action_link: 'https://app/auth' } }, error: null }
          )
        ),
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const fakeRequest = () => new Request('http://localhost/api/contacts/c1/invite-app', { method: 'POST' })

describe('POST /api/contacts/[id]/invite-app', () => {
  it('returns 401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('returns 403 when user is not master/owner/manager', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'coach', locations: [{ id: 'loc-1' }] })
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
  })

  it('returns 403 when manager is at a different location', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-OTHER' }] })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', name: 'Sarah', email: 'sarah@example.com', location_id: 'loc-1', user_id: null },
    }))
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(403)
  })

  it('returns 404 when contact not found', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    createServerClient.mockReturnValue(mockDb({ contactError: { message: 'not found' } }))
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(404)
  })

  it('returns 400 when contact has no email', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', name: 'Sarah', email: null, location_id: 'loc-1', user_id: null },
    }))
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/no email/i)
  })

  it('happy path: master invites, returns invite_sent', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    const db = mockDb({
      contact: { id: 'c1', name: 'Sarah', email: 'sarah@example.com', location_id: 'loc-1', user_id: null },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.kind).toBe('invite_sent')
    expect(db.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      'sarah@example.com',
      expect.objectContaining({
        redirectTo: expect.stringContaining('/auth/callback'),
        data: expect.objectContaining({ contact_id: 'c1', invited_for: 'champ-app' }),
      }),
    )
  })

  it('manager at the right location can invite', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: false, role: 'manager', locations: [{ id: 'loc-1' }] })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', name: 'Sarah', email: 'sarah@example.com', location_id: 'loc-1', user_id: null },
    }))
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
  })

  it('existing-user fallback: invite says "already registered" → generate magic link', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    const db = mockDb({
      contact: { id: 'c1', name: 'Sarah', email: 'sarah@example.com', location_id: 'loc-1', user_id: 'u-existing' },
      inviteError: { message: 'A user with this email already been registered.' },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.kind).toBe('magic_link_resent')
    expect(db.auth.admin.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'magiclink',
        email: 'sarah@example.com',
        options: expect.objectContaining({ redirectTo: expect.stringContaining('/auth/callback') }),
      }),
    )
  })

  it('returns 400 when invite fails with a non-recoverable error', async () => {
    getCurrentUser.mockResolvedValue({ isMaster: true })
    createServerClient.mockReturnValue(mockDb({
      contact: { id: 'c1', name: 'Sarah', email: 'sarah@example.com', location_id: 'loc-1', user_id: null },
      inviteError: { message: 'SMTP delivery failed' },
    }))
    const res = await POST(fakeRequest(), { params: { id: 'c1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/SMTP/i)
  })
})
