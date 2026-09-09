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
// getUserLocationIds is the real one-liner from @/lib/auth — mocking it away
// would make the cross-tenant 404 untestable, which is the point of it.
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (user) => (user?.locations || []).map((l) => l.id),
}))
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
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
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
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(undefined), PROPS)
    expect(res.status).toBe(200)
    expect(deleteSpy).toHaveBeenCalled()
  })

  it('a roster that is already published → 409, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
    const { db, deleteSpy } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(409)
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  // ROSTER-FIX.4 — the caller IS at the location, so 403 is the honest
  // answer: it says "not you", not "this roster exists".
  it('no rosters permission at the location → 403, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager', locations: [{ id: 'loc-1' }] })
    hasPermissionForLocation.mockReturnValue(false)
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(403)
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('unknown roster id → 404', async () => {
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
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
    getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
    const { db } = buildDb({ roster: draft(), deleteError: { message: 'fk violation' } })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(400)
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
})

// ROSTER-FIX.4 — reject DELETES the draft, so the id-probing question matters
// more here than anywhere: a caller at another tenant must not be able to tell
// a real roster id from a made-up one.
describe('POST /api/schedule/rosters/[id]/reject — cross-tenant posture', () => {
  it('a caller at another location gets 404, not 403, and deletes nothing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-3', role: 'manager', locations: [{ id: 'loc-2' }] })
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(404)
    const body = await res.json()
    // Byte-identical to the unknown-id answer above.
    expect(body.error).toBe('Roster not found')
    expect(deleteSpy).not.toHaveBeenCalled()
    // Location first: a permission answer is already an answer about the row.
    expect(hasPermissionForLocation).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('master is not location-scoped and still rejects', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', role: 'master', locations: [] })
    const { db, deleteSpy } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(200)
    expect(deleteSpy).toHaveBeenCalled()
  })
})
