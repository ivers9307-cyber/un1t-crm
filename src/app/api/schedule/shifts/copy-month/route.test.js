// NOTIFY.1 — route-level contract tests for POST /api/schedule/shifts/copy-month.
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
  return { ...actual, fetchSourceBlocks: vi.fn(), fetchApprovedLeave: vi.fn() }
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
const { fetchSourceBlocks, fetchApprovedLeave } = await import('@/lib/roster-copy')
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
    id: 'blk-src', template_id: 'tpl-1', block_date: '2026-06-05',
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
  fetchApprovedLeave.mockReset()
  fetchApprovedLeave.mockResolvedValue({ leave: [], error: null })
  bulkUpsertShiftAssignments.mockReset()
  readAssignmentKeysInRange.mockReset()
  logAndNotifyCopiedShifts.mockClear()
  logAndNotifyCopiedShifts.mockResolvedValue({ logged: 0, notify: null })
  after.mockClear()
})

describe('POST /api/schedule/shifts/copy-month — NOTIFY.1', () => {
  it('snapshots the target month before AND after the upsert (synchronously, before returning), then schedules log-and-notify via after()', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'])], error: null })
    const beforeSnap = { rows: [], error: null, truncated: false }
    const afterSnap = { rows: [{ block_id: 'b1', profile_id: 'coach-1' }], error: null, truncated: false }
    readAssignmentKeysInRange.mockResolvedValueOnce(beforeSnap).mockResolvedValueOnce(afterSnap)
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })

    const res = await POST(req({ location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, skipped_removed: 0, skipped_on_leave: 0, mode: 'exact' })

    // July has 31 days.
    expect(readAssignmentKeysInRange).toHaveBeenCalledTimes(2)
    expect(readAssignmentKeysInRange).toHaveBeenNthCalledWith(1, expect.anything(), {
      locationId: LOC, startDate: '2026-07-01', endDate: '2026-07-31',
    })
    expect(readAssignmentKeysInRange).toHaveBeenNthCalledWith(2, expect.anything(), {
      locationId: LOC, startDate: '2026-07-01', endDate: '2026-07-31',
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
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      before: beforeSnap,
      after: afterSnap,
      via: 'copy_month',
    })
  })

  it('404s when there are no source shifts, and never snapshots or notifies', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock([])], error: null })

    const res = await POST(req({ location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }))

    expect(res.status).toBe(404)
    expect(readAssignmentKeysInRange).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(logAndNotifyCopiedShifts).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  // Review fix — see copy-week: a writer error can follow committed batches.
  it('400s on a writer error but still snapshots after and schedules log-and-notify for what landed', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'])], error: null })
    const beforeSnap = { rows: [], error: null, truncated: false }
    const afterSnap = { rows: [{ block_id: 'b1', profile_id: 'coach-1' }], error: null, truncated: false }
    readAssignmentKeysInRange.mockResolvedValueOnce(beforeSnap).mockResolvedValueOnce(afterSnap)
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: { message: 'upsert boom' } })

    const res = await POST(req({ location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }))

    expect(res.status).toBe(400)
    expect(readAssignmentKeysInRange).toHaveBeenCalledTimes(2)
    expect(after).toHaveBeenCalledTimes(1)
    expect(logAndNotifyCopiedShifts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      before: beforeSnap, after: afterSnap, via: 'copy_month',
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
    // (the other already existed on the target month).
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })

    const res = await POST(req({ location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }))
    const json = await res.json()

    expect(json.copied).toBe(1)
    expect(json.skipped).toBe(0)
  })
})

describe('POST /api/schedule/shifts/copy-month — COPYMODES.1', () => {
  const BODY = { location_id: LOC, source_month_start: '2026-08-01', target_month_start: '2026-09-01' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
  })

  it('exact maps by day-of-month (Mon 3 Aug -> Thu 3 Sep) and skips a day the target lacks', async () => {
    fetchSourceBlocks.mockResolvedValue({
      blocks: [
        sourceBlock(['coach-1'], { block_date: '2026-08-03' }),
        sourceBlock(['coach-2'], { id: 'blk-31', block_date: '2026-08-31' }),
      ],
      error: null,
    })
    const json = await (await POST(req(BODY))).json()
    expect(json).toMatchObject({ success: true, skipped: 1, mode: 'exact' })
    const { rows } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(rows.map((r) => [r.profileId, r.shiftDate])).toEqual([['coach-1', '2026-09-03']])
  })

  it('template maps the Nth weekday (first Monday -> first Monday) and skips a 5th Monday the target lacks', async () => {
    fetchSourceBlocks.mockResolvedValue({
      blocks: [
        sourceBlock(['coach-1'], { block_date: '2026-08-03' }),
        sourceBlock(['coach-2'], { id: 'blk-31', block_date: '2026-08-31' }),
      ],
      error: null,
    })
    const json = await (await POST(req({ ...BODY, mode: 'template' }))).json()
    expect(json).toMatchObject({ success: true, skipped: 1, mode: 'template' })
    const { rows } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(rows.map((r) => [r.profileId, r.shiftDate, r.startTime, r.endTime])).toEqual([['coach-1', '2026-09-07', '09:00:00', '10:00:00']])
  })

  it('answers 201 copied 0 (same shape as copy-week) without writing when every source coach is skipped', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'], { block_date: '2026-08-31' })], error: null })
    const res = await POST(req({ ...BODY, mode: 'template' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 0, skipped: 1, skipped_removed: 0, skipped_on_leave: 0, mode: 'template' })
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
})

// Review fix — exact month copy maps by day-of-month, which moves the weekday.
// The cron fills the source month with EMPTY blocks for every slot; carrying
// them put a Saturday-only template's empty blocks onto Tuesdays.
describe('POST /api/schedule/shifts/copy-month — empty blocks off their template days', () => {
  it('Saturday-only template, Aug -> Sep 2026: the staffed Saturday is copied, the empty ones do not land on Tuesdays', async () => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
    const satOnly = { id: 'tpl-sat', active: true, days_of_week: ['sat'], start_time: '08:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 4 }
    const sat = (date, coaches) => sourceBlock(coaches, { id: `blk-${date}`, template_id: 'tpl-sat', block_date: date, start_time: '08:00:00', end_time: '12:00:00', shift_templates: satOnly })
    fetchSourceBlocks.mockResolvedValue({
      blocks: [sat('2026-08-01', ['coach-1']), sat('2026-08-08', []), sat('2026-08-15', []), sat('2026-08-22', []), sat('2026-08-29', [])],
      error: null,
    })

    const res = await POST(req({ location_id: LOC, source_month_start: '2026-08-01', target_month_start: '2026-09-01', mode: 'exact' }))

    expect(res.status).toBe(201)
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    // Only the staffed block (carbon copy) — Tue 1 Sep. No empty Tuesdays.
    expect(blocks.map((b) => b.shiftDate)).toEqual(['2026-09-01'])
    expect(rows.map((r) => [r.profileId, r.shiftDate])).toEqual([['coach-1', '2026-09-01']])
  })
})

// SLOTREMOVAL.1 — slots deleted in the target month stay deleted. The skip
// itself is the writer's (roster-write.test.js); this pins the route wiring.
describe('POST /api/schedule/shifts/copy-month — removed slots', () => {
  const BODY = { location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  for (const mode of ['exact', 'template']) {
    it(`${mode}: reads removals for the target month, hands them to the writer, and counts skips`, async () => {
      const removed = new Set(['tpl-1|2026-01-01'])
      fetchSlotRemovalKeys.mockResolvedValue(removed)
      bulkUpsertShiftAssignments.mockResolvedValue({ count: 0, skippedRemoved: 2, error: null })

      const res = await POST(req({ ...BODY, mode }))
      const json = await res.json()

      expect(res.status).toBe(201)
      expect(fetchSlotRemovalKeys).toHaveBeenCalledWith(expect.anything(), {
        locationId: LOC, startDate: '2026-07-01', endDate: '2026-07-31',
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
describe('POST /api/schedule/shifts/copy-month — role at location_id (SCHEDROLES.1)', () => {
  const LOC_B = 'b0000000-0000-4000-8000-000000000002'
  const mixed = (active) => ({
    id: 'mix', role: active === LOC ? 'manager' : 'staff', profileRole: 'staff',
    activeLocation: { id: active },
    locations: [{ id: LOC }, { id: LOC_B }],
    rolesByLocation: { [LOC]: 'manager', [LOC_B]: 'staff' },
  })
  const body = (L) => ({ location_id: L, source_month_start: '2026-06-01', target_month_start: '2026-07-01' })
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

// COPYLEAVE.1 — see copy-week.
describe('POST /api/schedule/shifts/copy-month — approved leave', () => {
  const BODY = { location_id: LOC, source_month_start: '2026-06-01', target_month_start: '2026-07-01' }

  beforeEach(() => {
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1', 'coach-2'])], error: null })
  })

  it('reads leave over the whole TARGET month', async () => {
    await POST(req(BODY))
    const [, args] = fetchApprovedLeave.mock.calls[0]
    expect([...args.profileIds].sort()).toEqual(['coach-1', 'coach-2'])
    expect(args).toMatchObject({ startDate: '2026-07-01', endDate: '2026-07-31' })
  })

  it('skips the coach who is off on the mapped day and reports it', async () => {
    fetchApprovedLeave.mockResolvedValue({
      leave: [{ id: 'l1', profile_id: 'coach-2', status: 'approved', start_date: '2026-07-04', end_date: '2026-07-06' }],
      error: null,
    })
    const json = await (await POST(req(BODY))).json()
    expect(bulkUpsertShiftAssignments.mock.calls[0][1].rows.map((r) => [r.profileId, r.shiftDate])).toEqual([['coach-1', '2026-07-05']])
    expect(json).toMatchObject({ success: true, skipped: 1, skipped_on_leave: 1 })
  })

  it('template mode with EVERY coach on leave: 201, copied 0, the skip is named, nothing is written', async () => {
    fetchApprovedLeave.mockResolvedValue({
      leave: ['coach-1', 'coach-2'].map((id) => ({ id: `l-${id}`, profile_id: id, status: 'approved', start_date: '2026-07-01', end_date: '2026-07-31' })),
      error: null,
    })
    const res = await POST(req({ ...BODY, mode: 'template' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, copied: 0, skipped: 2, skipped_removed: 0, skipped_on_leave: 2, mode: 'template' })
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })

  it('500s and writes nothing when the leave read fails', async () => {
    fetchApprovedLeave.mockResolvedValue({ leave: [], error: { message: 'leave boom' } })
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
  })
})
