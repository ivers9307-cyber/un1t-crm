// Tests for POST /api/contacts/[id]/kudos (COACH KUDOS)
//
// Coverage:
//   - creates a kudo stamping contact_id, location_id, sender_profile_id,
//     sender_name (denormalised from the caller's full_name)
//   - empty / whitespace-only message → 400 (Zod)
//   - message > 500 chars → 400 (Zod)
//   - staff can't kudos a member outside their location → 404 (location scope)
//   - missing `consultations` permission → 403
//   - missing contact → 404
//   - emoji + session_id passed through; emoji defaults to null

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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const OTHER_LOC  = 'd0000000-0000-0000-0000-000000000004'
const SESSION_ID = 'e0000000-0000-0000-0000-000000000005'

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
// Contact in a location the caller does NOT belong to.
const CONTACT_OUT = { id: CONTACT_ID, location_id: OTHER_LOC }
const COACH = { id: USER_ID, role: 'head_coach', full_name: 'Coach Casey', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

// Default seeded session: belongs to the recipient, same location — a valid
// session_id link. Pass `session: null` to model "not found", or a row with a
// different contact_id/location_id to model the mismatch cases.
const SESSION = { id: SESSION_ID, contact_id: CONTACT_ID, location_id: LOC_ID }

function makeDb(insertSpy, contact = CONTACT, session = SESSION) {
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
      if (table === 'heart_rate_sessions') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: session, error: null })),
            })),
          })),
        }
      }
      if (table === 'coach_kudos') {
        return { insert: insertSpy }
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

// insert spy that echoes the payload back as the created row.
function echoInsert() {
  let captured = null
  const spy = vi.fn((payload) => {
    captured = payload
    return {
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({ data: { id: 'kudo1', ...payload }, error: null })),
      })),
    }
  })
  spy.captured = () => captured
  return spy
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/kudos`

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
  getCurrentUser.mockResolvedValue(COACH)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/kudos', () => {
  it('creates a kudo stamping contact_id, location_id, sender_profile_id, and sender_name', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: 'Great session today!' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.contact_id).toBe(CONTACT_ID)
    expect(json.data.location_id).toBe(LOC_ID)

    const payload = insertSpy.captured()
    expect(payload).toMatchObject({
      contact_id: CONTACT_ID,
      location_id: LOC_ID,
      sender_profile_id: USER_ID,
      sender_name: 'Coach Casey',
      message: 'Great session today!',
      emoji: null,
      session_id: null,
    })
  })

  it('falls back to a neutral sender_name when the profile has no full_name', async () => {
    getCurrentUser.mockResolvedValue({ ...COACH, full_name: null })
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq({ message: 'Nice work' }), props)
    expect(insertSpy.captured().sender_name).toBe('Your coach')
  })

  it('passes emoji and a VALID session_id (recipient\'s own, in-location) through', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq({ message: 'Fire!', emoji: '🔥', session_id: SESSION_ID }), props)
    const payload = insertSpy.captured()
    expect(payload.emoji).toBe('🔥')
    expect(payload.session_id).toBe(SESSION_ID)
  })

  it('rejects a session_id belonging to ANOTHER member with 400 (re-audit)', async () => {
    const insertSpy = vi.fn()
    const otherMembersSession = { id: SESSION_ID, contact_id: 'f0000000-0000-0000-0000-000000000009', location_id: LOC_ID }
    createServerClient.mockReturnValue(makeDb(insertSpy, CONTACT, otherMembersSession))

    const res = await POST(postReq({ message: 'Hi', session_id: SESSION_ID }), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/does not belong/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects a session_id from another location with 400', async () => {
    const insertSpy = vi.fn()
    const otherLocSession = { id: SESSION_ID, contact_id: CONTACT_ID, location_id: OTHER_LOC }
    createServerClient.mockReturnValue(makeDb(insertSpy, CONTACT, otherLocSession))

    const res = await POST(postReq({ message: 'Hi', session_id: SESSION_ID }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects a nonexistent session_id with 400', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy, CONTACT, null))

    const res = await POST(postReq({ message: 'Hi', session_id: SESSION_ID }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('never returns the raw DB error message on insert failure', async () => {
    const failingInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "secret_internal_idx"' } })),
      })),
    }))
    createServerClient.mockReturnValue(makeDb(failingInsert))

    const res = await POST(postReq({ message: 'Hi' }), props)
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Could not send kudos')
    expect(JSON.stringify(json)).not.toContain('secret_internal_idx')
  })

  it('trims the message before insert', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq({ message: '   padded message   ' }), props)
    expect(insertSpy.captured().message).toBe('padded message')
  })

  it('rejects an empty message with 400', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: '' }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only message with 400', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: '     ' }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('rejects a message longer than 500 chars with 400', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: 'x'.repeat(501) }), props)
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('accepts a message of exactly 500 chars', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: 'x'.repeat(500) }), props)
    expect(res.status).toBe(200)
    expect(insertSpy.captured().message.length).toBe(500)
  })

  it('returns 404 when the member is outside the caller\'s location', async () => {
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy, CONTACT_OUT))

    const res = await POST(postReq({ message: 'Hi' }), props)
    expect(res.status).toBe(404)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller lacks the consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ message: 'Hi' }), props)
    expect(res.status).toBe(403)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb(vi.fn()))

    const res = await POST(postReq({ message: 'Hi' }), props)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the contact does not exist', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await POST(postReq({ message: 'Hi' }), props)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/not found/i)
  })
})
