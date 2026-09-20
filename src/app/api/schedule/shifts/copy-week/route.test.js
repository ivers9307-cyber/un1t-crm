// NOTIFY.1 — route-level contract tests for POST /api/schedule/shifts/copy-week.
//
// Focus: the before-snapshot is taken (before the upsert) and the
// log-and-notify step is scheduled via next/server's `after` (not
// awaited), only when the copy actually happened.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccess: vi.fn(() => null),
    // SCHEDROLES.1 — REAL: the role at location_id is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
// COPYMODES.1 — only the READ is mocked; buildCopyPlan and the date mappers
// run for real so the route's mode wiring is what's under test.
vi.mock('@/lib/roster-copy', async () => {
  const actual = await vi.importActual('@/lib/roster-copy')
  return { ...actual, fetchSourceBlocks: vi.fn(), fetchLeaveLookup: vi.fn() }
})
vi.mock('@/lib/roster-write', () => ({ bulkUpsertShiftAssignments: vi.fn() }))
// SLOTREMOVAL.1 — the removals read is mocked; everything else in roster is real.
vi.mock('@/lib/roster', async () => {
  const actual = await vi.importActual('@/lib/roster')
  return { ...actual, fetchSlotRemovalKeys: vi.fn() }
})
vi.mock('@/lib/roster-change-notify', () => ({
  readAssignmentKeysInRange: vi.fn(),
  logAndNotifyCopiedShifts: vi.fn(() => Promise.resolve({ logged: 0, notify: null })),
}))
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return { ...actual, after: vi.fn((fn) => fn()) }
})

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { fetchSourceBlocks, fetchLeaveLookup, approvedLeaveLookup } = await import('@/lib/roster-copy')
// COPYLEAVE.1 — what the (mocked) leave read answers: the REAL lookup over these rows.
const onLeave = (rows) => ({ isOnLeave: approvedLeaveLookup(rows), error: null })
const { bulkUpsertShiftAssignments } = await import('@/lib/roster-write')
const { fetchSlotRemovalKeys } = await import('@/lib/roster')
const { readAssignmentKeysInRange, logAndNotifyCopiedShifts } = await import('@/lib/roster-change-notify')
const { after } = await import('next/server')
const { POST } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'

function req(body) {
  return { json: () => Promise.resolve(body) }
}

// A source block (Roster v2 shape) with the given coaches on it.
function sourceBlock(profileIds, over = {}) {
  return {
    id: 'blk-src', template_id: 'tpl-1', block_date: '2026-06-01',
    start_time: '09:00:00', end_time: '10:00:00', min_coaches: 1, max_coaches: 6,
    shift_templates: { id: 'tpl-1', active: true, days_of_week: ['mon', 'tue', 'wed', 'thu', 'fri'], start_time: '09:00:00', end_time: '10:00:00', min_coaches: 1, max_coaches: 6 },
    shift_assignments: profileIds.map((id) => ({ profile_id: id, status: 'scheduled', notes: null, partial_reason: null, start_time_override: null, end_time_override: null })),
    ...over,
  }
}

beforeEach(() => {
  fetchSlotRemovalKeys.mockReset()
  fetchSlotRemovalKeys.mockResolvedValue(new Set())
  createServerClient.mockReset()
  createServerClient.mockReturnValue({})
  getCurrentUser.mockReset()
  getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', profileRole: 'manager', locations: [{ id: LOC }], activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
  fetchSourceBlocks.mockReset()
  fetchLeaveLookup.mockReset()
  fetchLeaveLookup.mockResolvedValue(onLeave([]))
  bulkUpsertShiftAssignments.mockReset()
  readAssignmentKeysInRange.mockReset()
  logAndNotifyCopiedShifts.mockClear()
  logAndNotifyCopiedShifts.mockResolvedValue({ logged: 0, notify: null })
  after.mockClear()
})

describe('POST /api/schedule/shifts/copy-week — NOTIFY.1', () => {
  it('snapshots the target week before AND after the upsert (synchronously, before returning), then schedules log-and-notify via after()', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'])], error: null })
    const beforeSnap = { rows: [], error: null, truncated: false }
    const afterSnap = { rows: [{ block_id: 'b1', profile_id: 'coach-1' }], error: null, truncated: false }
    readAssignmentKeysInRange.mockResolvedValueOnce(beforeSnap).mockResolvedValueOnce(afterSnap)
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, skipped_removed: 0, skipped_on_leave: 0, skipped_not_at_studio: 0, mode: 'exact' })

    expect(readAssignmentKeysInRange).toHaveBeenCalledTimes(2)
    expect(readAssignmentKeysInRange).toHaveBeenNthCalledWith(1, expect.anything(), {
      locationId: LOC, startDate: '2026-06-08', endDate: '2026-06-14',
    })
    expect(readAssignmentKeysInRange).toHaveBeenNthCalledWith(2, expect.anything(), {
      locationId: LOC, startDate: '2026-06-08', endDate: '2026-06-14',
    })
    // Before-snapshot happens before the upsert commits; the after-snapshot
    // is read synchronously right after it, still ahead of the response.
    expect(readAssignmentKeysInRange.mock.invocationCallOrder[0])
      .toBeLessThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])
    expect(readAssignmentKeysInRange.mock.invocationCallOrder[1])
      .toBeGreaterThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])

    expect(after).toHaveBeenCalledTimes(1)
    expect(logAndNotifyCopiedShifts).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC,
      actorId: 'mgr-1',
      startDate: '2026-06-08',
      endDate: '2026-06-14',
      before: beforeSnap,
      after: afterSnap,
      via: 'copy_week',
    })
  })

  it('404s when there are no source shifts, and never snapshots or notifies', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock([])], error: null })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))

    expect(res.status).toBe(404)
    expect(readAssignmentKeysInRange).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(logAndNotifyCopiedShifts).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  // Review fix — the writer batches, so an error can follow committed batches.
  // Those coaches must still be logged and notified; the before/after diff
  // names only what landed, so nothing that failed is announced.
  it('400s on a writer error but still snapshots after and schedules log-and-notify for what landed', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
    const beforeSnap = { rows: [], error: null, truncated: false }
    const afterSnap = { rows: [{ block_id: 'b1', profile_id: 'coach-1' }], error: null, truncated: false }
    readAssignmentKeysInRange.mockResolvedValueOnce(beforeSnap).mockResolvedValueOnce(afterSnap)
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: { message: 'upsert boom' } })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('upsert boom')
    expect(readAssignmentKeysInRange).toHaveBeenCalledTimes(2)
    expect(readAssignmentKeysInRange.mock.invocationCallOrder[1])
      .toBeGreaterThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])
    expect(after).toHaveBeenCalledTimes(1)
    expect(logAndNotifyCopiedShifts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      before: beforeSnap, after: afterSnap, via: 'copy_week',
    }))
  })

  // COPYFIX.1 — bulkUpsertShiftAssignments now reports the rows it actually
  // inserted (ON CONFLICT DO NOTHING can insert fewer than the payload it
  // was sent), so `copied` must come straight from the writer's count, not
  // be re-derived from the row list the route built.
  it('copied comes from the writer\'s count, not the number of rows sent to it', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    // Two rows offered to the writer, but only one was actually inserted
    // (the other already existed on the target week).
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))
    const json = await res.json()

    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows).toHaveLength(2)
    expect(json.copied).toBe(1)
  })
})

describe('POST /api/schedule/shifts/copy-week — COPYMODES.1', () => {
  const BODY = { location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
  })

  it('a missing mode is exact: real times, partial_reason and the source blocks (empty ones too) go to the writer', async () => {
    fetchSourceBlocks.mockResolvedValue({
      blocks: [
        sourceBlock(['coach-1'], {
          start_time: '09:30:00',
          shift_assignments: [{ profile_id: 'coach-1', status: 'swapped', notes: 'keys', partial_reason: 'dentist', start_time_override: null, end_time_override: '09:45:00' }],
        }),
        // Sunday block nobody is on, on a template that runs Sundays.
        sourceBlock([], {
          id: 'blk-sun', template_id: 'tpl-sun', block_date: '2026-06-07', start_time: '07:00:00', end_time: '08:00:00',
          shift_templates: { id: 'tpl-sun', active: true, days_of_week: ['sun'], start_time: '07:00:00', end_time: '08:00:00' },
        }),
      ],
      error: null,
    })

    const res = await POST(req(BODY))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, skipped_removed: 0, skipped_on_leave: 0, skipped_not_at_studio: 0, mode: 'exact' })
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(rows).toEqual([{
      profileId: 'coach-1', shiftTemplateId: 'tpl-1', shiftDate: '2026-06-08',
      startTime: '09:30:00', endTime: '09:45:00', partialReason: 'dentist', notes: 'keys', status: 'scheduled',
    }])
    expect(blocks.map((b) => [b.shiftDate, b.startTime])).toEqual([['2026-06-08', '09:30:00'], ['2026-06-14', '07:00:00']])
  })

  it('template mode: template times, no notes/partial_reason, skips an inactive template, reports skipped', async () => {
    fetchSourceBlocks.mockResolvedValue({
      blocks: [
        sourceBlock(['coach-1'], { start_time: '09:30:00' }),
        sourceBlock(['coach-2', 'coach-3'], { id: 'blk-2', template_id: 'tpl-2', shift_templates: { id: 'tpl-2', active: false, days_of_week: ['mon'] } }),
      ],
      error: null,
    })

    const res = await POST(req({ ...BODY, mode: 'template' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1, skipped: 2, skipped_removed: 0, skipped_on_leave: 0, skipped_not_at_studio: 0, mode: 'template' })
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(blocks).toEqual([])
    expect(rows).toEqual([{
      profileId: 'coach-1', shiftTemplateId: 'tpl-1', shiftDate: '2026-06-08',
      startTime: '09:00:00', endTime: '10:00:00', partialReason: null, notes: null, status: 'scheduled',
    }])
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown mode with a 400 and reads nothing', async () => {
    const res = await POST(req({ ...BODY, mode: 'fuzzy' }))
    expect(res.status).toBe(400)
    expect(fetchSourceBlocks).not.toHaveBeenCalled()
  })

  it('400s when the source read fails', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [], error: { message: 'read boom' } })
    const res = await POST(req(BODY))
    expect(res.status).toBe(400)
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})

// SLOTREMOVAL.1 — slots deleted in the target week stay deleted. The skip
// itself is the writer's (roster-write.test.js); this pins the route wiring.
describe('POST /api/schedule/shifts/copy-week — removed slots', () => {
  const BODY = { location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  for (const mode of ['exact', 'template']) {
    it(`${mode}: reads removals for the target week, hands them to the writer, and counts skips`, async () => {
      const removed = new Set(['tpl-1|2026-01-01'])
      fetchSlotRemovalKeys.mockResolvedValue(removed)
      bulkUpsertShiftAssignments.mockResolvedValue({ count: 0, skippedRemoved: 2, error: null })

      const res = await POST(req({ ...BODY, mode }))
      const json = await res.json()

      expect(res.status).toBe(201)
      expect(fetchSlotRemovalKeys).toHaveBeenCalledWith(expect.anything(), {
        locationId: LOC, startDate: '2026-06-08', endDate: '2026-06-14',
      })
      expect(bulkUpsertShiftAssignments.mock.calls[0][1].removedSlots).toBe(removed)
      expect(json).toMatchObject({ copied: 0, skipped_removed: 2, mode })
      expect(json.skipped).toBeGreaterThanOrEqual(2)
    })
  }

  it('refuses to copy blind when the removals read fails', async () => {
    fetchSlotRemovalKeys.mockRejectedValue(new Error('Failed to load slot removals: down'))
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})

// SCHEDROLES.1 — manager at LOC, plain staff at LOC_B. The route read
// `user.role` (the ACTIVE studio's) and then checked only membership.
describe('POST /api/schedule/shifts/copy-week — role at location_id (SCHEDROLES.1)', () => {
  const LOC_B = 'b0000000-0000-4000-8000-000000000002'
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'manager' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: LOC_B }],
    rolesByLocation: { [LOC]: 'manager', [LOC_B]: 'staff' },
  })
  const body = (L) => ({ location_id: L, source_start: '2026-06-01', target_start: '2026-06-08' })
  beforeEach(() => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'])], error: null })
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
  })

  it('refuses the studio where the caller is staff, and reads or writes nothing', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    const res = await POST(req(body(LOC_B)))
    expect(res.status).toBe(403)
    expect(fetchSourceBlocks).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })

  it('allows the studio the caller manages', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC))
    expect((await POST(req(body(LOC)))).status).toBe(201)
  })

  it('still allows it with the ACTIVE studio set to the one where the caller is staff', async () => {
    getCurrentUser.mockResolvedValue(mixed(LOC_B))
    expect((await POST(req(body(LOC)))).status).toBe(201)
  })

  it('master is allowed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'boss', role: 'master', profileRole: 'master', locations: [], rolesByLocation: {} })
    expect((await POST(req(body(LOC_B)))).status).toBe(201)
  })
})

// COPYLEAVE.1 — the copy reads approved leave for the TARGET week and does not
// roster a coach onto a day they are off.
describe('POST /api/schedule/shifts/copy-week — approved leave', () => {
  const BODY = { location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  it('reads leave for the source coaches over the TARGET week, before anything is written', async () => {
    await POST(req(BODY))
    expect(fetchLeaveLookup).toHaveBeenCalledTimes(1)
    const [, args] = fetchLeaveLookup.mock.calls[0]
    // The source blocks go in whole; which coaches that means is
    // fetchLeaveLookup's business (roster-copy.test.js).
    expect(args.sourceBlocks.flatMap((b) => b.shift_assignments.map((a) => a.profile_id)).sort()).toEqual(['coach-1', 'coach-2'])
    expect(args).toMatchObject({ startDate: '2026-06-08', endDate: '2026-06-14' })
    expect(fetchLeaveLookup.mock.invocationCallOrder[0])
      .toBeLessThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])
  })

  it('does not send the coach on leave to the writer, and reports the skip', async () => {
    // The source block is Mon 1 Jun, so the target is Mon 8 Jun.
    fetchLeaveLookup.mockResolvedValue(onLeave([{ id: 'l1', profile_id: 'coach-1', status: 'approved', start_date: '2026-06-08', end_date: '2026-06-09' }]))
    const res = await POST(req(BODY))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => r.profileId)).toEqual(['coach-2'])
    expect(json).toEqual({ success: true, copied: 1, skipped: 1, skipped_removed: 0, skipped_on_leave: 1, skipped_not_at_studio: 0, mode: 'exact' })
  })

  // Review — copy-month had this; template mode takes a different loop in
  // buildCopyPlan, so the week route pins it too.
  it('template mode: the coach on leave is not sent to the writer, at template times, and the skip is reported', async () => {
    fetchLeaveLookup.mockResolvedValue(onLeave([{ id: 'l1', profile_id: 'coach-2', status: 'approved', start_date: '2026-06-08', end_date: '2026-06-08' }]))
    const res = await POST(req({ ...BODY, mode: 'template' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(blocks).toEqual([])
    expect(rows.map((r) => [r.profileId, r.shiftDate, r.startTime])).toEqual([['coach-1', '2026-06-08', '09:00:00']])
    expect(json).toEqual({ success: true, copied: 1, skipped: 1, skipped_removed: 0, skipped_on_leave: 1, skipped_not_at_studio: 0, mode: 'template' })
  })

  it('500s and writes NOTHING when the leave read fails: copying blind is the bug', async () => {
    fetchLeaveLookup.mockResolvedValue({ isOnLeave: null, error: { message: 'leave boom' } })
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('leave boom')
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(readAssignmentKeysInRange).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('a source week with nobody on it still 404s; the leave read is handed no coaches', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock([])], error: null })
    const res = await POST(req(BODY))
    expect(res.status).toBe(404)
    // Called, but with blocks nobody is on, so the real fetchLeaveLookup makes
    // no query (pinned in roster-copy.test.js, "no coaches = no query").
    expect(fetchLeaveLookup).toHaveBeenCalledTimes(1)
    expect(fetchLeaveLookup.mock.calls[0][1].sourceBlocks.flatMap((b) => b.shift_assignments)).toEqual([])
  })
})

// STAFFDELETE.1 — a permanent delete keeps past shifts, so the source week
// can still name someone who no longer works here. The drop itself is the
// writer's (roster-write.test.js); this pins the route wiring in both modes.
describe('POST /api/schedule/shifts/copy-week — people no longer at the studio', () => {
  const BODY = { location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-gone'])], error: null })
  })

  for (const mode of ['exact', 'template']) {
    it(`${mode}: reports the writer's skippedNotAtStudio as skipped_not_at_studio, inside skipped`, async () => {
      bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 1, error: null })
      const res = await POST(req({ ...BODY, mode }))
      const json = await res.json()
      expect(res.status).toBe(201)
      // Both source coaches reach the writer: it, not the plan, knows who still works here.
      expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => r.profileId)).toEqual(['coach-1', 'coach-gone'])
      expect(json).toEqual({ success: true, copied: 1, skipped: 1, skipped_removed: 0, skipped_on_leave: 0, skipped_not_at_studio: 1, mode })
    })
  }

  // Both skip reasons in ONE copy (COPYLEAVE.1 + STAFFDELETE.1): the plan drops
  // the coach on approved leave, the writer drops the one who no longer works
  // here. They are disjoint (a coach on leave never reaches the writer) and
  // both sit inside `skipped`.
  it('one copy can hit BOTH reasons: on leave (the plan) and no longer at the studio (the writer)', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-off', 'coach-gone'])], error: null })
    fetchLeaveLookup.mockResolvedValue(onLeave([{ id: 'l1', profile_id: 'coach-off', status: 'approved', start_date: '2026-06-08', end_date: '2026-06-08' }]))
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 1, error: null })
    const res = await POST(req(BODY))
    expect(res.status).toBe(201)
    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => r.profileId)).toEqual(['coach-1', 'coach-gone'])
    expect(await res.json()).toEqual({ success: true, copied: 1, skipped: 2, skipped_removed: 0, skipped_on_leave: 1, skipped_not_at_studio: 1, mode: 'exact' })
  })

  it('a writer that reports nothing (older shape) reads as zero', async () => {
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 2, error: null })
    const json = await (await POST(req(BODY))).json()
    expect(json.skipped_not_at_studio).toBe(0)
  })
})
