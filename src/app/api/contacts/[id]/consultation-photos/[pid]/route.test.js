// Tests for DELETE /api/contacts/[id]/consultation-photos/[pid] (CONSULTATIONS SP1)
//
// Coverage:
//   - DELETE → removes the storage object and the DB row; returns 200
//   - DELETE → 404 when the photo isn't found for that contact
//   - DELETE → 403 without consultations permission
//   - DELETE → 404 when the contact doesn't exist for this (photo_id, contact_id) pair

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

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const PHOTO_ID   = 'd0000000-0000-0000-0000-000000000004'
const STORAGE    = `consultations/${CONTACT_ID}/uuid.jpg`

const PHOTO = {
  id:           PHOTO_ID,
  contact_id:   CONTACT_ID,
  location_id:  LOC_ID,
  storage_path: STORAGE,
}
const OWNER = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function makeDb({ photoFound = true, deleteErr = null } = {}) {
  const removeSpy = vi.fn(() => Promise.resolve({ error: null }))
  const deleteSpy = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve({ error: deleteErr })),
  }))

  // Build a chainable eq().eq().single() mock for the SELECT query
  const singleSpy = vi.fn(() =>
    Promise.resolve(
      photoFound
        ? { data: PHOTO, error: null }
        : { data: null, error: { message: 'not found' } }
    )
  )
  const innerEqSpy  = vi.fn(() => ({ single: singleSpy }))
  const outerEqSpy  = vi.fn(() => ({ eq: innerEqSpy }))
  const selectSpy   = vi.fn(() => ({ eq: outerEqSpy }))

  const db = {
    from: vi.fn((table) => {
      if (table === 'consultation_photos') {
        return {
          select: selectSpy,
          delete: deleteSpy,
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
    storage: {
      from: vi.fn(() => ({
        remove: removeSpy,
      })),
    },
  }

  return { db, removeSpy, deleteSpy, selectSpy }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/consultation-photos/${PHOTO_ID}`
const req = new Request(BASE_URL, { method: 'DELETE' })
const props = { params: { id: CONTACT_ID, pid: PHOTO_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DELETE /api/contacts/[id]/consultation-photos/[pid]', () => {
  it('removes the storage object and the DB row, returns success', async () => {
    const { db, removeSpy, deleteSpy } = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req, props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    // Storage remove was called with the correct path
    expect(removeSpy).toHaveBeenCalledOnce()
    expect(removeSpy).toHaveBeenCalledWith([STORAGE])

    // DB delete was called
    expect(deleteSpy).toHaveBeenCalledOnce()
  })

  it('returns 404 when the photo is not found for the given contact', async () => {
    const { db, removeSpy } = makeDb({ photoFound: false })
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req, props)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/not found/i)

    // Storage remove must NOT have been called
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('returns 403 without consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const { db } = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req, props)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
  })

  it('still returns success even when the storage remove call fails (best-effort)', async () => {
    // Override the remove spy to throw so we exercise the swallow
    const throwingSpy = vi.fn(() => { throw new Error('storage error') })
    const deleteSpy = vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
    }))
    const singleSpy = vi.fn(() => Promise.resolve({ data: PHOTO, error: null }))
    const db = {
      from: vi.fn((table) => {
        if (table === 'consultation_photos') {
          return {
            select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: singleSpy })) })) })),
            delete: deleteSpy,
          }
        }
        throw new Error(`unexpected: ${table}`)
      }),
      storage: {
        from: vi.fn(() => ({ remove: throwingSpy })),
      },
    }
    createServerClient.mockReturnValue(db)

    const res = await DELETE(req, props)
    // The route swallows the storage error and proceeds
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    // DB delete was still called
    expect(deleteSpy).toHaveBeenCalledOnce()
  })
})
