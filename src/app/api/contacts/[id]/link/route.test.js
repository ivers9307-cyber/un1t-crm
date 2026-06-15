// Tests for POST/DELETE /api/contacts/[id]/link (PERSON-LINK.1)
//
// Coverage:
//   - POST link two ungrouped contacts (same location) → 200 + createGroup called
//   - POST link when [id] already grouped → addToGroup called with existing group id
//   - POST with otherContact in a different location → 400 cross-location error
//   - POST when neither contact exists → 404
//   - POST ?action=set-primary on a linked contact → setPrimary called
//   - POST ?action=set-primary on an unlinked contact → 400
//   - DELETE on a linked contact → removeFromGroup called
//   - DELETE on an unlinked contact → 400
//   - No contact_linking permission → 403

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

vi.mock('@/lib/person-links', () => ({
  createGroup: vi.fn(),
  addToGroup: vi.fn(),
  removeFromGroup: vi.fn(),
  setPrimary: vi.fn(),
  getPersonGroup: vi.fn(),
}))

import { POST, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { createGroup, addToGroup, removeFromGroup, setPrimary, getPersonGroup } from '@/lib/person-links'

// ─── DB mock helpers ─────────────────────────────────────────────────────────

// UUID-shaped IDs (must match the uuidLike regex used by LinkBodySchema)
const ID = 'a0000000-0000-0000-0000-000000000001'
const OTHER_ID = 'b0000000-0000-0000-0000-000000000002'
const OTHER_ID_DIFF_LOC = 'c0000000-0000-0000-0000-000000000003'

const CONTACT = { id: ID, location_id: 'loc-A', name: 'Alice' }
const OTHER = { id: OTHER_ID, location_id: 'loc-A' }
const OTHER_LOC = { id: OTHER_ID_DIFF_LOC, location_id: 'loc-B' }

function mockDb({ contact = CONTACT, other = OTHER } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col, val) => ({
              single: vi.fn(() => {
                if (val === ID) return Promise.resolve({ data: contact, error: null })
                if (val === OTHER_ID || val === OTHER_ID_DIFF_LOC) return Promise.resolve({ data: other, error: null })
                return Promise.resolve({ data: null, error: { message: 'not found' } })
              }),
            })),
          })),
        }
      }
      if (table === 'activities') {
        return { insert: vi.fn(() => Promise.resolve({ error: null })) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

function mockDbMissing() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'not found' } })),
        })),
      })),
    })),
  }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${ID}/link`
const OWNER = { id: 'u1', role: 'owner', locations: [{ id: 'loc-A' }] }

function postReq(body = { otherContactId: OTHER_ID }, url = BASE_URL) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function setPrimaryReq() {
  return new Request(`${BASE_URL}?action=set-primary`, { method: 'POST' })
}

function deleteReq() {
  return new Request(BASE_URL, { method: 'DELETE' })
}

const props = { params: { id: ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
  createGroup.mockResolvedValue({ group: { id: 'g1' }, members: [] })
  addToGroup.mockResolvedValue({ group: { id: 'g1' }, members: [] })
  removeFromGroup.mockResolvedValue({ group: null, members: [] })
  setPrimary.mockResolvedValue({ group: { id: 'g1', primary_contact_id: 'c1' }, members: [] })
  getPersonGroup.mockResolvedValue(null)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/link — link', () => {
  it('two ungrouped contacts (same location) → 200 and createGroup called', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup.mockResolvedValue(null) // both ungrouped

    const res = await POST(postReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(createGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      contactIds: [ID, OTHER_ID],
      method: 'manual',
      confidence: 'manual',
      actorId: 'u1',
      locationId: 'loc-A',
    }))
  })

  it('[id] already grouped → addToGroup called with existing group id', async () => {
    createServerClient.mockReturnValue(mockDb())
    // [id] is in group g-existing; other is not
    getPersonGroup
      .mockResolvedValueOnce({ group: { id: 'g-existing' }, members: [] }) // for id
      .mockResolvedValueOnce(null) // for otherContactId

    const res = await POST(postReq(), props)
    expect(res.status).toBe(200)
    expect(addToGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: 'g-existing',
      contactIds: [OTHER_ID],
    }))
    expect(createGroup).not.toHaveBeenCalled()
  })

  it('other already grouped → addToGroup called with other group id', async () => {
    createServerClient.mockReturnValue(mockDb())
    // [id] is not grouped; other is in g-other
    getPersonGroup
      .mockResolvedValueOnce(null) // for id
      .mockResolvedValueOnce({ group: { id: 'g-other' }, members: [] }) // for otherContactId

    const res = await POST(postReq(), props)
    expect(res.status).toBe(200)
    expect(addToGroup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: 'g-other',
      contactIds: [ID],
    }))
    expect(createGroup).not.toHaveBeenCalled()
  })

  it('already in the same group → idempotent 200 (no mutation helpers called)', async () => {
    createServerClient.mockReturnValue(mockDb())
    const sameGroup = { group: { id: 'g-same' }, members: [] }
    getPersonGroup.mockResolvedValue(sameGroup)

    const res = await POST(postReq(), props)
    expect(res.status).toBe(200)
    expect(createGroup).not.toHaveBeenCalled()
    expect(addToGroup).not.toHaveBeenCalled()
  })

  it('both in different groups → 400 with merge-requires-unlink error', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup
      .mockResolvedValueOnce({ group: { id: 'g-A' }, members: [] }) // id
      .mockResolvedValueOnce({ group: { id: 'g-B' }, members: [] }) // other

    const res = await POST(postReq(), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/unlink one first/i)
  })

  it('otherContact in a different location → 400 cross-location error', async () => {
    createServerClient.mockReturnValue(mockDb({ contact: CONTACT, other: OTHER_LOC }))

    const res = await POST(postReq({ otherContactId: OTHER_ID_DIFF_LOC }), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/different locations/i)
  })

  it('contact [id] not found → 404', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await POST(postReq(), props)
    expect(res.status).toBe(404)
  })

  it('otherContact not found → 404', async () => {
    const db = {
      from: vi.fn((table) => {
        if (table === 'contacts') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((col, val) => ({
                single: vi.fn(() => {
                  if (val === ID) return Promise.resolve({ data: CONTACT, error: null })
                  // other contact missing
                  return Promise.resolve({ data: null, error: { message: 'not found' } })
                }),
              })),
            })),
          }
        }
        if (table === 'activities') {
          return { insert: vi.fn(() => Promise.resolve({ error: null })) }
        }
      }),
    }
    createServerClient.mockReturnValue(db)

    const res = await POST(postReq(), props)
    expect(res.status).toBe(404)
  })

  it('user without contact_linking permission → 403', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(mockDb())

    const res = await POST(postReq(), props)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/unauthorized/i)
  })
})

describe('POST /api/contacts/[id]/link?action=set-primary', () => {
  it('linked contact → setPrimary called and 200 returned', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup.mockResolvedValue({ group: { id: 'g-set-primary' }, members: [] })

    const res = await POST(setPrimaryReq(), props)
    expect(res.status).toBe(200)
    expect(setPrimary).toHaveBeenCalledWith(expect.anything(), {
      groupId: 'g-set-primary',
      contactId: ID,
    })
  })

  it('unlinked contact → 400 not-linked-to-anyone error', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup.mockResolvedValue(null)

    const res = await POST(setPrimaryReq(), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/not linked to anyone/i)
    expect(setPrimary).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/contacts/[id]/link — unlink', () => {
  it('linked contact → removeFromGroup called and 200 returned', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup.mockResolvedValue({ group: { id: 'g-del' }, members: [] })

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(200)
    expect(removeFromGroup).toHaveBeenCalledWith(expect.anything(), {
      groupId: 'g-del',
      contactId: ID,
    })
  })

  it('unlinked contact → 400 not-linked error', async () => {
    createServerClient.mockReturnValue(mockDb())
    getPersonGroup.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/not linked/i)
    expect(removeFromGroup).not.toHaveBeenCalled()
  })

  it('user without contact_linking permission → 403', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(mockDb())

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(403)
  })
})
