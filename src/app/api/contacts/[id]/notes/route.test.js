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

vi.mock('@/lib/permissions', () => {
  // ROLESWEEP.1c — the route asks the any-location pre-check and the
  // at-the-target decision; both follow this file's switch below.
  const hasPermission = vi.fn(() => true)
  return {
    hasPermission,
    hasPermissionAtAnyLocation: (u, k) => hasPermission(u, k),
    hasPermissionForLocation: (u, _loc, k) => hasPermission(u, k),
  }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Mock the push so the test never actually attempts a Glofox call.
vi.mock('@/lib/glofox-note-push', () => ({
  pushNoteToGlofox: vi.fn(() => Promise.resolve({ pushed: false })),
}))

// CARDLENS.5 — a note for another of the person's studios asks contact_studios.
vi.mock('@/lib/contact-studios', () => ({ hasRelationshipAt: vi.fn(async () => ({ ok: true, at: new Set() })) }))

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
      if (table === 'locations') {
        // CARDLENS.11 — resolveRouteStudio checks the studio is open.
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { active: true, is_host_anchor: false }, error: null }) }
        return chain
      }
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

// CARDLENS.5 — a note filed at the acting studio.
describe('POST /api/contacts/[id]/notes — location_id (acting studio)', () => {
  const HATCH_STAFF = { ...STAFF, locations: [{ id: OTHER_LOC }] }

  it('files the note at the chosen studio and does not copy it to Glofox', async () => {
    const { hasRelationshipAt } = await import('@/lib/contact-studios')
    hasRelationshipAt.mockResolvedValueOnce({ ok: true, at: new Set([OTHER_LOC]) })
    getCurrentUser.mockResolvedValue(HATCH_STAFF)
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ content: 'Asked about Friday evenings.', location_id: OTHER_LOC }), props)
    expect(res.status).toBe(200)
    expect(insertSpy.captured().location_id).toBe(OTHER_LOC)
    await new Promise((r) => setTimeout(r, 0))
    expect(pushNoteToGlofox).not.toHaveBeenCalled()
  })

  it('a studio the person has no row at is a 404 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(HATCH_STAFF)
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))
    const res = await POST(postReq({ content: 'x', location_id: OTHER_LOC }), props)
    expect(res.status).toBe(404)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('a non-member sending invalid content still gets 404, never a 400 that confirms the contact', async () => {
    getCurrentUser.mockResolvedValue(HATCH_STAFF)
    createServerClient.mockReturnValue(makeDb(echoInsert()))
    const res = await POST(postReq({ content: '   ' }), props)
    expect(res.status).toBe(404)
  })
})
