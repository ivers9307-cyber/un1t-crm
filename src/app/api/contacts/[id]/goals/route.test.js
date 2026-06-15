// Tests for POST /api/contacts/[id]/goals (CONSULTATIONS SP1)
//
// Coverage:
//   - POST creates a goal with correct fields (contact_id, location_id, created_by, title)
//   - POST without consultations permission → 403
//   - POST missing contact → 404
//   - POST with invalid body (empty title) → 400

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

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
const OWNER   = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function mockInsertResult(result = { id: 'g1', contact_id: CONTACT_ID, location_id: LOC_ID, title: 'Lose weight' }) {
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
      if (table === 'contact_goals') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: result, error: null })),
            })),
          })),
        }
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

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/goals`

function postReq(body = { title: 'Lose weight' }) {
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

describe('POST /api/contacts/[id]/goals', () => {
  it('creates a goal with correct contact_id, location_id, and created_by', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { id: 'g1', contact_id: CONTACT_ID, location_id: LOC_ID, created_by: USER_ID, title: 'Lose weight' },
          error: null,
        })),
      })),
    }))

    createServerClient.mockReturnValue({
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
        if (table === 'contact_goals') {
          return { insert: insertSpy }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    })

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
      title: 'Lose weight',
    }))
  })

  it('returns 403 when user lacks consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(mockInsertResult())

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

  it('returns 400 when title is empty string', async () => {
    createServerClient.mockReturnValue(mockInsertResult())

    const res = await POST(postReq({ title: '' }), props)
    expect(res.status).toBe(400)
  })

  it('accepts optional fields (detail, target_value, target_date)', async () => {
    const insertSpy = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(() => Promise.resolve({
          data: { id: 'g2', contact_id: CONTACT_ID, location_id: LOC_ID, title: 'Gain muscle', detail: 'Via lifting', target_value: '10kg', target_date: '2026-12-31' },
          error: null,
        })),
      })),
    }))

    createServerClient.mockReturnValue({
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
        if (table === 'contact_goals') {
          return { insert: insertSpy }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    })

    const res = await POST(postReq({
      title: 'Gain muscle',
      detail: 'Via lifting',
      target_value: '10kg',
      target_date: '2026-12-31',
    }), props)

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Gain muscle',
      detail: 'Via lifting',
      target_value: '10kg',
      target_date: '2026-12-31',
    }))
  })
})
