// NOTIFY.1 — route-level contract tests for POST /api/schedule/shifts/copy-week.
//
// Focus: the before-snapshot is taken (before the upsert) and the
// log-and-notify step is scheduled via next/server's `after` (not
// awaited), only when the copy actually happened.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
// COPYMODES.1 — only the READ is mocked; buildCopyPlan and the date mappers
// run for real so the route's mode wiring is what's under test.
vi.mock('@/lib/roster-copy', async () => {
  const actual = await vi.importActual('@/lib/roster-copy')
  return { ...actual, fetchSourceBlocks: vi.fn() }
})
vi.mock('@/lib/roster-write', () => ({ bulkUpsertShiftAssignments: vi.fn() }))
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
const { fetchSourceBlocks } = await import('@/lib/roster-copy')
const { bulkUpsertShiftAssignments } = await import('@/lib/roster-write')
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
  createServerClient.mockReset()
  createServerClient.mockReturnValue({})
  getCurrentUser.mockReset()
  getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC }], activeLocation: { id: LOC } })
  fetchSourceBlocks.mockReset()
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
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, mode: 'exact' })

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

  it('400s on an upsert error and never schedules log-and-notify', async () => {
    fetchSourceBlocks.mockResolvedValue({ blocks: [sourceBlock(['coach-1'])], error: null })
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 0, error: { message: 'upsert boom' } })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))

    expect(res.status).toBe(400)
    expect(logAndNotifyCopiedShifts).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
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
        // Sunday block nobody is on.
        sourceBlock([], { id: 'blk-sun', block_date: '2026-06-07', start_time: '07:00:00', end_time: '08:00:00' }),
      ],
      error: null,
    })

    const res = await POST(req(BODY))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1, skipped: 0, mode: 'exact' })
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(rows).toEqual([{
      profileId: 'coach-1', shiftTemplateId: 'tpl-1', shiftDate: '2026-06-08',
      startTime: '09:30:00', endTime: '09:45:00', partialReason: 'dentist', notes: 'keys', status: 'scheduled',
    }])
    expect(blocks.map((b) => [b.shiftDate, b.startTime])).toEqual([['2026-06-08', '09:30:00'], ['2026-06-14', '07:00:00']])
  })

  it('template mode: no overrides/notes/partial_reason, skips an inactive template, reports skipped', async () => {
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
    expect(json).toEqual({ success: true, copied: 1, skipped: 2, mode: 'template' })
    const { rows, blocks } = bulkUpsertShiftAssignments.mock.calls[0][1]
    expect(blocks).toEqual([])
    expect(rows).toEqual([{
      profileId: 'coach-1', shiftTemplateId: 'tpl-1', shiftDate: '2026-06-08',
      startTimeOverride: null, endTimeOverride: null, partialReason: null, notes: null, status: 'scheduled',
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
