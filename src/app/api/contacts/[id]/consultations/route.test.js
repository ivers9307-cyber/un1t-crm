// Tests for POST /api/contacts/[id]/consultations (CONSULTATIONS SP1)
//
// Coverage:
//   - POST creates a consultation with correct fields
//     (contact_id, location_id, created_by, coach_id defaults to user.id)
//   - POST with explicit coach_id uses that value
//   - POST without consultations permission → 403
//   - POST missing contact → 404

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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const COACH_ID   = 'e0000000-0000-0000-0000-000000000005'

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
const OWNER   = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function makeDb(insertSpy) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: CONTACT, error: null })),
            })),
          })),
        }
      }
      if (table === 'consultations') {
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

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/consultations`

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
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/consultations', () => {
  it('creates a consultation with correct contact_id, location_id, and created_by', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: {
            id: 'cons1',
            contact_id: CONTACT_ID,
            location_id: LOC_ID,
            created_by: USER_ID,
            coach_id: USER_ID,
          },
          error: null,
        })),
      })),
    }))
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.contact_id).toBe(CONTACT_ID)
    expect(json.data.location_id).toBe(LOC_ID)
    expect(json.data.created_by).toBe(USER_ID)

    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: CONTACT_ID,
      location_id: LOC_ID,
      created_by: USER_ID,
    }))
  })

  it('defaults coach_id to the current user when not provided', async () => {
    let capturedPayload = null
    const insertSpy = vi.fn((payload) => {
      capturedPayload = payload
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({
            data: { id: 'cons2', ...payload },
            error: null,
          })),
        })),
      }
    })
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq(), props)
    expect(capturedPayload.coach_id).toBe(USER_ID)
  })

  it('uses the provided coach_id when given', async () => {
    let capturedPayload = null
    const insertSpy = vi.fn((payload) => {
      capturedPayload = payload
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({
            data: { id: 'cons3', ...payload },
            error: null,
          })),
        })),
      }
    })
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq({ coach_id: COACH_ID }), props)
    expect(capturedPayload.coach_id).toBe(COACH_ID)
  })

  it('returns 403 when user lacks consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const insertSpy = vi.fn()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq(), props)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('returns 404 when contact does not exist', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await POST(postReq(), props)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/not found/i)
  })

  it('accepts optional consulted_at and notes fields', async () => {
    let capturedPayload = null
    const insertSpy = vi.fn((payload) => {
      capturedPayload = payload
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({
            data: { id: 'cons4', ...payload },
            error: null,
          })),
        })),
      }
    })
    createServerClient.mockReturnValue(makeDb(insertSpy))

    await POST(postReq({ consulted_at: '2026-06-15T10:00:00Z', notes: 'Discussed goals.' }), props)
    expect(capturedPayload.consulted_at).toBe('2026-06-15T10:00:00Z')
    expect(capturedPayload.notes).toBe('Discussed goals.')
  })
})
