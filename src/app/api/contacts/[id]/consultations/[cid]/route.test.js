// Tests for PUT/DELETE /api/contacts/[id]/consultations/[cid] (CONSULTATIONS SP1)
//
// Coverage:
//   - PUT updates a consultation and returns the updated row
//   - DELETE removes the consultation
//   - PUT/DELETE without consultations permission → 403
//   - PUT/DELETE missing contact → 404

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

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID     = 'a0000000-0000-0000-0000-000000000001'
const USER_ID        = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID         = 'c0000000-0000-0000-0000-000000000003'
const CONSULTATION_ID = 'f0000000-0000-0000-0000-000000000006'

const CONTACT = { id: CONTACT_ID, location_id: LOC_ID }
const OWNER   = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function mockUpdateResult(updatedRow) {
  const updateSpy = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: updatedRow, error: null })),
        })),
      })),
    })),
  }))

  return {
    db: {
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
          return { update: updateSpy }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    },
    updateSpy,
  }
}

function mockDeleteOk() {
  const deleteSpy = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
    })),
  }))

  return {
    db: {
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
          return { delete: deleteSpy }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    },
    deleteSpy,
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

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/consultations/${CONSULTATION_ID}`

function putReq(body = { notes: 'Updated notes' }) {
  return new Request(BASE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteReq() {
  return new Request(BASE_URL, { method: 'DELETE' })
}

const props = { params: { id: CONTACT_ID, cid: CONSULTATION_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PUT /api/contacts/[id]/consultations/[cid]', () => {
  it('updates a consultation and returns the updated row', async () => {
    const updatedRow = { id: CONSULTATION_ID, contact_id: CONTACT_ID, notes: 'Updated notes' }
    const { db, updateSpy } = mockUpdateResult(updatedRow)
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.notes).toBe('Updated notes')
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      notes: 'Updated notes',
      updated_at: expect.any(String),
    }))
  })

  it('updates consulted_at when provided', async () => {
    let capturedUpdates = null
    const db = {
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
          return {
            update: vi.fn((updates) => {
              capturedUpdates = updates
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      single: vi.fn(() => Promise.resolve({
                        data: { id: CONSULTATION_ID, ...updates },
                        error: null,
                      })),
                    })),
                  })),
                })),
              }
            }),
          }
        }
        throw new Error(`unexpected table: ${table}`)
      }),
    }
    createServerClient.mockReturnValue(db)

    await PUT(putReq({ consulted_at: '2026-06-15T09:00:00Z' }), props)
    expect(capturedUpdates.consulted_at).toBe('2026-06-15T09:00:00Z')
  })

  it('returns 403 when user lacks consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const { db } = mockUpdateResult({ id: CONSULTATION_ID })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq(), props)
    expect(res.status).toBe(403)
  })

  it('returns 404 when contact does not exist', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await PUT(putReq(), props)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/contacts/[id]/consultations/[cid]', () => {
  it('deletes the consultation and returns success', async () => {
    const { db, deleteSpy } = mockDeleteOk()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(deleteSpy).toHaveBeenCalled()
  })

  it('returns 403 when user lacks consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const { db } = mockDeleteOk()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(403)
  })

  it('returns 404 when contact does not exist', async () => {
    createServerClient.mockReturnValue(mockDbMissing())

    const res = await DELETE(deleteReq(), props)
    expect(res.status).toBe(404)
  })
})
