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
vi.mock('@/lib/roster-read', () => ({ fetchSourceShiftRows: vi.fn() }))
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
const { fetchSourceShiftRows } = await import('@/lib/roster-read')
const { bulkUpsertShiftAssignments } = await import('@/lib/roster-write')
const { readAssignmentKeysInRange, logAndNotifyCopiedShifts } = await import('@/lib/roster-change-notify')
const { after } = await import('next/server')
const { POST } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'

function req(body) {
  return { json: () => Promise.resolve(body) }
}

const SOURCE_ROW = {
  profileId: 'coach-1',
  shiftTemplateId: 'tpl-1',
  shiftDate: '2026-06-01',
  startTimeOverride: null,
  endTimeOverride: null,
  notes: null,
}

beforeEach(() => {
  createServerClient.mockReset()
  createServerClient.mockReturnValue({})
  getCurrentUser.mockReset()
  getCurrentUser.mockResolvedValue({ id: 'mgr-1', role: 'manager', locations: [{ id: LOC }], activeLocation: { id: LOC } })
  fetchSourceShiftRows.mockReset()
  bulkUpsertShiftAssignments.mockReset()
  readAssignmentKeysInRange.mockReset()
  logAndNotifyCopiedShifts.mockClear()
  logAndNotifyCopiedShifts.mockResolvedValue({ logged: 0, notify: null })
  after.mockClear()
})

describe('POST /api/schedule/shifts/copy-week — NOTIFY.1', () => {
  it('snapshots the target week before the upsert, then schedules log-and-notify via after()', async () => {
    fetchSourceShiftRows.mockResolvedValue({ rows: [SOURCE_ROW], error: null })
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 1, error: null })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json).toEqual({ success: true, copied: 1 })

    expect(readAssignmentKeysInRange).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC, startDate: '2026-06-08', endDate: '2026-06-14',
    })
    // Snapshot happens before the upsert commits.
    expect(readAssignmentKeysInRange.mock.invocationCallOrder[0])
      .toBeLessThan(bulkUpsertShiftAssignments.mock.invocationCallOrder[0])

    expect(after).toHaveBeenCalledTimes(1)
    expect(logAndNotifyCopiedShifts).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC,
      actorId: 'mgr-1',
      startDate: '2026-06-08',
      endDate: '2026-06-14',
      before: { rows: [], error: null, truncated: false },
      via: 'copy_week',
    })
  })

  it('404s when there are no source shifts, and never snapshots or notifies', async () => {
    fetchSourceShiftRows.mockResolvedValue({ rows: [], error: null })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))

    expect(res.status).toBe(404)
    expect(readAssignmentKeysInRange).not.toHaveBeenCalled()
    expect(bulkUpsertShiftAssignments).not.toHaveBeenCalled()
    expect(logAndNotifyCopiedShifts).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('400s on an upsert error and never schedules log-and-notify', async () => {
    fetchSourceShiftRows.mockResolvedValue({ rows: [SOURCE_ROW], error: null })
    readAssignmentKeysInRange.mockResolvedValue({ rows: [], error: null, truncated: false })
    bulkUpsertShiftAssignments.mockResolvedValue({ count: 0, error: { message: 'upsert boom' } })

    const res = await POST(req({ location_id: LOC, source_start: '2026-06-01', target_start: '2026-06-08' }))

    expect(res.status).toBe(400)
    expect(logAndNotifyCopiedShifts).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
})
