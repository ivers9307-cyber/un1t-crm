// ROSTER-FIX.4 — POST /api/schedule/rosters/[id]/reject.
//
// D5: rejecting a draft roster DELETES the draft row. The blocks in the
// period were never tagged with it (tagging only happens on publish), so
// nothing else references the row and there is no status to invent.
//
// The gate is the same one approve uses — hasPermissionForLocation with
// APPROVAL_CATEGORY_PERMISSION.rosters — because approving and rejecting
// are the same decision with opposite signs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({ notifyUsersOnce: vi.fn(() => Promise.resolve()) }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { notifyUsersOnce } = await import('@/lib/push-dedup')
const { POST } = await import('./route.js')

const PROPS = { params: Promise.resolve({ id: 'roster-1' }) }

function req(body) {
  return { json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)) }
}

function draft(overrides = {}) {
  return {
    id: 'roster-1',
    location_id: 'loc-1',
    status: 'draft',
    period_start: '2026-05-04',
    period_end: '2026-05-10',
    created_by: 'manager-1',
    ...overrides,
  }
}

function buildDb({ roster, deleteError = null }) {
  const deleteSpy = vi.fn()
  const db = {
    from: (t) => {
      if (t !== 'rosters') throw new Error(t)
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: roster, error: null }) }) }),
        delete: () => ({
          eq: (col, val) => {
            deleteSpy({ col, val })
            return Promise.resolve({ error: deleteError })
          },
        }),
      }
    },
  }
  return { db, deleteSpy }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  hasPermissionForLocation.mockReset()
  hasPermissionForLocation.mockReturnValue(true)
  notifyUsersOnce.mockClear()
})

describe('POST /api/schedule/rosters/[id]/reject', () => {
  it('rejects a draft → 200, deletes the row, notifies the submitter', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner' })
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ note: 'Trim Saturday' }), PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(deleteSpy).toHaveBeenCalledWith({ col: 'id', val: 'roster-1' })
    expect(notifyUsersOnce).toHaveBeenCalledTimes(1)
    const [, eventKey, recipients, payload] = notifyUsersOnce.mock.calls[0]
    expect(eventKey).toBe('roster_rejected:roster-1')
    expect(recipients).toEqual(['manager-1'])
    expect(payload.body).toContain('Trim Saturday')
  })

  it('rejects with no body at all → still 200 (the note is optional)', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner' })
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(undefined), PROPS)
    expect(res.status).toBe(200)
    expect(deleteSpy).toHaveBeenCalled()
  })

  it('a roster that is already published → 409, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner' })
    const { db, deleteSpy } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(409)
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('no rosters permission at the location → 403, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager' })
    hasPermissionForLocation.mockReturnValue(false)
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(403)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('unknown roster id → 404', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner' })
    const { db } = buildDb({ roster: null })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(404)
  })

  it('no session → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(401)
  })

  it('a failed delete surfaces as 400 and does not claim success', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner' })
    const { db } = buildDb({ roster: draft(), deleteError: { message: 'fk violation' } })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(400)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
})
