// ROSTER-FIX.4 — POST /api/schedule/rosters/[id]/approve.
//
// Approving IS publishing: the flip to status='published' is followed by the
// same block tagging POST /api/schedule/rosters does. So it has to run the
// same overlap guard. A draft can sit in the approvals queue for days while
// somebody publishes a roster over the same dates; approving it then created
// exactly the two-published-rosters-over-one-day state the POST guard exists
// to prevent, and the block tagging silently stole the other roster's days.
//
// The permission check also moved ABOVE the draft/published branch (reject
// already did it that way): under it, a caller with no rosters permission got
// a 409 naming the roster's status on a non-draft and a 403 otherwise, which
// answered "is this id a draft awaiting approval?" for anyone with an id.
//
// The guard itself (which overlaps are legitimate) is unit-tested in
// src/lib/roster-publish.test.js; these tests run the REAL helper so the
// wiring — including excludeRosterId — is what is under test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// getUserLocationIds is the real one-liner from @/lib/auth — mocking it away
// would make the cross-tenant 404 untestable, which is the point of it.
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (user) => (user?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/roster-notify', () => ({
  notifyStaffOfPublish: vi.fn(() => Promise.resolve()),
  publishNotifyRowsForBlocks: vi.fn(() => Promise.resolve([])),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { notifyStaffOfPublish } = await import('@/lib/roster-notify')
const { POST } = await import('./route.js')

const PROPS = { params: Promise.resolve({ id: 'roster-1' }) }

function draft(overrides = {}) {
  return {
    id: 'roster-1',
    location_id: 'loc-1',
    status: 'draft',
    period_start: '2026-05-04',
    period_end: '2026-05-10',
    created_by: 'manager-1',
    published_by: null,
    ...overrides,
  }
}

// Per-table mock. `rosters` serves three different queries: the roster fetch
// (select('*') … .single()), the overlap probe (a narrow select that is
// awaited), and the status flip. The probe's filters are recorded so the
// self-exclusion can be asserted.
function buildDb({ roster, publishedRosters = [], updateError = null, captureError = null, tagError = null }) {
  const updates = []
  const probe = []
  const blockUpdates = []
  const db = {
    from(table) {
      if (table === 'rosters') {
        return {
          select(cols) {
            if (cols === '*') {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: roster,
                    error: roster ? null : { message: 'no rows' },
                  }),
                }),
              }
            }
            const chain = {
              eq: (c, v) => { probe.push(['eq', c, v]); return chain },
              lte: (c, v) => { probe.push(['lte', c, v]); return chain },
              gte: (c, v) => { probe.push(['gte', c, v]); return chain },
              neq: (c, v) => { probe.push(['neq', c, v]); return chain },
              then: (onF, onR) => Promise.resolve({ data: publishedRosters, error: null }).then(onF, onR),
            }
            return chain
          },
          update(payload) {
            updates.push(payload)
            return {
              eq: () => ({
                select: () => ({
                  single: () => Promise.resolve({
                    data: updateError ? null : { ...roster, ...payload },
                    error: updateError,
                  }),
                }),
              }),
            }
          },
        }
      }
      if (table === 'shift_blocks') {
        // One builder serves both shift_blocks queries — the newly-published
        // capture (a select) and the tagging (an update) — so the resolved
        // error has to follow whichever one this chain turned into.
        let isUpdate = false
        const chain = {
          select: () => chain,
          update: (payload) => { isUpdate = true; blockUpdates.push(payload); return chain },
          eq: () => chain,
          gte: () => chain,
          lte: () => chain,
          is: () => chain,
          then: (onF, onR) => Promise.resolve(
            isUpdate ? { data: null, error: tagError } : { data: [], error: captureError },
          ).then(onF, onR),
        }
        return chain
      }
      throw new Error('unexpected table: ' + table)
    },
  }
  return { db, updates, probe, blockUpdates }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  hasPermissionForLocation.mockReset()
  hasPermissionForLocation.mockReturnValue(true)
  notifyStaffOfPublish.mockClear()
  getCurrentUser.mockResolvedValue({ id: 'owner-1', role: 'owner', locations: [{ id: 'loc-1' }] })
})

describe('POST /api/schedule/rosters/[id]/approve — overlap guard', () => {
  it('refuses a draft week that sits INSIDE a since-published month, changing nothing', async () => {
    const month = { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }
    const { db, updates, blockUpdates } = buildDb({ roster: draft(), publishedRosters: [month] })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    const body = await res.json()
    // Same shape the publish route returns, so the modal renders one thing.
    expect(body.error).toBe('overlapping_roster')
    expect(body.overlapping).toEqual([month])
    expect(updates).toHaveLength(0)
    expect(blockUpdates).toHaveLength(0)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })

  it('refuses a draft that only straddles the edge of a published period', async () => {
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('approves a draft that CONTAINS the published roster — the wider one takes over', async () => {
    const { db, updates } = buildDb({
      roster: draft({ period_start: '2026-05-01', period_end: '2026-05-31' }),
      publishedRosters: [{ id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('published')
  })

  it('approves normally when nothing overlaps, and excludes the draft from its own guard', async () => {
    const { db, updates, probe } = buildDb({ roster: draft(), publishedRosters: [] })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates[0]).toMatchObject({ status: 'published', over_budget_approval_by: 'owner-1' })
    // Without this the roster would collide with itself the moment the check
    // ever ran against a row that is already published.
    expect(probe).toContainEqual(['neq', 'id', 'roster-1'])
    expect(probe).toContainEqual(['eq', 'status', 'published'])
    expect(probe).toContainEqual(['eq', 'location_id', 'loc-1'])
  })
})

describe('POST /api/schedule/rosters/[id]/approve — gate ordering', () => {
  it('checks permission BEFORE the draft/published branch: a published roster gives 403, not 409', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager', locations: [{ id: 'loc-1' }] })
    hasPermissionForLocation.mockReturnValue(false)
    const { db, updates } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    // 409 here would leak that this id exists and what state it is in.
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('checks permission BEFORE the overlap branch too: a conflicting draft gives 403', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    const { db, updates } = buildDb({
      roster: draft(),
      publishedRosters: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('a permitted caller on an already-published roster still gets the 409', async () => {
    const { db, updates } = buildDb({ roster: draft({ status: 'published' }) })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already published/)
    expect(updates).toHaveLength(0)
  })

  it('unknown roster id → 404', async () => {
    const { db } = buildDb({ roster: null })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(404)
  })

  it('no session → 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(401)
  })

  it('a failed status flip surfaces as 400 and never notifies staff', async () => {
    const { db } = buildDb({ roster: draft(), updateError: { message: 'constraint violation' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(400)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })
})

describe('POST /api/schedule/rosters/[id]/approve — cross-tenant posture', () => {
  it('a caller at another location gets 404, not 403: the id must look missing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-3', role: 'manager', locations: [{ id: 'loc-2' }] })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Roster not found')
    expect(updates).toHaveLength(0)
    // The location check runs FIRST — a permission answer would already be
    // an answer about a roster the caller may not know exists.
    expect(hasPermissionForLocation).not.toHaveBeenCalled()
  })

  it('master is not location-scoped and still approves', async () => {
    getCurrentUser.mockResolvedValue({ id: 'master-1', role: 'master', locations: [] })
    const { db, updates } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    expect(updates[0].status).toBe('published')
  })

  it('an at-location caller without the rosters permission still gets 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'mgr-2', role: 'manager', locations: [{ id: 'loc-1' }] })
    hasPermissionForLocation.mockReturnValue(false)
    const { db } = buildDb({ roster: draft() })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/schedule/rosters/[id]/approve — block errors are not swallowed', () => {
  it('a failed newly-published capture still approves and still tags, but is logged', async () => {
    const { db, updates, blockUpdates } = buildDb({ roster: draft(), captureError: { message: 'read timeout' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The approval is done; only the notify set was lost.
    expect(updates[0].status).toBe('published')
    expect(blockUpdates).toHaveLength(1)
  })

  it('a failed tagging returns a partial success naming it, and notifies nobody', async () => {
    const { db, updates } = buildDb({ roster: draft(), tagError: { message: 'deadlock detected' } })
    createServerClient.mockReturnValue(db)

    const res = await POST({}, PROPS)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Same shape POST /api/schedule/rosters uses: the roster IS published,
    // so this is a warning on a success, not a failure.
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('published')
    expect(body.warning).toMatch(/block tagging failed: deadlock detected/)
    expect(updates).toHaveLength(1)
    expect(notifyStaffOfPublish).not.toHaveBeenCalled()
  })
})
