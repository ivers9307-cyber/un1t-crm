// ROSTER-FIX.1 (D4) — route-level contract test for
// PUT /api/schedule/swaps/[id], the approved-DROP path.
//
// A drop DELETES the requester's shift_assignments row. Under mig 237's
// `requester_shift_id ... ON DELETE CASCADE` that took this swap row with it,
// so the audit row and the swap-row stamp both had to happen BEFORE the
// delete. ROSTER-FIX.8a's mig 603 makes the FK ON DELETE SET NULL, so the
// swap row now survives either order — the ordering is kept (the embed still
// has to be read before the assignment goes) and these tests still lock it,
// along with the roster_change_log payload.
//
// Supabase + auth + push are mocked (the mock pattern is the one in
// src/app/api/schedule/blocks/[id]/assignments/route.test.js); the swap
// resolver itself is real, so the drop branch is exercised for real.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({
  sendPushOnce: vi.fn().mockResolvedValue(undefined),
  sendPushToRolesAtLocationOnce: vi.fn().mockResolvedValue(undefined),
  notifyUsersOnce: vi.fn().mockResolvedValue(undefined),
  notifyUsersAtRolesOnce: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn().mockResolvedValue({ logged: true }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logRosterChange } = await import('@/lib/roster-change-log')
const { logWarn } = await import('@/lib/log')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { PUT } = await import('./route.js')

// The notification fan-out is fire-and-forget, so let it settle before
// asserting on the spies.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const MANAGER = { id: 'mgr-1', role: 'manager', full_name: 'Manny Manager' }
const REQUESTER = 'coach-1'
const PROPS = { params: Promise.resolve({ id: 'swap-1' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// A drop swap: no target_shift_id and no target_id, so the resolver's
// approve branch returns assignmentOps: [{ id, delete: true }].
function dropSwap(rosterStatus = 'published') {
  return {
    id: 'swap-1',
    status: 'pending',
    location_id: 'loc-1',
    requester_id: REQUESTER,
    requester_shift_id: 'assign-1',
    target_shift_id: null,
    target_id: null,
    requester_shift: {
      id: 'assign-1',
      profile_id: REQUESTER,
      block_id: 'block-1',
      block: {
        id: 'block-1',
        location_id: 'loc-1',
        block_date: '2026-06-10',
        rosters: rosterStatus ? { status: rosterStatus } : null,
      },
    },
    target_shift: null,
  }
}

// Records every write in `calls` so a test can assert the ordering the
// CASCADE forces on us. `deleteErr` fails the assignment delete, which is the
// partial state the ordering makes possible.
function buildDb(swap, calls, deleteErr = null) {
  return {
    from: (table) => {
      if (table === 'shift_swap_requests') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: swap, error: null }) }),
          }),
          update: (patch) => ({
            eq: () => ({
              select: () => ({
                single: () => {
                  calls.push('swap_update')
                  return Promise.resolve({ data: { ...swap, ...patch }, error: null })
                },
              }),
            }),
          }),
        }
      }
      if (table === 'shift_assignments') {
        return {
          delete: () => ({
            eq: (col, val) => {
              calls.push(`assignment_delete:${col}=${val}`)
              return Promise.resolve({ error: deleteErr })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  logRosterChange.mockClear()
  logRosterChange.mockResolvedValue({ logged: true })
  logWarn.mockClear()
  notifyUsersOnce.mockClear()
  notifyUsersAtRolesOnce.mockClear()
})

describe('PUT /api/schedule/swaps/[id] — approved drop audit', () => {
  it('writes one roster_change_log row for the dropped shift', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), calls))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)

    expect(logRosterChange).toHaveBeenCalledTimes(1)
    const [, change] = logRosterChange.mock.calls[0]
    expect(change.action).toBe('unassigned')
    expect(change.coachId).toBe(REQUESTER)
    expect(change.actorId).toBe(MANAGER.id)
    expect(change.locationId).toBe('loc-1')
    expect(change.blockId).toBe('block-1')
    expect(change.blockDate).toBe('2026-06-10')
    expect(change.details.via).toBe('swap_drop')
    expect(change.details.swap_id).toBe('swap-1')
  })

  it('stamps the swap row, then audits, then deletes the assignment', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), calls))
    logRosterChange.mockImplementation(async () => { calls.push('roster_change_log'); return { logged: true } })

    await PUT(req({ status: 'approved' }), PROPS)

    expect(calls).toEqual(['swap_update', 'roster_change_log', 'assignment_delete:id=assign-1'])
  })

  it('audits a drop on a DRAFT roster too, recording the real roster status', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(dropSwap('draft'), calls))

    await PUT(req({ status: 'approved' }), PROPS)

    expect(logRosterChange).toHaveBeenCalledTimes(1)
    const [, change] = logRosterChange.mock.calls[0]
    // isPublished is forced true: logRosterChange would otherwise no-op on a
    // draft, and a DELETE leaves no other trace that the shift existed.
    expect(change.isPublished).toBe(true)
    expect(change.details.roster_status).toBe('draft')
  })

  // ROSTER-FIX.1 — the ordering the CASCADE forces makes this partial state
  // reachable: swap approved, change-log row written, assignment still there.
  // Nothing retries it, so the audit row is wrong until someone looks.
  it('logs a warning when the delete fails after the swap is approved and the change logged', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), calls, { message: 'delete blew up' }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe('delete blew up')

    // The swap row was already stamped and the drop already audited — that is
    // exactly why the warning has to exist.
    expect(calls).toContain('swap_update')
    expect(logRosterChange).toHaveBeenCalledTimes(1)

    expect(logWarn).toHaveBeenCalledTimes(1)
    const [module, message, meta] = logWarn.mock.calls[0]
    expect(module).toBe('swaps')
    expect(message).toMatch(/assignment delete failed after swap approved/)
    expect(meta).toEqual({ swapId: 'swap-1', assignmentId: 'assign-1', err: 'delete blew up' })
  })

  it('does not warn when the delete succeeds', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), []))

    await PUT(req({ status: 'approved' }), PROPS)
    expect(logWarn).not.toHaveBeenCalled()
  })
})

// ROSTER-FIX.8d — every swap notification here was a bare push, so a coach or
// manager without the app installed was told nothing about a request that
// needs their answer. These pin the switch to notifyUsersOnce /
// notifyUsersAtRolesOnce (push + registry-gated email fallback).
describe('PUT /api/schedule/swaps/[id] — notifications reach people without the app', () => {
  const COACH = { id: 'coach-2', role: 'staff', full_name: 'Cora Coach' }

  it('a claim notifies the requester and the managers through the fallback senders', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), []))

    const res = await PUT(req({ status: 'awaiting_approval' }), PROPS)
    expect(res.status).toBe(200)
    await flush()

    const claim = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_claimed:'))
    expect(claim).toBeTruthy()
    expect(claim[2]).toEqual([REQUESTER])
    expect(claim[3].category).toBe('swap')
    expect(claim[3].emailSubject).toBeTruthy()

    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [, key, locationId, roles, payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(key).toBe(`swap_awaiting:swap-1:${COACH.id}`)
    expect(locationId).toBe('loc-1')
    expect(roles).toContain('manager')
    expect(payload.category).toBe('swap')
    expect(payload.emailSubject).toBeTruthy()
  })

  it('an approved drop tells the requester, with an email subject', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), []))

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    const decision = notifyUsersOnce.mock.calls.find(c => c[1].startsWith('swap_decision:'))
    expect(decision).toBeTruthy()
    expect(decision[1]).toBe('swap_decision:swap-1:approved')
    expect(decision[2]).toEqual([REQUESTER])
    expect(decision[3].category).toBe('swap')
    expect(decision[3].emailSubject).toBeTruthy()
  })
})
