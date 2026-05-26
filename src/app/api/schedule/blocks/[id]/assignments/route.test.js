// SCHEDULE-MULTI-COACH.1 — route-level contract tests for
// POST /api/schedule/blocks/[id]/assignments.
//
// We mock Supabase + auth so the route runs in isolation. The route
// has two modes (legacy single profile_id, new profile_ids[]); the
// tests lock the per-mode response shape, the capacity / already-
// assigned skip reasons, and the auth gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, getUserLocationIds } = await import('@/lib/auth')
const { POST } = await import('./route.js')

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  getUserLocationIds.mockReset()
})

function req(body) {
  return {
    json: () => Promise.resolve(body),
    headers: { get: () => '' },
  }
}

const PROPS = { params: Promise.resolve({ id: 'block-1' }) }

// Build a Supabase mock backed by per-table behaviour. Each table
// returns a thenable chain whose terminal resolves to the canned
// value. Inserts get a spy so tests can assert call counts + the
// rows passed in.
function buildDb({
  block,
  blockErr = null,
  existingAssignedIds = [],
  timeOff = [],
  insertErrorFor = () => null, // (profileId) → error or null
}) {
  const insertSpy = vi.fn()
  return {
    insertSpy,
    db: {
      from: (table) => {
        if (table === 'shift_blocks') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: block, error: blockErr }),
              }),
            }),
          }
        }
        if (table === 'shift_assignments') {
          return {
            select: (sel) => {
              // Existing-assignees lookup (early in the route).
              if (sel === 'profile_id') {
                return {
                  eq: () => Promise.resolve({
                    data: existingAssignedIds.map((id) => ({ profile_id: id })),
                    error: null,
                  }),
                }
              }
              // The post-insert .select() — shouldn't be called this way.
              throw new Error(`unexpected shift_assignments.select(${sel})`)
            },
            insert: (row) => {
              insertSpy(row)
              const err = insertErrorFor(row.profile_id)
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: err ? null : { id: `assign-${row.profile_id}`, ...row },
                    error: err,
                  }),
                }),
              }
            },
          }
        }
        if (table === 'time_off_requests') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  lte: () => ({
                    gte: () => Promise.resolve({ data: timeOff, error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    },
  }
}

const MASTER = { id: 'u1', role: 'master' }
const STAFF = { id: 'u2', role: 'staff' }

describe('POST /api/schedule/blocks/[id]/assignments — auth + validation', () => {
  it('403 when no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(403)
  })

  it('403 when caller is not a manager', async () => {
    getCurrentUser.mockResolvedValue(STAFF)
    const res = await POST(req({ profile_id: '11111111-1111-1111-1111-111111111111' }), PROPS)
    expect(res.status).toBe(403)
  })

  it('400 when both profile_id and profile_ids are sent', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({
      profile_id: '11111111-1111-1111-1111-111111111111',
      profile_ids: ['22222222-2222-2222-2222-222222222222'],
    }), PROPS)
    expect(res.status).toBe(400)
  })

  it('400 when neither profile_id nor profile_ids is sent', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(req({}), PROPS)
    expect(res.status).toBe(400)
  })
})

describe('POST — multi-coach (profile_ids)', () => {
  it('assigns every coach when there is capacity', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 0 }] },
    })
    createServerClient.mockReturnValue(db)

    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc']
    const res = await POST(req({ profile_ids: ids }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.assigned).toHaveLength(3)
    expect(json.skipped).toEqual([])
    expect(insertSpy).toHaveBeenCalledTimes(3)
  })

  it('skips coaches beyond capacity (at_capacity)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      // max=3, currently 1 → 2 slots open.
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 3, shift_assignments: [{ count: 1 }] },
    })
    createServerClient.mockReturnValue(db)

    const ids = [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cccccccc-cccc-cccc-cccc-cccccccccccc', // overflow
      'dddddddd-dddd-dddd-dddd-dddddddddddd', // overflow
    ]
    const res = await POST(req({ profile_ids: ids }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(2)
    expect(json.skipped).toHaveLength(2)
    expect(json.skipped.every((s) => s.reason === 'at_capacity')).toBe(true)
  })

  it('allow_over_capacity bypasses the cap', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1, shift_assignments: [{ count: 1 }] },
    })
    createServerClient.mockReturnValue(db)

    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
    const res = await POST(req({ profile_ids: ids, allow_over_capacity: true }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(2)
    expect(json.skipped).toEqual([])
  })

  it('silently skips coaches who are already on the block', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const dupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 1 }] },
      existingAssignedIds: [dupId],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_ids: [dupId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'] }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(1)
    expect(json.skipped).toEqual([{ profile_id: dupId, reason: 'already_assigned' }])
  })

  it('dedupes a duplicated id in the request payload', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db, insertSpy } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 0 }] },
    })
    createServerClient.mockReturnValue(db)

    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const res = await POST(req({ profile_ids: [id, id, id] }), PROPS)
    const json = await res.json()
    expect(json.assigned).toHaveLength(1)
    expect(insertSpy).toHaveBeenCalledTimes(1)
  })
})

describe('POST — legacy single-coach (profile_id) response shape', () => {
  it('returns { data } on success', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 0 }] },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.data).toBeDefined()
    expect(json.assigned).toBeUndefined()
  })

  it('returns 409 with the legacy at-capacity message', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 1, shift_assignments: [{ count: 1 }] },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/at capacity/i)
  })

  it('returns 409 with the legacy already-assigned message', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const dupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const { db } = buildDb({
      block: { id: 'block-1', location_id: 'loc-1', block_date: '2026-06-01', max_coaches: 5, shift_assignments: [{ count: 1 }] },
      existingAssignedIds: [dupId],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ profile_id: dupId }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toMatch(/already assigned/i)
  })
})
