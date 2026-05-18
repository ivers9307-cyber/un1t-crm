// BULK-ASSIGN.1 — route-level contract tests for
// POST /api/schedule/blocks/bulk-assign.
//
// We mock the Supabase client + getCurrentUser so the route can run
// in isolation. Focus areas:
//   • skip-with-reason logic for each disposition
//     (not_found, cross_location, already_assigned, at_capacity)
//   • allow_over_capacity override
//   • happy-path multi-block insert
//   • body validation (block_ids required, max 200, profile_id UUID)
//   • manager+ gate

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

function buildRequest(body) {
  return {
    json: () => Promise.resolve(body),
    headers: { get: () => '' },
  }
}

// Mock supabase client backed by a fixture of blocks. Each insert
// returns one row per requested row (id synthesised) — that's what
// the production route does via .select() on the insert.
function buildDb({ blocks, insertError = null, timeOff = [] }) {
  return {
    from: vi.fn((table) => {
      if (table === 'shift_blocks') {
        return {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: blocks, error: null }),
        }
      }
      if (table === 'shift_assignments') {
        return {
          insert: (rows) => ({
            select: () => Promise.resolve({
              data: insertError ? null : rows.map((r, i) => ({ id: `new-${i}`, block_id: r.block_id })),
              error: insertError,
            }),
          }),
        }
      }
      if (table === 'time_off_requests') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          gte: vi.fn().mockResolvedValue({ data: timeOff, error: null }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111'
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222'
const VALID_UUID_C = '33333333-3333-4333-8333-333333333333'
const PROFILE_A    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROFILE_B    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('POST /api/schedule/blocks/bulk-assign', () => {
  describe('auth', () => {
    it('403s when no user', async () => {
      getCurrentUser.mockResolvedValue(null)
      const res = await POST(buildRequest({ block_ids: [VALID_UUID_A], profile_id: PROFILE_A }))
      expect(res.status).toBe(403)
    })

    it('403s for non-manager roles', async () => {
      getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff' })
      const res = await POST(buildRequest({ block_ids: [VALID_UUID_A], profile_id: PROFILE_A }))
      expect(res.status).toBe(403)
    })
  })

  describe('validation', () => {
    beforeEach(() => {
      getCurrentUser.mockResolvedValue({ id: 'u1', role: 'master' })
    })

    it('400s on empty block_ids array', async () => {
      const res = await POST(buildRequest({ block_ids: [], profile_id: PROFILE_A }))
      expect(res.status).toBe(400)
    })

    it('400s on missing profile_id', async () => {
      const res = await POST(buildRequest({ block_ids: [VALID_UUID_A] }))
      expect(res.status).toBe(400)
    })

    it('400s when block_ids exceeds 200', async () => {
      const big = Array.from({ length: 201 }, (_, i) => `${VALID_UUID_A.slice(0, -3)}${String(i).padStart(3, '0')}`)
      const res = await POST(buildRequest({ block_ids: big, profile_id: PROFILE_A }))
      expect(res.status).toBe(400)
    })
  })

  describe('skip-with-reason dispositions', () => {
    beforeEach(() => {
      getCurrentUser.mockResolvedValue({ id: 'u-master', role: 'master' })
      getUserLocationIds.mockReturnValue(['loc-1'])
    })

    it('reports not_found for requested ids that the DB doesn\'t return', async () => {
      createServerClient.mockReturnValue(buildDb({ blocks: [] }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A, VALID_UUID_B],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.success).toBe(true)
      expect(j.assigned).toHaveLength(0)
      expect(j.skipped).toEqual(expect.arrayContaining([
        { block_id: VALID_UUID_A, reason: 'not_found' },
        { block_id: VALID_UUID_B, reason: 'not_found' },
      ]))
    })

    it('reports cross_location when non-master user lacks location access', async () => {
      getCurrentUser.mockResolvedValue({ id: 'u-mgr', role: 'manager' })
      getUserLocationIds.mockReturnValue(['loc-allowed'])
      createServerClient.mockReturnValue(buildDb({
        blocks: [
          { id: VALID_UUID_A, location_id: 'loc-other', block_date: '2026-05-18', max_coaches: 5, shift_assignments: [] },
        ],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.skipped).toEqual([{ block_id: VALID_UUID_A, reason: 'cross_location' }])
    })

    it('master bypasses location gate', async () => {
      // Master sees all locations regardless of profile_locations rows.
      createServerClient.mockReturnValue(buildDb({
        blocks: [
          { id: VALID_UUID_A, location_id: 'loc-anywhere', block_date: '2026-05-18', max_coaches: 5, shift_assignments: [] },
        ],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.assigned).toHaveLength(1)
      expect(j.skipped).toHaveLength(0)
    })

    it('reports already_assigned when the coach is already on the block', async () => {
      createServerClient.mockReturnValue(buildDb({
        blocks: [{
          id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 5,
          shift_assignments: [{ id: 'a1', profile_id: PROFILE_A, status: 'active' }],
        }],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.skipped).toEqual([{ block_id: VALID_UUID_A, reason: 'already_assigned' }])
      expect(j.assigned).toHaveLength(0)
    })

    it('cancelled assignments do NOT count toward already_assigned', async () => {
      // Operator can re-assign a coach who was previously removed.
      createServerClient.mockReturnValue(buildDb({
        blocks: [{
          id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 5,
          shift_assignments: [{ id: 'a1', profile_id: PROFILE_A, status: 'cancelled' }],
        }],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.assigned).toHaveLength(1)
    })

    it('reports at_capacity when active assignment count meets max_coaches', async () => {
      createServerClient.mockReturnValue(buildDb({
        blocks: [{
          id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 2,
          shift_assignments: [
            { id: 'a1', profile_id: 'pX', status: 'active' },
            { id: 'a2', profile_id: 'pY', status: 'active' },
          ],
        }],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.skipped).toEqual([{ block_id: VALID_UUID_A, reason: 'at_capacity' }])
    })

    it('allow_over_capacity bypasses the capacity gate', async () => {
      createServerClient.mockReturnValue(buildDb({
        blocks: [{
          id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 1,
          shift_assignments: [{ id: 'a1', profile_id: 'pX', status: 'active' }],
        }],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A],
        profile_id: PROFILE_A,
        allow_over_capacity: true,
      }))
      const j = await res.json()
      expect(j.assigned).toHaveLength(1)
      expect(j.skipped).toHaveLength(0)
    })
  })

  describe('happy path', () => {
    beforeEach(() => {
      getCurrentUser.mockResolvedValue({ id: 'u-master', role: 'master' })
      getUserLocationIds.mockReturnValue([])
    })

    it('inserts multiple blocks + returns each assignment_id', async () => {
      createServerClient.mockReturnValue(buildDb({
        blocks: [
          { id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 5, shift_assignments: [] },
          { id: VALID_UUID_B, location_id: 'loc-1', block_date: '2026-05-19', max_coaches: 5, shift_assignments: [] },
          { id: VALID_UUID_C, location_id: 'loc-1', block_date: '2026-05-20', max_coaches: 5, shift_assignments: [] },
        ],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A, VALID_UUID_B, VALID_UUID_C],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.success).toBe(true)
      expect(j.assigned).toHaveLength(3)
      expect(j.assigned[0]).toHaveProperty('assignment_id')
      expect(j.assigned[0]).toHaveProperty('block_id')
      expect(j.skipped).toHaveLength(0)
    })

    it('mixed result reports both assigned and skipped', async () => {
      createServerClient.mockReturnValue(buildDb({
        blocks: [
          // Will assign:
          { id: VALID_UUID_A, location_id: 'loc-1', block_date: '2026-05-18', max_coaches: 5, shift_assignments: [] },
          // Already assigned — skip:
          { id: VALID_UUID_B, location_id: 'loc-1', block_date: '2026-05-19', max_coaches: 5,
            shift_assignments: [{ id: 'x', profile_id: PROFILE_A, status: 'active' }] },
          // Over capacity — skip:
          { id: VALID_UUID_C, location_id: 'loc-1', block_date: '2026-05-20', max_coaches: 1,
            shift_assignments: [{ id: 'y', profile_id: PROFILE_B, status: 'active' }] },
        ],
      }))
      const res = await POST(buildRequest({
        block_ids: [VALID_UUID_A, VALID_UUID_B, VALID_UUID_C],
        profile_id: PROFILE_A,
      }))
      const j = await res.json()
      expect(j.assigned).toHaveLength(1)
      expect(j.assigned[0].block_id).toBe(VALID_UUID_A)
      expect(j.skipped).toHaveLength(2)
      const reasons = j.skipped.map((s) => s.reason).sort()
      expect(reasons).toEqual(['already_assigned', 'at_capacity'])
    })
  })
})
