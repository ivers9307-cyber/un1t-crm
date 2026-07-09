// Tests for POST /api/contacts/[id]/notes (GLOFOX-NOTES staff note path)
//
// Coverage:
//   - session user with `contacts` permission + in-location contact → inserts
//     note (contact_id, content, location_id) + returns success, and fires the
//     Glofox push with sourceTable:'notes' + author from the session user
//   - missing `contacts` permission → 403
//   - contact outside the caller's location → 404
//   - empty / whitespace-only content → 400 (Zod)

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Mock the push so the test never actually attempts a Glofox call.
vi.mock('@/lib/glofox-note-push', () => ({
  pushNoteToGlofox: vi.fn(() => Promise.resolve({ pushed: false })),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { pushNoteToGlofox } from '@/lib/glofox-note-push'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const OTHER_LOC  = 'd0000000-0000-0000-0000-000000000004'

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
const CONTACT_OUT = { id: CONTACT_ID, location_id: OTHER_LOC }
const STAFF = { id: USER_ID, role: 'staff', full_name: 'Sam Staff', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function makeDb(insertSpy, contact = CONTACT) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: contact, error: null })),
            })),
          })),
        }
      }
      if (table === 'notes') {
        return { insert: insertSpy }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

// insert spy that echoes an { id } row back (route selects only 'id').
function echoInsert() {
  let captured = null
  const spy = vi.fn((payload) => {
    captured = payload
    return {
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({ data: { id: 'note1' }, error: null })),
      })),
    }
  })
  spy.captured = () => captured
  return spy
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/notes`

function postReq(body = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const props = { params: { id: CONTACT_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(STAFF)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/notes', () => {
  it('inserts a note and fires the Glofox push with author from the session user', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ content: 'Called the member, left a voicemail.' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    const payload = insertSpy.captured()
    expect(payload).toMatchObject({
      contact_id: CONTACT_ID,
      content: 'Called the member, left a voicemail.',
      location_id: LOC_ID,
    })

    // Fire-and-forget push runs in a dynamic-import .then() (a microtask that
    // resolves after the response returns) — wait for it to land.
    await vi.waitFor(() => expect(pushNoteToGlofox).toHaveBeenCalledTimes(1))
    expect(pushNoteToGlofox.mock.calls[0][1]).toMatchObject({
      contactId: CONTACT_ID,
      sourceTable: 'notes',
      sourceId: 'note1',
      type: 'NOTE',
      authorName: 'Sam Staff',
      content: 'Called the member, left a voicemail.',
    })
  })

  it('returns 403 when the caller lacks the contacts permission', async () => {
    hasPermission.mockReturnValue(false)
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ content: 'Hi' }), props)
    expect(res.status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
    expect(pushNoteToGlofox).not.toHaveBeenCalled()
  })

  it('returns 404 when the contact is outside the caller\'s location', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy, CONTACT_OUT))

    const res = await POST(postReq({ content: 'Hi' }), props)
    expect(res.status).toBe(404)
    expect(insertSpy).not.toHaveBeenCalled()
    expect(pushNoteToGlofox).not.toHaveBeenCalled()
  })

  it('rejects empty / whitespace-only content with 400', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ content: '   ' }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
    expect(pushNoteToGlofox).not.toHaveBeenCalled()
  })
})
