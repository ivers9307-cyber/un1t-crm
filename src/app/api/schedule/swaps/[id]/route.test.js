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
vi.mock('@/lib/roster-change-log', () => ({
  logRosterChange: vi.fn().mockResolvedValue({ logged: true, id: 'log-1' }),
  markChangesNotified: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
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
const { getCurrentUser } = await import('@/lib/auth')
const { logRosterChange, markChangesNotified } = await import('@/lib/roster-change-log')
const { logWarn } = await import('@/lib/log')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { after } = await import('next/server')
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
  logRosterChange.mockResolvedValue({ logged: true, id: 'log-1' })
  markChangesNotified.mockClear()
  markChangesNotified.mockResolvedValue(undefined)
  logWarn.mockClear()
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

  it('does not dispatch and does not stamp when the assignment delete fails', async () => {
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

  // shift_assignments supports update() here (the move ops), recording each
  // write in `calls` so ordering against the change log can be asserted.
  function buildMoveDb(swap, calls, updateErr = null) {
    const base = buildDb(swap, calls)
    return {
      from: (table) => {
        if (table === 'shift_assignments') {
          return {
            update: () => ({
              eq: (col, val) => {
                calls.push(`assignment_update:${val}`)
                return Promise.resolve({ error: updateErr })
              },
            }),
          }
        }
        return base.from(table)
      },
    }
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

  it('a reassign logs unassigned for the requester and assigned for the taker, after the update', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const calls = []
    createServerClient.mockReturnValue(buildMoveDb(reassignSwap(), calls))
    idPerRow(calls)

    const res = await PUT(req({ status: 'approved' }), PROPS)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    expect(calls).toEqual(['swap_update', 'assignment_update:assign-1', 'roster_change_log', 'roster_change_log'])
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

    expect(calls).toEqual(['swap_update', 'assignment_update:assign-1', 'assignment_update:assign-2',
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

  it('writes no change log and stamps nothing when an assignment update fails', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    createServerClient.mockReturnValue(buildMoveDb(reciprocalSwap(), [], { message: 'update blew up' }))
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
