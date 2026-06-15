// Tests for PUT/DELETE /api/contacts/[id]/goals/[gid] (CONSULTATIONS SP1)
//
// Coverage:
//   - PUT updates a goal; returns updated row
//   - PUT status='achieved' stamps achieved_at
//   - PUT status='open' clears achieved_at
//   - DELETE removes the goal
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

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const GOAL_ID    = 'd0000000-0000-0000-0000-000000000004'

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
        if (table === 'contact_goals') {
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
        if (table === 'contact_goals') {
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

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/goals/${GOAL_ID}`

function putReq(body = { title: 'Updated goal' }) {
  return new Request(BASE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteReq() {
  return new Request(BASE_URL, { method: 'DELETE' })
}

const props = { params: { id: CONTACT_ID, gid: GOAL_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(OWNER)
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PUT /api/contacts/[id]/goals/[gid]', () => {
  it('updates a goal and returns the updated row', async () => {
    const updatedRow = { id: GOAL_ID, contact_id: CONTACT_ID, title: 'Updated goal', status: 'open' }
    const { db } = mockUpdateResult(updatedRow)
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq(), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.title).toBe('Updated goal')
  })

  it('stamps achieved_at when status is set to achieved', async () => {
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
        if (table === 'contact_goals') {
          return {
            update: vi.fn((updates) => {
              capturedUpdates = updates
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      single: vi.fn(() => Promise.resolve({
                        data: { id: GOAL_ID, status: 'achieved', achieved_at: updates.achieved_at },
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

    const res = await PUT(putReq({ status: 'achieved' }), props)
    expect(res.status).toBe(200)
    expect(capturedUpdates).not.toBeNull()
    expect(capturedUpdates.status).toBe('achieved')
    expect(capturedUpdates.achieved_at).toBeTruthy()
    // Should be a parseable ISO string
    expect(new Date(capturedUpdates.achieved_at).getFullYear()).toBeGreaterThan(2020)
  })

  it('clears achieved_at when status is set to a non-achieved value', async () => {
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
        if (table === 'contact_goals') {
          return {
            update: vi.fn((updates) => {
              capturedUpdates = updates
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      single: vi.fn(() => Promise.resolve({
                        data: { id: GOAL_ID, status: 'open', achieved_at: null },
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

    const res = await PUT(putReq({ status: 'open' }), props)
    expect(res.status).toBe(200)
    expect(capturedUpdates.status).toBe('open')
    expect(capturedUpdates.achieved_at).toBeNull()
  })

  it('returns 403 when user lacks consultations permission', async () => {
    hasPermission.mockReturnValue(false)
    const { db } = mockUpdateResult({ id: GOAL_ID })
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

describe('DELETE /api/contacts/[id]/goals/[gid]', () => {
  it('deletes the goal and returns success', async () => {
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
