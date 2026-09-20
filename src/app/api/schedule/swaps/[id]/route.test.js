// ROSTER-FIX.1 (D4) — route-level contract test for
// PUT /api/schedule/swaps/[id], the approved-DROP path.
//
// A drop DELETES the requester's shift_assignments row, so its audit row has
// to be written from the swap + block embed read BEFORE the delete.
// SWAPS.2 — the approval and the delete are now ONE RPC
// (approve_drop_shift_swap, mig 615), and the audit row is written only after
// it succeeds, from that in-memory read; a refused drop leaves no audit row.
//
// Supabase + auth + push are mocked (the mock pattern is the one in
// src/app/api/schedule/blocks/[id]/assignments/route.test.js); the swap
// resolver itself is real, so the drop branch is exercised for real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn((u) => (u?.locations ? u.locations.map((l) => l.id) : ['loc-1'])),
  // SCHEDROLES.1 — REAL: manager cancel / reject are judged at the swap's studio.
  hasRoleAtLocation: (await importOriginal()).hasRoleAtLocation,
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/push-dedup', () => ({
  sendPushOnce: vi.fn().mockResolvedValue(undefined),
  sendPushToRolesAtLocationOnce: vi.fn().mockResolvedValue(undefined),
  notifyUsersOnce: vi.fn().mockResolvedValue(undefined),
  notifyUsersAtRolesOnce: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/roster-change-log', () => ({
  logRosterChange: vi.fn().mockResolvedValue({ logged: true, id: 'log-1' }),
  markChangesNotified: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
// SWAPS.2 — the leave / clash reads are unit-tested in swap-conflicts.test.js;
// here only what the route does with the answer matters.
vi.mock('@/lib/swap-conflicts', () => ({ findSwapConflicts: vi.fn(async () => []) }))
// SWAPNOTIFY.1 — the route now decides "draft or past shift" itself, so
// dublinTodayStr has to be pinned rather than read off the real clock. Tests
// that care about the boundary pass block dates far outside this value
// (2099 / 2000) so the exact pin never matters to them.
vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: vi.fn(() => '2026-06-15') }))
// SWAPNOTIFY.1 — dispatchSwapNotifications now runs inside after() rather
// than as an un-awaited promise. Mock next/server partially (keep the real
// NextResponse) so after() runs its callback synchronously in tests.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})

const { createServerClient } = await import('@/lib/supabase')
const { hasPermissionForLocation } = await import('@/lib/permissions')
const { getCurrentUser } = await import('@/lib/auth')
const { logRosterChange, markChangesNotified } = await import('@/lib/roster-change-log')
const { logWarn } = await import('@/lib/log')
const { findSwapConflicts } = await import('@/lib/swap-conflicts')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { after } = await import('next/server')
const { PUT } = await import('./route.js')

// The notification fan-out is fire-and-forget, so let it settle before
// asserting on the spies.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const MANAGER = { id: 'mgr-1', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, full_name: 'Manny Manager' }
const REQUESTER = 'coach-1'
const PROPS = { params: Promise.resolve({ id: 'swap-1' }) }

function req(body) {
  return { json: () => Promise.resolve(body), headers: { get: () => '' } }
}

// A drop swap: no target_shift_id and no target_id, so the resolver's
// approve branch returns assignmentOps: [{ id, delete: true }].
function dropSwap(rosterStatus = 'published', blockDate = '2026-06-10') {
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
        block_date: blockDate,
        rosters: rosterStatus ? { status: rosterStatus } : null,
      },
    },
    target_shift: null,
  }
}

// Records every write in `calls` so a test can assert the ordering.
// SWAPS.2 — every approval is an rpc(); `rpcErr` refuses it and `rpcArgs`
// records what the route sent. The route must never write shift_assignments
// itself any more, so that table throws.
function buildDb(swap, calls, rpcErr = null, rpcArgs = []) {
  return {
    rpc: (fn, args) => {
      calls.push(`rpc:${fn}`)
      rpcArgs.push(args)
      return Promise.resolve(rpcErr
        ? { data: null, error: rpcErr }
        : { data: { ...swap, status: 'approved', reviewed_by: args.p_reviewed_by }, error: null })
    },
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
      throw new Error(`unexpected table ${table}`)
    },
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  getCurrentUser.mockReset()
  logRosterChange.mockClear()
  logRosterChange.mockResolvedValue({ logged: true, id: 'log-1' })
  markChangesNotified.mockClear()
  markChangesNotified.mockResolvedValue(undefined)
  logWarn.mockClear()
  findSwapConflicts.mockReset()
  findSwapConflicts.mockResolvedValue([])
  notifyUsersOnce.mockClear()
  notifyUsersOnce.mockResolvedValue(undefined)
  notifyUsersAtRolesOnce.mockClear()
  after.mockClear()
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

  it('approves + deletes in one RPC, then audits (SWAPS.2)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const rpcArgs = []
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), calls, null, rpcArgs))
    logRosterChange.mockImplementation(async () => { calls.push('roster_change_log'); return { logged: true } })

    const res = await PUT(req({ status: 'approved', review_note: 'fine' }), PROPS)
    expect(res.status).toBe(200)

    expect(calls).toEqual(['rpc:approve_drop_shift_swap', 'roster_change_log'])
    expect(rpcArgs).toEqual([{
      p_swap_id: 'swap-1',
      p_reviewed_by: MANAGER.id,
      p_reviewed_at: expect.any(String),
      p_review_note: 'fine',
      p_requester_profile: REQUESTER,
    }])
    // A drop moves nobody onto anything: no leave / clash check.
    expect(findSwapConflicts).not.toHaveBeenCalled()
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

  // ROSTER-FIX.1 made this partial state reachable: swap approved, change-log
  // row written, assignment still there. SWAPS.2 closes it — the RPC rolls
  // the approval back with the delete, and nothing is audited.
  it('a refused or failed drop RPC writes no audit row and approves nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), calls, { code: 'XX000', message: 'delete blew up' }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('delete blew up')

    expect(calls).toEqual(['rpc:approve_drop_shift_swap'])
    expect(logRosterChange).not.toHaveBeenCalled()
  })

  it.each([
    ['swap_stale: claimed since', 409, 'This swap has changed since it was loaded: a shift changed hands or someone else claimed it. Refresh and check it again.'],
    ['swap_shift_missing: gone', 409, 'One of the shifts in this swap no longer exists'],
    ['swap_not_open: already approved', 409, 'This swap has already been decided'],
  ])('maps a refused drop (%s) to %i', async (message, status, error) => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published'), [], { code: 'P0001', message }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ success: false, error })
    expect(logRosterChange).not.toHaveBeenCalled()
  })
})

// ROSTER-FIX.8d — every swap notification here was a bare push, so a coach or
// manager without the app installed was told nothing about a request that
// needs their answer. These pin the switch to notifyUsersOnce /
// notifyUsersAtRolesOnce (push + registry-gated email fallback).
describe('PUT /api/schedule/swaps/[id] — notifications reach people without the app', () => {
  const COACH = { id: 'coach-2', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, full_name: 'Cora Coach' }

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

// SWAPNOTIFY.1 — an approved drop used to write an unstamped
// roster_change_log row. The next re-publish/approve covering that date
// then found it via collectUnnotifiedChanges and sent a SECOND "Roster
// updated" push on top of the "Swap approved" one this route already sends.
// These pin: (a) the drop row is stamped by id the moment delivery is
// confirmed, so the safety net never re-fires for it; (b) a draft roster or
// a past shift is stamped UNCONDITIONALLY at write time, regardless of
// delivery, since the coach must never get "Roster updated" for either;
// (c) an opted-out/failed/deduped-only delivery leaves the row unstamped so
// the schedule-category safety net can still reach an opted-out coach; (d)
// the whole dispatch — and therefore any stamping — now runs inside
// after(), and never at all when the assignment delete failed.
describe('PUT /api/schedule/swaps/[id] — approved drop does not double-notify (SWAPNOTIFY.1)', () => {
  const FUTURE = '2099-01-01'
  const PAST = '2000-01-01'

  it('stamps the drop row when the push is delivered (sent) on a published, future block', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 1, emailed: 0, skipped: 0, failed: 0, deduped: 0 })

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(markChangesNotified.mock.calls[0][1]).toEqual(['log-1'])
  })

  it('stamps the drop row when delivered via the email fallback (emailed)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 1, skipped: 0, failed: 0, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(markChangesNotified.mock.calls[0][1]).toEqual(['log-1'])
  })

  it('does NOT stamp when the requester opted out (skipped, nothing delivered)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, skipped: 1, failed: 0, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('does NOT stamp when delivery failed', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, skipped: 0, failed: 1, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('does NOT stamp on a deduped-only result', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, skipped: 0, failed: 0, deduped: 1 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('stamps a DRAFT roster drop unconditionally, even with nothing delivered', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('draft', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, skipped: 0, failed: 0, deduped: 0 })

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(markChangesNotified.mock.calls[0][1]).toEqual(['log-1'])
  })

  it('stamps a PAST block_date drop unconditionally, even with nothing delivered', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', PAST), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, skipped: 0, failed: 0, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(markChangesNotified.mock.calls[0][1]).toEqual(['log-1'])
  })

  it('does not stamp twice when the draft/past immediate stamp already covered it and delivery also succeeds', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('draft', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 1, emailed: 0, skipped: 0, failed: 0, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch and does not stamp when the drop RPC fails', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), [], { message: 'delete blew up' }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    await flush()

    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('runs the dispatch inside after()', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildDb(dropSwap('published', FUTURE), []))
    notifyUsersOnce.mockResolvedValueOnce({ sent: 1, emailed: 0, skipped: 0, failed: 0, deduped: 0 })

    await PUT(req({ status: 'approved' }), PROPS)

    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0][0]).toBeInstanceOf(Function)
  })
})

// SWAPAUDIT.1 — an approved reassign / reciprocal swap moved coaches between
// shifts and wrote NO roster_change_log rows, so a published roster's audit
// trail could not show who moved where. These pin: the rows written (2 for a
// reassign, 4 for a reciprocal swap), that they are only written once the
// assignment ops succeeded, and the SWAPNOTIFY.1 stamping rule applied PER
// COACH — draft/past rows stamped at write time, otherwise a coach's rows are
// stamped only when THAT coach's decision message delivered.
describe('PUT /api/schedule/swaps/[id] — approved reassign/swap audit (SWAPAUDIT.1)', () => {
  const FUTURE = '2099-01-01'
  const PAST = '2000-01-01'
  const TAKER = 'coach-2'

  function block(id, date, rosterStatus = 'published') {
    return { id, location_id: 'loc-1', block_date: date, rosters: rosterStatus ? { status: rosterStatus } : null }
  }

  function reassignSwap({ date = FUTURE, rosterStatus = 'published' } = {}) {
    return {
      id: 'swap-1',
      status: 'awaiting_approval',
      location_id: 'loc-1',
      requester_id: REQUESTER,
      requester_shift_id: 'assign-1',
      target_shift_id: null,
      target_id: TAKER,
      requester_shift: { id: 'assign-1', profile_id: REQUESTER, block_id: 'block-1', block: block('block-1', date, rosterStatus) },
      target_shift: null,
    }
  }

  function reciprocalSwap({ reqDate = FUTURE, tgtDate = FUTURE, reqStatus = 'published', tgtStatus = 'published' } = {}) {
    return {
      ...reassignSwap({ date: reqDate, rosterStatus: reqStatus }),
      target_shift_id: 'assign-2',
      target_shift: { id: 'assign-2', profile_id: TAKER, block_id: 'block-2', block: block('block-2', tgtDate, tgtStatus) },
    }
  }

  // SWAPATOMIC.1 / SWAPS.2 — reassign and reciprocal both go through rpc();
  // `rpcErr` fails it and `rpcArgs` records what the route sent.
  function buildMoveDb(swap, calls, { rpcErr = null, rpcArgs = [] } = {}) {
    return buildDb(swap, calls, rpcErr, rpcArgs)
  }

  // logRosterChange hands out a distinct id per row so stamps can be checked
  // by id: log-<coach>-<action>-<block>.
  function idPerRow(calls) {
    logRosterChange.mockImplementation(async (_db, c) => {
      calls?.push('roster_change_log')
      return { logged: true, id: `log-${c.coachId}-${c.action}-${c.blockId}` }
    })
  }

  // Deliver per recipient: map userId -> result.
  function deliver(byUser) {
    notifyUsersOnce.mockImplementation(async (_db, _key, to) => byUser[to[0]])
  }

  const SENT = { sent: 1, emailed: 0, skipped: 0, failed: 0, deduped: 0 }
  const EMAILED = { sent: 0, emailed: 1, skipped: 0, failed: 0, deduped: 0 }
  const SKIPPED = { sent: 0, emailed: 0, skipped: 1, failed: 0, deduped: 0 }
  const FAILED = { sent: 0, emailed: 0, skipped: 0, failed: 1, deduped: 0 }
  const DEDUPED = { sent: 0, emailed: 0, skipped: 0, failed: 0, deduped: 1 }

  const stampedIds = () => markChangesNotified.mock.calls.flatMap((c) => c[1]).sort()

  it('a reassign logs unassigned for the requester and assigned for the taker, after the RPC', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), calls))
    idPerRow(calls)

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    expect(calls).toEqual(['rpc:approve_reassign_shift_swap', 'roster_change_log', 'roster_change_log'])
    const changes = logRosterChange.mock.calls.map((c) => c[1])
    expect(changes).toEqual([
      { isPublished: true, locationId: 'loc-1', blockId: 'block-1', blockDate: FUTURE, actorId: MANAGER.id, coachId: REQUESTER, action: 'unassigned', details: { via: 'swap', swap_id: 'swap-1', effect: 'approved_reassign' } },
      { isPublished: true, locationId: 'loc-1', blockId: 'block-1', blockDate: FUTURE, actorId: MANAGER.id, coachId: TAKER, action: 'assigned', details: { via: 'swap', swap_id: 'swap-1', effect: 'approved_reassign' } },
    ])
  })

  it('a reciprocal swap logs four rows, one leave + one take per block', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap({ tgtDate: '2099-02-02' }), calls))
    idPerRow(calls)

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)

    // SWAPATOMIC.1 — one atomic RPC, no route-side swap-row or assignment
    // writes, and the audit rows only after it.
    expect(calls).toEqual(['rpc:approve_reciprocal_shift_swap',
      'roster_change_log', 'roster_change_log', 'roster_change_log', 'roster_change_log'])
    const rows = logRosterChange.mock.calls.map(([, c]) => [c.blockId, c.blockDate, c.coachId, c.action])
    expect(rows).toEqual([
      ['block-1', FUTURE, REQUESTER, 'unassigned'],
      ['block-1', FUTURE, TAKER, 'assigned'],
      ['block-2', '2099-02-02', TAKER, 'unassigned'],
      ['block-2', '2099-02-02', REQUESTER, 'assigned'],
    ])
    for (const [, c] of logRosterChange.mock.calls) {
      expect(c.actorId).toBe(MANAGER.id)
      expect(c.details).toEqual({ via: 'swap', swap_id: 'swap-1', effect: 'approved_swap' })
    }
  })

  it('stamps each coach\'s rows once that coach\'s decision message delivered (published, future)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap(), []))
    idPerRow()
    deliver({ [REQUESTER]: SENT, [TAKER]: EMAILED })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    // Two separate stamps: one per coach, each only their own rows.
    expect(markChangesNotified).toHaveBeenCalledTimes(2)
    expect(markChangesNotified.mock.calls[0][1].sort()).toEqual([
      `log-${REQUESTER}-assigned-block-2`, `log-${REQUESTER}-unassigned-block-1`,
    ])
    expect(markChangesNotified.mock.calls[1][1].sort()).toEqual([
      `log-${TAKER}-assigned-block-1`, `log-${TAKER}-unassigned-block-2`,
    ])
  })

  it('leaves an undelivered coach unstamped while stamping the delivered one', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), []))
    idPerRow()
    deliver({ [REQUESTER]: SENT, [TAKER]: SKIPPED })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(stampedIds()).toEqual([`log-${REQUESTER}-unassigned-block-1`])
  })

  it.each([['opted out', SKIPPED], ['failed', FAILED], ['deduped only', DEDUPED], ['no result', undefined]])(
    'does NOT stamp either coach when delivery is %s', async (_label, result) => {
      getCurrentUser.mockResolvedValue(MANAGER)
      createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap(), []))
      idPerRow()
      deliver({ [REQUESTER]: result, [TAKER]: result })

      await PUT(req({ status: 'approved' }), PROPS)
      await flush()

      expect(markChangesNotified).not.toHaveBeenCalled()
    })

  it('stamps DRAFT roster rows at write time, even with nothing delivered, and never twice', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap({ rosterStatus: 'draft' }), []))
    idPerRow()
    deliver({ [REQUESTER]: SENT, [TAKER]: SENT })

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    // The real roster status is passed through — logRosterChange itself
    // no-ops a draft; the mock logs anyway to prove the stamp is defensive.
    expect(logRosterChange.mock.calls.every(([, c]) => c.isPublished === false)).toBe(true)
    await flush()

    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(stampedIds()).toEqual([`log-${TAKER}-assigned-block-1`, `log-${REQUESTER}-unassigned-block-1`].sort())
  })

  it('stamps rows with no block embed at write time', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const swap = reassignSwap()
    swap.requester_shift.block = null
    createServerClient.mockReturnValue(buildMoveDb(swap, []))
    idPerRow()
    deliver({ [REQUESTER]: SKIPPED, [TAKER]: SKIPPED })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(logRosterChange.mock.calls[0][1].blockId).toBe('block-1')
    expect(stampedIds()).toEqual([`log-${TAKER}-assigned-block-1`, `log-${REQUESTER}-unassigned-block-1`].sort())
  })

  it('stamps PAST block rows at write time; the future block waits on delivery', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap({ reqDate: PAST, tgtDate: FUTURE }), []))
    idPerRow()
    deliver({ [REQUESTER]: SKIPPED, [TAKER]: SKIPPED })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    // Only block-1 (past) — block-2's rows stay for the safety net.
    expect(markChangesNotified).toHaveBeenCalledTimes(1)
    expect(stampedIds()).toEqual([`log-${TAKER}-assigned-block-1`, `log-${REQUESTER}-unassigned-block-1`].sort())
  })

  it('writes no change log and stamps nothing when the reassign RPC fails', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), [], { rpcErr: { message: 'update blew up' } }))
    idPerRow()

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    await flush()

    expect(logRosterChange).not.toHaveBeenCalled()
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('writes no change log and stamps nothing when the reciprocal swap RPC fails', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap(), [], { rpcErr: { code: 'XX000', message: 'rpc blew up' } }))
    idPerRow()

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(400)
    await flush()

    expect(logRosterChange).not.toHaveBeenCalled()
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it('a change-log failure never fails the approval', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), []))
    logRosterChange.mockRejectedValue(new Error('log exploded'))
    deliver({ [REQUESTER]: SENT, [TAKER]: SENT })

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    await flush()

    expect(logWarn).toHaveBeenCalledWith('swaps', 'approved swap: change log failed', expect.objectContaining({ swapId: 'swap-1', err: 'log exploded' }))
    expect(markChangesNotified).not.toHaveBeenCalled()
    // Both coaches are still told.
    expect(notifyUsersOnce).toHaveBeenCalledTimes(2)
  })

  it('a row logRosterChange skipped (not logged) is never stamped', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap({ date: PAST }), []))
    logRosterChange.mockResolvedValue({ logged: false, reason: 'not_published' })

    await PUT(req({ status: 'approved' }), PROPS)
    await flush()

    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('a rejection writes no change log', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), []))

    const res = await PUT(req({ status: 'rejected' }), PROPS)
    expect(res.status).toBe(200)
    await flush()

    expect(logRosterChange).not.toHaveBeenCalled()
    expect(markChangesNotified).not.toHaveBeenCalled()
  })
})

describe('PUT /api/schedule/swaps/[id] — reciprocal swap is atomic (SWAPATOMIC.1)', () => {
  const TAKER = 'coach-2'
  const blk = (id) => ({ id, location_id: 'loc-1', block_date: '2099-01-01', rosters: { status: 'published' } })
  function reciprocal() {
    return {
      id: 'swap-1',
      status: 'awaiting_approval',
      location_id: 'loc-1',
      requester_id: REQUESTER,
      requester_shift_id: 'assign-1',
      target_shift_id: 'assign-2',
      target_id: TAKER,
      requester_shift: { id: 'assign-1', profile_id: REQUESTER, block_id: 'block-1', block: blk('block-1') },
      target_shift: { id: 'assign-2', profile_id: TAKER, block_id: 'block-2', block: blk('block-2') },
    }
  }
  const rpcDb = (swap, calls, rpcArgs, rpcErr = null) => buildDb(swap, calls, rpcErr, rpcArgs)

  it('sends the swap id, review fields and the profile ids it read to the RPC, and never updates the swap row itself', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const rpcArgs = []
    createServerClient.mockReturnValue(rpcDb(reciprocal(), calls, rpcArgs))

    const res = await PUT(req({ status: 'approved', review_note: 'ok by me' }), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('approved')

    expect(calls).not.toContain('swap_update')
    expect(rpcArgs).toHaveLength(1)
    expect(rpcArgs[0]).toEqual({
      p_swap_id: 'swap-1',
      p_reviewed_by: MANAGER.id,
      p_reviewed_at: expect.any(String),
      p_review_note: 'ok by me',
      p_requester_profile: REQUESTER,
      p_target_profile: TAKER,
    })
    await flush()
    // SWAPNOTIFY.1 — both coaches still told.
    expect(notifyUsersOnce.mock.calls.map((c) => c[2][0]).sort()).toEqual([REQUESTER, TAKER].sort())
  })

  it.each([
    ['swap_stale: changed', 409, 'This swap has changed since it was loaded: a shift changed hands or someone else claimed it. Refresh and check it again.'],
    ['swap_same_block: same', 409, 'Both shifts are on the same block, so the swap would change nothing'],
    ['swap_conflict: already there', 409, 'A coach in this swap is already on that shift'],
    ['swap_not_open: swap is already approved', 409, 'This swap has already been decided'],
    ['swap_not_found: gone', 404, 'Swap request not found'],
  ])('maps a refused swap (%s) to %i, and writes, logs and notifies nothing', async (message, status, error) => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(rpcDb(reciprocal(), calls, [], { code: 'P0001', message }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ success: false, error })
    await flush()

    expect(calls).toEqual(['rpc:approve_reciprocal_shift_swap'])
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  // SWAPS.2 — a reassign is atomic now too (approve_reassign_shift_swap).
  it('a reassign goes through approve_reassign_shift_swap with the taker it read, never a route-side write', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const rpcArgs = []
    const swap = { ...reciprocal(), target_shift_id: null, target_shift: null }
    createServerClient.mockReturnValue(rpcDb(swap, calls, rpcArgs))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect(calls).toEqual(['rpc:approve_reassign_shift_swap'])
    expect(rpcArgs[0]).toEqual({
      p_swap_id: 'swap-1',
      p_reviewed_by: MANAGER.id,
      p_reviewed_at: expect.any(String),
      p_review_note: null,
      p_requester_profile: REQUESTER,
      p_target_profile: TAKER,
    })
  })

  it.each([
    ['swap_stale: taker changed', 409],
    ['swap_conflict: taker already on block', 409],
    ['swap_not_found: gone', 404],
  ])('maps a refused reassign (%s) to %i and logs / notifies nothing', async (message, status) => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    const swap = { ...reciprocal(), target_shift_id: null, target_shift: null }
    createServerClient.mockReturnValue(rpcDb(swap, calls, [], { code: 'P0001', message }))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(status)
    expect((await res.json()).error).not.toMatch(/^swap_/)
    await flush()
    expect(calls).toEqual(['rpc:approve_reassign_shift_swap'])
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
})

// SCHEDROLES.1 — manager cancel / reject used `user.role` (the ACTIVE
// studio's role) with no location check at all, so a manager at one studio
// could cancel or reject any swap id at another. Head coach at loc-1, plain
// staff at loc-2.
describe('PUT /api/schedule/swaps/[id] — manager branches judged at the swap\'s studio (SCHEDROLES.1)', () => {
  const mixed = (active) => ({
    id: 'mix', role: active === 'loc-1' ? 'head_coach' : 'staff', profileRole: 'staff',
    full_name: 'Mixed Role', activeLocation: { id: active },
    locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    rolesByLocation: { 'loc-1': 'head_coach', 'loc-2': 'staff' },
  })
  const swapAt = (loc) => ({ ...dropSwap('published', '2099-01-01'), location_id: loc })

  it('refuses to reject or cancel a colleague\'s swap at the studio where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    for (const status of ['rejected', 'cancelled']) {
      const calls = []
      createServerClient.mockReturnValue(buildDb(swapAt('loc-2'), calls))
      const res = await PUT(req({ status }), PROPS)
      expect(res.status).toBe(403)
      expect(calls).toEqual([])
    }
  })

  it('allows reject and cancel at the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    for (const status of ['rejected', 'cancelled']) {
      const calls = []
      createServerClient.mockReturnValue(buildDb(swapAt('loc-1'), calls))
      expect((await PUT(req({ status }), PROPS)).status).toBe(200)
      expect(calls).toContain('swap_update')
    }
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-2'))
    const calls = []
    createServerClient.mockReturnValue(buildDb(swapAt('loc-1'), calls))
    expect((await PUT(req({ status: 'rejected' }), PROPS)).status).toBe(200)
  })

  it('a coach may still cancel their OWN swap at a studio where they are staff', async () => {
    getCurrentUser.mockResolvedValue({ ...mixed('loc-1'), id: REQUESTER })
    const calls = []
    createServerClient.mockReturnValue(buildDb(swapAt('loc-2'), calls))
    expect((await PUT(req({ status: 'cancelled' }), PROPS)).status).toBe(200)
  })

  it('master may reject anywhere', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {}, full_name: 'Boss' })
    createServerClient.mockReturnValue(buildDb(swapAt('loc-2'), []))
    expect((await PUT(req({ status: 'rejected' }), PROPS)).status).toBe(200)
  })

  it('approve is still asked of the swap\'s studio (APPROVALS-PERCAT.1, unchanged)', async () => {
    getCurrentUser.mockResolvedValue(mixed('loc-1'))
    hasPermissionForLocation.mockClear()
    hasPermissionForLocation.mockReturnValueOnce(false)
    const calls = []
    createServerClient.mockReturnValue(buildDb(swapAt('loc-2'), calls))
    expect((await PUT(req({ status: 'approved' }), PROPS)).status).toBe(403)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(expect.objectContaining({ id: 'mix' }), 'loc-2', expect.any(String))
    expect(calls).toEqual([])
  })
})

// SWAPS.2 — leave and same-day clash checks. A claim / accept tells the coach
// (advisory, the claim stands); a manager approval that moves a coach onto a
// shift is refused with 409 + code swap_conflicts unless confirm_conflicts.
describe('PUT /api/schedule/swaps/[id] — leave / clash checks (SWAPS.2)', () => {
  const TAKER = 'coach-2'
  const COACH = { id: TAKER, role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, full_name: 'Cora Coach' }
  const blk = (id, date = '2099-01-01') => ({ id, location_id: 'loc-1', block_date: date, start_time: '06:00:00', end_time: '10:00:00', rosters: { status: 'published' } })
  const reassign = () => ({
    id: 'swap-1', status: 'awaiting_approval', location_id: 'loc-1',
    requester_id: REQUESTER, requester_shift_id: 'assign-1', target_shift_id: null, target_id: TAKER,
    requester_shift: { id: 'assign-1', profile_id: REQUESTER, block_id: 'block-1', block: blk('block-1') },
    target_shift: null,
  })
  const reciprocal = () => ({
    ...reassign(),
    target_shift_id: 'assign-2',
    target_shift: { id: 'assign-2', profile_id: TAKER, block_id: 'block-2', block: blk('block-2', '2099-01-02') },
  })
  const openDrop = () => ({ ...reassign(), status: 'pending', target_id: null })
  const LEAVE = { kind: 'leave', role: 'taker', coachId: TAKER, date: '2099-01-01', message: 'Cora Coach has approved holiday on 2099-01-01, which covers the shift on 2099-01-01.' }
  const OVERLAP = { kind: 'overlap', role: 'requester', coachId: REQUESTER, date: '2099-01-02', message: 'Rory is already on Midday 09:00 to 12:00 on 2099-01-02, which overlaps the shift (06:00 to 10:00).' }

  it('refuses a conflicting reassign approval with 409, the sentences and the conflicts, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    findSwapConflicts.mockResolvedValue([LEAVE])
    const calls = []
    createServerClient.mockReturnValue(buildDb(reassign(), calls))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, code: 'swap_conflicts', error: LEAVE.message, conflicts: [LEAVE] })
    await flush()

    expect(calls).toEqual([])
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()

    // The check was asked about the taker landing on the requester's block,
    // from the manager's point of view.
    const [, moves, opts] = findSwapConflicts.mock.calls[0]
    expect(moves).toEqual([{ role: 'taker', coachId: TAKER, block: blk('block-1'), leavingAssignmentId: null }])
    expect(opts).toEqual({ viewerId: MANAGER.id })
  })

  it('checks BOTH coaches on a reciprocal swap and joins every sentence into the error', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    findSwapConflicts.mockResolvedValue([LEAVE, OVERLAP])
    const calls = []
    createServerClient.mockReturnValue(buildDb(reciprocal(), calls))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe(`${LEAVE.message} ${OVERLAP.message}`)
    expect(calls).toEqual([])
    expect(findSwapConflicts.mock.calls[0][1].map((m) => [m.role, m.coachId, m.leavingAssignmentId])).toEqual([
      ['taker', TAKER, 'assign-2'],
      ['requester', REQUESTER, 'assign-1'],
    ])
  })

  it('an unreadable check (check_failed) also asks the manager rather than waving the approval through', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    findSwapConflicts.mockResolvedValue([{ kind: 'check_failed', coachId: TAKER, date: '2099-01-01', message: 'Could not check Cora Coach\'s leave and other shifts for 2099-01-01.' }])
    createServerClient.mockReturnValue(buildDb(reassign(), []))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('swap_conflicts')
  })

  it.each([['reassign', reassign, 'approve_reassign_shift_swap'], ['reciprocal', reciprocal, 'approve_reciprocal_shift_swap']])(
    'confirm_conflicts approves a %s without re-checking', async (_label, make, fn) => {
      getCurrentUser.mockResolvedValue(MANAGER)
      findSwapConflicts.mockResolvedValue([LEAVE])
      const calls = []
      createServerClient.mockReturnValue(buildDb(make(), calls))

      const res = await PUT(req({ status: 'approved', confirm_conflicts: true }), PROPS)
      expect(res.status).toBe(200)
      expect((await res.json()).success).toBe(true)
      expect(findSwapConflicts).not.toHaveBeenCalled()
      expect(calls[0]).toBe(`rpc:${fn}`)
    })

  it('a clean approval goes straight through to the RPC', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildDb(reassign(), calls))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect(findSwapConflicts).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('rpc:approve_reassign_shift_swap')
  })

  it('a drop is never checked, even with conflicts on offer', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    findSwapConflicts.mockResolvedValue([LEAVE])
    const calls = []
    createServerClient.mockReturnValue(buildDb(openDrop(), calls))

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect(findSwapConflicts).not.toHaveBeenCalled()
    expect(calls[0]).toBe('rpc:approve_drop_shift_swap')
  })

  it('a rejection is never checked', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    findSwapConflicts.mockResolvedValue([LEAVE])
    createServerClient.mockReturnValue(buildDb(reassign(), []))

    expect((await PUT(req({ status: 'rejected' }), PROPS)).status).toBe(200)
    expect(findSwapConflicts).not.toHaveBeenCalled()
  })

  it('a claim is saved and returns the coach\'s own warnings, without a check_failed one', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const youLeave = { ...LEAVE, message: 'You have approved holiday on 2099-01-01, which covers the shift on 2099-01-01.' }
    findSwapConflicts.mockResolvedValue([youLeave, { kind: 'check_failed', coachId: TAKER, message: 'Could not check your leave' }])
    const calls = []
    createServerClient.mockReturnValue(buildDb(openDrop(), calls))

    const res = await PUT(req({ status: 'awaiting_approval' }), PROPS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.warnings).toEqual([youLeave.message])
    // The claim itself was written — a warning never blocks it.
    expect(calls).toEqual(['swap_update'])

    const [, moves, opts] = findSwapConflicts.mock.calls[0]
    expect(moves).toEqual([{ role: 'taker', coachId: TAKER, block: blk('block-1'), leavingAssignmentId: null }])
    expect(opts).toEqual({ viewerId: TAKER })
  })

  it('a targeted accept of a reciprocal swap checks only the accepting coach, leaving their own shift out', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    createServerClient.mockReturnValue(buildDb({ ...reciprocal(), status: 'pending' }, []))

    const res = await PUT(req({ status: 'awaiting_approval' }), PROPS)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({ success: true, warnings: [] }))
    expect(findSwapConflicts.mock.calls[0][1]).toEqual([
      { role: 'taker', coachId: TAKER, block: blk('block-1'), leavingAssignmentId: 'assign-2' },
    ])
  })

  it('a withdraw, decline or cancel carries no warnings and runs no check', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    createServerClient.mockReturnValue(buildDb(reassign(), []))
    const res = await PUT(req({ status: 'pending' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).warnings).toBeUndefined()
    expect(findSwapConflicts).not.toHaveBeenCalled()
  })
})

// COVERLOOP.1 — a swap on a shift that has already STARTED. The sweep closes
// it within 15 minutes; until then (and whatever happens to the cron) the
// route itself refuses to claim, accept or approve it. Approving would move a
// shift that is being worked and clear that coach's arrival stamp and
// overrides (SWAP_MOVE_CLEARS). The RPCs are untouched. The predicate is
// swapShiftHasStarted (src/lib/swap-cover.js), the one the sweep uses; its
// table (effective start, studio timezone, both DST weekends) is in
// swap-cover.test.js.
describe('PUT /api/schedule/swaps/[id] — a started shift (COVERLOOP.1)', () => {
  const TAKER = 'coach-2'
  const COACH = { id: TAKER, role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, full_name: 'Cora Coach' }
  const REQ_USER = { id: REQUESTER, role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, full_name: 'Rory' }
  const blk = (date, start = '06:00:00') => ({ id: 'block-1', location_id: 'loc-1', block_date: date, start_time: start, end_time: '10:00:00', rosters: { status: 'published' } })
  const swapOn = (date, over = {}, shiftOver = {}) => ({
    id: 'swap-1', status: 'pending', location_id: 'loc-1',
    requester_id: REQUESTER, requester_shift_id: 'assign-1', target_shift_id: null, target_id: null,
    requester_shift: { id: 'assign-1', profile_id: REQUESTER, block_id: 'block-1', start_time_override: null, block: blk(date), ...shiftOver },
    target_shift: null,
    ...over,
  })
  // buildDb plus a `locations` table (the studio's timezone).
  const dbWithTz = (swap, calls, locations) => {
    const db = buildDb(swap, calls)
    const from = db.from
    db.from = (table) => {
      if (table !== 'locations') return from(table)
      calls.push('locations_read')
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(locations) }) }) }
    }
    return db
  }
  const LONG_AGO = '2000-01-01'

  afterEach(() => { vi.useRealTimers() })

  it.each([
    ['an open claim', () => swapOn(LONG_AGO), COACH, 'awaiting_approval'],
    ['a targeted accept', () => swapOn(LONG_AGO, { target_id: TAKER }), COACH, 'awaiting_approval'],
    ['approving a drop', () => swapOn(LONG_AGO), MANAGER, 'approved'],
    ['approving a reassign', () => swapOn(LONG_AGO, { status: 'awaiting_approval', target_id: TAKER }), MANAGER, 'approved'],
  ])('refuses %s with 409 and writes nothing', async (_name, make, user, status) => {
    getCurrentUser.mockResolvedValue(user)
    const calls = []
    createServerClient.mockReturnValue(buildDb(make(), calls))

    const res = await PUT(req({ status, confirm_conflicts: true }), PROPS)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'This shift has already started' })
    await flush()
    expect(calls).toEqual([])
    expect(findSwapConflicts).not.toHaveBeenCalled()
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })

  it.each([
    ['the taker withdraws', () => swapOn(LONG_AGO, { status: 'awaiting_approval', target_id: TAKER }), COACH, 'pending', 'pending'],
    ['the requester cancels', () => swapOn(LONG_AGO), REQ_USER, 'cancelled', 'cancelled'],
    ['a manager rejects', () => swapOn(LONG_AGO, { status: 'awaiting_approval', target_id: TAKER }), MANAGER, 'rejected', 'rejected'],
  ])('%s: still works on a started shift', async (_name, make, user, status, expected) => {
    getCurrentUser.mockResolvedValue(user)
    const calls = []
    createServerClient.mockReturnValue(buildDb(make(), calls))
    const res = await PUT(req({ status }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe(expected)
    expect(calls).toEqual(['swap_update'])
  })

  it('far from the start the studio timezone is not even read', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const calls = []
    createServerClient.mockReturnValue(dbWithTz(swapOn('2099-01-01'), calls, { data: { id: 'loc-1', timezone: 'Europe/Dublin' }, error: null }))
    expect((await PUT(req({ status: 'awaiting_approval' }), PROPS)).status).toBe(200)
    expect(calls).toEqual(['swap_update'])
  })

  // A RECIPROCAL swap moves two shifts: the TARGET shift having started
  // refuses the accept and the approval too, and says which shift it is.
  describe('a reciprocal swap', () => {
    const FUTURE = '2099-01-01'
    const recip = (reqDate, tgtDate, over = {}) => swapOn(reqDate, {
      target_id: TAKER, target_shift_id: 'assign-2',
      target_shift: { id: 'assign-2', profile_id: TAKER, block_id: 'block-2', start_time_override: null, block: { ...blk(tgtDate), id: 'block-2' } },
      ...over,
    })

    it.each([
      ['ACCEPT: the accepting coach\'s own shift has started', () => recip(FUTURE, LONG_AGO), COACH, 'awaiting_approval', 'Your own shift in this swap has already started'],
      ['ACCEPT: the shift they would be taking has started', () => recip(LONG_AGO, FUTURE), COACH, 'awaiting_approval', 'The shift you would be taking has already started'],
      ['APPROVE: the other coach\'s shift has started', () => recip(FUTURE, LONG_AGO, { status: 'awaiting_approval' }), MANAGER, 'approved', "The other coach's shift has already started"],
      ['APPROVE: the requester\'s shift has started', () => recip(LONG_AGO, FUTURE, { status: 'awaiting_approval' }), MANAGER, 'approved', "The requester's shift has already started"],
    ])('%s -> 409, nothing written', async (_name, make, user, status, error) => {
      getCurrentUser.mockResolvedValue(user)
      const calls = []
      createServerClient.mockReturnValue(buildDb(make(), calls))
      const res = await PUT(req({ status, confirm_conflicts: true }), PROPS)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ success: false, error })
      await flush()
      expect(calls).toEqual([])
      expect(notifyUsersOnce).not.toHaveBeenCalled()
    })

    it.each([
      ['the target withdraws', () => recip(FUTURE, LONG_AGO, { status: 'awaiting_approval' }), COACH, 'pending'],
      ['the target declines', () => recip(FUTURE, LONG_AGO), COACH, 'rejected'],
      ['the requester cancels', () => recip(FUTURE, LONG_AGO), REQ_USER, 'cancelled'],
      ['a manager rejects', () => recip(FUTURE, LONG_AGO, { status: 'awaiting_approval' }), MANAGER, 'rejected'],
    ])('%s: still works with the target shift started', async (_name, make, user, status) => {
      getCurrentUser.mockResolvedValue(user)
      const calls = []
      createServerClient.mockReturnValue(buildDb(make(), calls))
      expect((await PUT(req({ status }), PROPS)).status).toBe(200)
      expect(calls).toEqual(['swap_update'])
    })

    it('both shifts in the future: the approval goes through', async () => {
      getCurrentUser.mockResolvedValue(MANAGER)
      const calls = []
      createServerClient.mockReturnValue(buildDb(recip(FUTURE, '2099-01-02', { status: 'awaiting_approval' }), calls))
      expect((await PUT(req({ status: 'approved', confirm_conflicts: true }), PROPS)).status).toBe(200)
      expect(calls).toEqual(['rpc:approve_reciprocal_shift_swap'])
    })

    // 2026-01-15 10:00Z, both shifts 09:00 that day: the requester's studio is
    // on New York time (not started), the TARGET shift's studio on Dublin time
    // (started). Each shift must be read on its OWN studio's clock.
    it('each shift is judged in its OWN studio\'s timezone', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 15, 10, 0) })
      getCurrentUser.mockResolvedValue(MANAGER)
      const swap = recip('2026-01-15', '2026-01-15', { status: 'awaiting_approval' })
      swap.requester_shift.block = blk('2026-01-15', '09:00:00')
      swap.target_shift.block = { ...blk('2026-01-15', '09:00:00'), id: 'block-2', location_id: 'loc-2' }
      const calls = []
      const db = buildDb(swap, calls)
      const from = db.from
      const reads = []
      db.from = (table) => {
        if (table !== 'locations') return from(table)
        return { select: () => ({ eq: (_c, id) => ({ maybeSingle: () => { reads.push(id); return Promise.resolve({ data: { id, timezone: id === 'loc-2' ? 'Europe/Dublin' : 'America/New_York' }, error: null }) } }) }) }
      }
      createServerClient.mockReturnValue(db)
      const res = await PUT(req({ status: 'approved', confirm_conflicts: true }), PROPS)
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe("The other coach's shift has already started")
      expect(reads.sort()).toEqual(['loc-1', 'loc-2'])
      expect(calls).toEqual([])
    })
  })

  // 2026-01-15 10:00Z: a 09:00 shift has started in Dublin (09:00Z) and has
  // NOT in New York (14:00Z). Only the studio's own zone can answer.
  describe('near the start, the studio\'s timezone decides', () => {
    const NOW = Date.UTC(2026, 0, 15, 10, 0)
    const nearSwap = () => swapOn('2026-01-15', {}, { block: blk('2026-01-15', '09:00:00') })

    it('Dublin studio: started, refused', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      getCurrentUser.mockResolvedValue(COACH)
      const calls = []
      createServerClient.mockReturnValue(dbWithTz(nearSwap(), calls, { data: { id: 'loc-1', timezone: 'Europe/Dublin' }, error: null }))
      const res = await PUT(req({ status: 'awaiting_approval' }), PROPS)
      expect(res.status).toBe(409)
      expect(calls).toEqual(['locations_read'])
    })

    it('New York studio: not started, the claim goes through', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      getCurrentUser.mockResolvedValue(COACH)
      const calls = []
      createServerClient.mockReturnValue(dbWithTz(nearSwap(), calls, { data: { id: 'loc-1', timezone: 'America/New_York' }, error: null }))
      const res = await PUT(req({ status: 'awaiting_approval' }), PROPS)
      expect(res.status).toBe(200)
      expect(calls).toEqual(['locations_read', 'swap_update'])
    })

    it.each([
      ['an unreadable locations row', { data: null, error: { message: 'down' } }],
      ['an empty timezone', { data: { id: 'loc-1', timezone: null }, error: null }],
      ['an invalid timezone', { data: { id: 'loc-1', timezone: 'Mars/Olympus' }, error: null }],
    ])('%s is judged as Europe/Dublin, never a 500', async (_name, locations) => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      getCurrentUser.mockResolvedValue(COACH)
      createServerClient.mockReturnValue(dbWithTz(nearSwap(), [], locations))
      expect((await PUT(req({ status: 'awaiting_approval' }), PROPS)).status).toBe(409)
    })

    it.each([
      ['a LATER override (11:00) has not started at 10:00', '11:00:00', 200],
      ['an EARLIER override (08:00) had already started at 08:30', '08:00:00', 409, Date.UTC(2026, 0, 15, 8, 30)],
    ])('judges the EFFECTIVE start: %s', async (_name, override, status, now = NOW) => {
      vi.useFakeTimers({ toFake: ['Date'], now })
      getCurrentUser.mockResolvedValue(COACH)
      const swap = swapOn('2026-01-15', {}, { start_time_override: override, block: blk('2026-01-15', '09:00:00') })
      createServerClient.mockReturnValue(dbWithTz(swap, [], { data: { id: 'loc-1', timezone: 'Europe/Dublin' }, error: null }))
      expect((await PUT(req({ status: 'awaiting_approval' }), PROPS)).status).toBe(status)
    })

    it('one minute before the start it is still claimable', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 15, 8, 59) })
      getCurrentUser.mockResolvedValue(COACH)
      createServerClient.mockReturnValue(dbWithTz(nearSwap(), [], { data: { id: 'loc-1', timezone: 'Europe/Dublin' }, error: null }))
      expect((await PUT(req({ status: 'awaiting_approval' }), PROPS)).status).toBe(200)
    })
  })
})
