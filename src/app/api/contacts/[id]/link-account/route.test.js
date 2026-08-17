// Tests for /api/contacts/[id]/link-account (REPSET-P5 — admin contact-linking tool)
//
// Richard's locked decision (17 Aug): staff never self-link their member
// contact — the merged app hard-disables self-linking when
// has_ever_been_staff is set, and an admin does the link from the CRM.
// This route is that admin mechanism.
//
// Coverage:
//   - authz: 401 no user; 403 staff/manager/head_coach; owner + master allowed
//   - GET: linked state (masked email, staff-profile flag), exact-email
//     search (case-insensitive equality, near-miss NOT matched, no fuzzy
//     listing), invalid email → 400
//   - POST: missing/false confirm → 400, contact 404, already-linked → 409
//     with current state (no write), target auth user missing → 404 (no
//     write, never creates), auth user linked to another contact → 409,
//     happy path (write + audit), staff dual-case allowed
//   - DELETE: missing confirm → 400, not linked → 400, happy path
//     (user_id cleared + audit)

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Mirror the real helper: null when allowed, a 404 Response otherwise
  // (detail routes 404 — not 403 — so contact ids can't be enumerated).
  assertLocationAccessOr404: (u, locationId) => {
    if (u?.isMaster) return null
    const ok = (u?.locations || []).some((l) => l.id === locationId)
    return ok ? null : Response.json({ success: false, error: 'Contact not found' }, { status: 404 })
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(() => Promise.resolve({ logged: true })),
}))

import { GET, POST, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'

function mockDb({
  contact,
  contactError,
  conflictContacts = [],
  staffProfile = null,
  authUser = null,          // getUserById hit when ids match
  listUsersPages = [[]],    // page-indexed arrays of auth users
  updateError = null,
} = {}) {
  const updates = []
  const db = {
    updates,
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => {
            const chain = {
              eq: vi.fn(() => chain),
              neq: vi.fn(() => chain),
              limit: vi.fn(() => Promise.resolve({ data: conflictContacts, error: null })),
              single: vi.fn(() => Promise.resolve(
                contactError ? { data: null, error: contactError } : { data: contact, error: null }
              )),
            }
            return chain
          }),
          update: vi.fn((payload) => ({
            eq: vi.fn((col, val) => {
              updates.push({ payload, col, val })
              return Promise.resolve({ error: updateError })
            }),
          })),
        }
      }
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: staffProfile, error: null })),
            })),
          })),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    auth: {
      admin: {
        getUserById: vi.fn((uid) => Promise.resolve(
          authUser && authUser.id === uid
            ? { data: { user: authUser }, error: null }
            : { data: { user: null }, error: { message: 'User not found' } }
        )),
        listUsers: vi.fn(({ page = 1 } = {}) => Promise.resolve({
          data: { users: listUsersPages[page - 1] || [] },
          error: null,
        })),
      },
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
})

const master = { isMaster: true, role: 'master' }
const owner = { isMaster: false, role: 'owner', locations: [{ id: 'loc-1' }] }
const manager = { isMaster: false, role: 'manager', locations: [{ id: 'loc-1' }] }
const staff = { isMaster: false, role: 'staff', locations: [{ id: 'loc-1' }] }

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const U_GHOST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const U_NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AUTH_USER = { id: U1, email: 'sarah@example.com' }
const baseContact = { id: 'c1', name: 'Sarah Byrne', email: 'sarah@example.com', location_id: 'loc-1', user_id: null }
const linkedContact = { ...baseContact, user_id: U1 }

const url = (qs = '') => `http://localhost/api/contacts/c1/link-account${qs}`
const getReq = (qs = '') => new Request(url(qs), { method: 'GET' })
const jsonReq = (method, body) => new Request(url(), {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const params = { params: { id: 'c1' } }

describe('authz (all methods)', () => {
  it('401 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq(), params)).status).toBe(401)
    expect((await POST(jsonReq('POST', { userId: U1, confirm: true }), params)).status).toBe(401)
    expect((await DELETE(jsonReq('DELETE', { confirm: true }), params)).status).toBe(401)
  })

  it('403 for staff and manager — this tool is master/owner ONLY', async () => {
    for (const user of [staff, manager]) {
      getCurrentUser.mockResolvedValue(user)
      expect((await GET(getReq(), params)).status).toBe(403)
      expect((await POST(jsonReq('POST', { userId: U1, confirm: true }), params)).status).toBe(403)
      expect((await DELETE(jsonReq('DELETE', { confirm: true }), params)).status).toBe(403)
    }
  })

  it('owner at the contact\'s location is allowed', async () => {
    getCurrentUser.mockResolvedValue(owner)
    createServerClient.mockReturnValue(mockDb({ contact: baseContact }))
    expect((await GET(getReq(), params)).status).toBe(200)
  })

  it('owner at a DIFFERENT location gets 404 (not 403 — no id enumeration)', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, locations: [{ id: 'loc-OTHER' }] })
    createServerClient.mockReturnValue(mockDb({ contact: baseContact }))
    expect((await GET(getReq(), params)).status).toBe(404)
  })
})

describe('GET /api/contacts/[id]/link-account', () => {
  it('404 when contact not found', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contactError: { message: 'not found' } }))
    expect((await GET(getReq(), params)).status).toBe(404)
  })

  it('unlinked contact → linked:false, no account', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contact: baseContact }))
    const res = await GET(getReq(), params)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.linked).toBe(false)
    expect(j.data.account).toBeNull()
  })

  it('linked contact → masked email of the auth user, never the raw email', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contact: linkedContact, authUser: AUTH_USER }))
    const res = await GET(getReq(), params)
    const j = await res.json()
    expect(j.data.linked).toBe(true)
    expect(j.data.account.maskedEmail).toBe('sa•••@example.com')
    expect(JSON.stringify(j)).not.toContain('sarah@example.com')
  })

  it('linked contact whose auth user is a staff profile → staff flag set (the dual case)', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({
      contact: linkedContact,
      authUser: AUTH_USER,
      staffProfile: { id: U1, full_name: 'Sarah Byrne', role: 'head_coach' },
    }))
    const j = await (await GET(getReq(), params)).json()
    expect(j.data.account.staff).toEqual({ fullName: 'Sarah Byrne', role: 'head_coach' })
  })

  it('?email= search: exact case-insensitive match, masked, near-misses excluded', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({
      contact: baseContact,
      listUsersPages: [[
        { id: 'u-near', email: 'sarah+x@example.com' },
        { id: U1, email: 'sarah@example.com' },
        { id: 'u-other', email: 'aXb@example.com' },
      ]],
    }))
    const j = await (await GET(getReq('?email=Sarah%40Example.com'), params)).json()
    expect(j.data.search.found).toBe(true)
    expect(j.data.search.userId).toBe(U1)
    expect(j.data.search.maskedEmail).toBe('sa•••@example.com')
    // No fuzzy listing: only the single exact match comes back.
    expect(JSON.stringify(j.data.search)).not.toContain('u-near')
  })

  it('?email= search: no auth user with that email → found:false (and no user created)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: baseContact, listUsersPages: [[{ id: 'u2', email: 'other@example.com' }]] })
    createServerClient.mockReturnValue(db)
    const j = await (await GET(getReq('?email=missing%40example.com'), params)).json()
    expect(j.data.search.found).toBe(false)
    expect(db.updates).toHaveLength(0)
  })

  it('?email= search rejects a non-email string with 400', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contact: baseContact }))
    expect((await GET(getReq('?email=not-an-email'), params)).status).toBe(400)
  })
})

describe('POST /api/contacts/[id]/link-account', () => {
  it('400 when confirm is missing or not true (UI must send it deliberately)', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contact: baseContact, authUser: AUTH_USER }))
    expect((await POST(jsonReq('POST', { userId: U1 }), params)).status).toBe(400)
    expect((await POST(jsonReq('POST', { userId: U1, confirm: false }), params)).status).toBe(400)
  })

  it('404 when contact not found', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contactError: { message: 'not found' } }))
    expect((await POST(jsonReq('POST', { userId: U1, confirm: true }), params)).status).toBe(404)
  })

  it('already-linked contact → 409 with the current state, and NO write (deliberate two-step)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: linkedContact, authUser: AUTH_USER })
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', { userId: U_NEW, confirm: true }), params)
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.success).toBe(false)
    expect(j.data.linked).toBe(true)
    expect(j.data.account.maskedEmail).toBe('sa•••@example.com')
    expect(db.updates).toHaveLength(0)
  })

  it('target auth user does not exist → 404, no write — this route NEVER creates auth users', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: baseContact, authUser: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', { userId: U_GHOST, confirm: true }), params)
    expect(res.status).toBe(404)
    expect(db.updates).toHaveLength(0)
    expect(db.auth.admin.getUserById).toHaveBeenCalledWith(U_GHOST)
  })

  it('auth user already linked to ANOTHER contact → 409, no write', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({
      contact: baseContact,
      authUser: AUTH_USER,
      conflictContacts: [{ id: 'c2', name: 'Other Person' }],
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', { userId: U1, confirm: true }), params)
    expect(res.status).toBe(409)
    expect(db.updates).toHaveLength(0)
  })

  it('happy path: owner links → user_id written, audit row logged', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, id: 'admin-1' })
    const db = mockDb({ contact: baseContact, authUser: AUTH_USER })
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', { userId: U1, confirm: true }), params)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.linked).toBe(true)
    expect(db.updates).toEqual([{ payload: { user_id: U1 }, col: 'id', val: 'c1' }])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'auth',
      action: 'contact.app_account_linked',
      target: expect.objectContaining({ resource: 'contacts/c1' }),
    }))
  })

  it('dual case: the auth user IS a staff profile — link succeeds, staff surfaced', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({
      contact: baseContact,
      authUser: AUTH_USER,
      staffProfile: { id: U1, full_name: 'Sarah Byrne', role: 'head_coach' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(jsonReq('POST', { userId: U1, confirm: true }), params)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.account.staff).toEqual({ fullName: 'Sarah Byrne', role: 'head_coach' })
    // Staff dual-case target has a profiles row → audit may carry target.id
    // (FK → profiles). A member-only auth user must NOT set target.id.
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ id: U1 }),
    }))
  })

  it('member-only auth user: audit target.id stays unset (FK → profiles would drop the row)', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: baseContact, authUser: AUTH_USER, staffProfile: null })
    createServerClient.mockReturnValue(db)
    await POST(jsonReq('POST', { userId: U1, confirm: true }), params)
    const call = logAuditEvent.mock.calls[0][0]
    expect(call.target.id).toBeUndefined()
  })

  it('failed write surfaces as 500, not silent success', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: baseContact, authUser: AUTH_USER, updateError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    expect((await POST(jsonReq('POST', { userId: U1, confirm: true }), params)).status).toBe(500)
  })
})

describe('DELETE /api/contacts/[id]/link-account', () => {
  it('400 when confirm missing', async () => {
    getCurrentUser.mockResolvedValue(master)
    createServerClient.mockReturnValue(mockDb({ contact: linkedContact }))
    expect((await DELETE(jsonReq('DELETE', {}), params)).status).toBe(400)
  })

  it('400 when the contact has no linked account', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: baseContact })
    createServerClient.mockReturnValue(db)
    const res = await DELETE(jsonReq('DELETE', { confirm: true }), params)
    expect(res.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it('happy path: clears user_id + audit', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, id: 'admin-1' })
    const db = mockDb({ contact: linkedContact, authUser: AUTH_USER })
    createServerClient.mockReturnValue(db)
    const res = await DELETE(jsonReq('DELETE', { confirm: true }), params)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.linked).toBe(false)
    expect(db.updates).toEqual([{ payload: { user_id: null }, col: 'id', val: 'c1' }])
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'auth',
      action: 'contact.app_account_unlinked',
      target: expect.objectContaining({ resource: 'contacts/c1' }),
    }))
  })

  it('failed write surfaces as 500', async () => {
    getCurrentUser.mockResolvedValue(master)
    const db = mockDb({ contact: linkedContact, updateError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    expect((await DELETE(jsonReq('DELETE', { confirm: true }), params)).status).toBe(500)
  })
})
