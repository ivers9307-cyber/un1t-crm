// src/app/api/attendance/geofence-checkin/route.test.js
//
// ARRIVAL.1 — the check-in records ARRIVAL (shift_assignments.arrived_at),
// never the paid window, and it claims its audit row BEFORE touching a shift
// so a duplicate ping is stopped by the mig 465 unique index instead of
// moving on to the coach's next shift.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

// 12:00 Dublin summer time. Shift rows below are written in that wall clock.
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-15T11:00:00Z') })
})
afterEach(() => vi.useRealTimers())

const LOC = 'a0000000-0000-0000-0000-000000000001'
const staff = { id: 'prof-1', role: 'staff', activeLocation: { id: LOC }, locations: [{ id: LOC }] }
const GEO = { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200 }

function postReq(body) {
  return new Request('http://x/api/attendance/geofence-checkin', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const validBody = () => ({ location_id: LOC, entered_at: new Date().toISOString() })

// A thenable query builder: every chain method records itself and returns the
// builder; awaiting it resolves to `result`.
function builder(label, result, calls) {
  const b = { then: (onF, onR) => Promise.resolve(result).then(onF, onR) }
  for (const m of ['select', 'eq', 'neq', 'is', 'gte', 'lte', 'in', 'order', 'limit', 'single', 'maybeSingle']) {
    b[m] = (...args) => { calls.push([label, m, ...args]); return b }
  }
  return b
}

function mockDb({
  geo = GEO, exempt = false, recentGeofenceEvent = null, dedupSelectError = null,
  locationSelectError = null,
  shiftRows = [], shiftSelectError = null,
  claimError = null, stampError = null, stampRowsTouched = 1,
  releaseError = null, relabelError = null,
} = {}) {
  const calls = []
  const inserted = []
  const updates = []
  const deletes = []
  // Accepts either a single row or a list (newest-first, as the route's
  // .order('event_at', { ascending: false }) would return).
  const recentRows = Array.isArray(recentGeofenceEvent)
    ? recentGeofenceEvent
    : (recentGeofenceEvent ? [recentGeofenceEvent] : [])
  createServerClient.mockReturnValue({
    from: (table) => {
      if (table === 'locations') {
        return builder('locations', {
          data: locationSelectError ? null : { id: LOC, timezone: 'Europe/Dublin', settings: { geofence: geo } },
          error: locationSelectError,
        }, calls)
      }
      if (table === 'profile_locations') {
        return builder('profile_locations', { data: { geofence_exempt: exempt }, error: null }, calls)
      }
      if (table === 'staff_attendance_events') {
        return {
          select: (...a) => builder('events.select', {
            data: dedupSelectError ? null : recentRows,
            error: dedupSelectError,
          }, calls).select(...a),
          insert: (row) => {
            inserted.push(row)
            calls.push(['events.insert'])
            return builder('events.insert', { data: claimError ? null : { id: 'ev-new' }, error: claimError }, calls)
          },
          update: (patch) => { updates.push({ table, patch }); return builder('events.update', { error: relabelError }, calls) },
          delete: () => { deletes.push(table); return builder('events.delete', { error: releaseError }, calls) },
        }
      }
      if (table === 'shift_assignments') {
        return {
          select: (...a) => builder('assignments.select', { data: shiftSelectError ? null : shiftRows, error: shiftSelectError }, calls).select(...a),
          update: (patch) => {
            updates.push({ table, patch })
            calls.push(['assignments.update'])
            const data = stampError ? null : Array.from({ length: stampRowsTouched }, () => ({ id: 'assign-1' }))
            return builder('assignments.update', { data, error: stampError }, calls)
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  return { calls, inserted, updates, deletes }
}

const shiftRow = (over = {}) => ({
  id: 'assign-1', profile_id: 'prof-1', status: 'scheduled', arrived_at: null,
  block: { id: 'blk-1', location_id: LOC, block_date: '2026-07-15', start_time: '11:50:00', end_time: '13:00:00' },
  ...over,
})
const shiftUpdates = (db) => db.updates.filter((u) => u.table === 'shift_assignments')

describe('POST /api/attendance/geofence-checkin', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(postReq(validBody()))).status).toBe(401)
  })

  it('400 on a malformed body', async () => {
    getCurrentUser.mockResolvedValue(staff)
    expect((await POST(postReq({ location_id: 'nope' }))).status).toBe(400)
  })

  it('403 for a location outside the caller\'s assignments', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, activeLocation: { id: 'other' }, locations: [{ id: 'other' }] })
    const db = mockDb()
    expect((await POST(postReq(validBody()))).status).toBe(403)
    expect(db.inserted).toHaveLength(0)
  })

  it('404 when the location has geofencing disabled', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({ geo: { ...GEO, enabled: false } })
    expect((await POST(postReq(validBody()))).status).toBe(404)
  })

  it('the location lookup erroring (not just missing) → 503 transient', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({ locationSelectError: { message: 'db down' } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
  })

  it('exempt staff → geofence_exempt, no audit row', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ exempt: true })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('geofence_exempt')
    expect(db.inserted).toHaveLength(0)
  })

  it('impersonating master → impersonation_ignored, no DB touched', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, impersonatingFrom: { masterId: 'master-1' } })
    mockDb()
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('impersonation_ignored')
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('dedups a second ping within 10 minutes (no audit row, no stamp)', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ recentGeofenceEvent: { id: 'ev-1' }, shiftRows: [shiftRow()] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('duplicate')
    expect(db.inserted).toHaveLength(0)
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  it('the dedup lookup erroring → 503 transient', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({ dedupSelectError: { message: 'db down' } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
  })

  it('a recent matched-but-unstamped claim is completed on retry (lost-arrival recovery)', async () => {
    getCurrentUser.mockResolvedValue(staff)
    // Newest-first list: an already_stamped row ahead of the matched claim we
    // actually need to complete — the route must pick the matched one, not
    // just the first row in the list.
    const db = mockDb({
      recentGeofenceEvent: [
        { id: 'ev-0', match_outcome: 'already_stamped', matched_assignment_id: null, event_at: '2026-07-15T10:59:00Z' },
        { id: 'ev-1', match_outcome: 'matched', matched_assignment_id: 'assign-1', event_at: '2026-07-15T10:58:00Z' },
      ],
    })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('duplicate')
    expect(db.inserted).toHaveLength(0)
    expect(shiftUpdates(db)).toEqual([{ table: 'shift_assignments', patch: { arrived_at: '2026-07-15T10:58:00Z', arrival_source: 'geofence' } }])
    expect(db.calls).toContainEqual(['assignments.update', 'is', 'arrived_at', null])
    // Without a profile_id/status guard here, an approved shift SWAP (which
    // rewrites profile_id on the same assignment row) would let this retry
    // stamp arrival onto another coach's shift, or onto a cancelled one.
    expect(db.calls).toContainEqual(['assignments.update', 'eq', 'profile_id', 'prof-1'])
    expect(db.calls).toContainEqual(['assignments.update', 'neq', 'status', 'cancelled'])
    expect(db.calls).toContainEqual(['events.select', 'order', 'event_at', { ascending: false }])
    expect(db.calls).toContainEqual(['events.select', 'limit', 5])
  })

  it('a lost-arrival recovery that stamps a row logs a warning so recoveries can be counted', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      recentGeofenceEvent: { id: 'ev-1', match_outcome: 'matched', matched_assignment_id: 'assign-1', event_at: '2026-07-15T10:58:00Z' },
    })
    await POST(postReq(validBody()))
    expect(logWarn).toHaveBeenCalledWith(
      'geofence-checkin',
      'completed a lost arrival stamp from an earlier claim',
      expect.objectContaining({ eventId: 'ev-1', assignmentId: 'assign-1' }),
    )
  })

  it('a lost-arrival recovery that touches zero rows does not log (nothing was recovered)', async () => {
    getCurrentUser.mockResolvedValue(staff)
    mockDb({
      recentGeofenceEvent: { id: 'ev-1', match_outcome: 'matched', matched_assignment_id: 'assign-1', event_at: '2026-07-15T10:58:00Z' },
      stampRowsTouched: 0,
    })
    await POST(postReq(validBody()))
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a recent no_shift_in_window claim stays a plain duplicate, no writes', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({
      recentGeofenceEvent: { id: 'ev-1', match_outcome: 'no_shift_in_window', matched_assignment_id: null, event_at: '2026-07-15T10:58:00Z' },
    })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('duplicate')
    expect(db.inserted).toHaveLength(0)
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  it('a lost-arrival recovery stamp error → 503 transient', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({
      recentGeofenceEvent: { id: 'ev-1', match_outcome: 'matched', matched_assignment_id: 'assign-1', event_at: '2026-07-15T10:58:00Z' },
      stampError: { message: 'write failed' },
    })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
    expect(db.inserted).toHaveLength(0)
  })

  it('records the arrival on arrived_at, NEVER on start_time_override', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body).toEqual({ success: true, data: { match_outcome: 'matched' } })
    expect(shiftUpdates(db)).toEqual([{ table: 'shift_assignments', patch: { arrived_at: '2026-07-15T11:00:00.000Z', arrival_source: 'geofence' } }])
    expect(JSON.stringify(db.updates)).not.toContain('start_time_override')
  })

  it('claims the audit row BEFORE stamping, and guards the stamp on arrived_at IS NULL', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()] })
    await POST(postReq(validBody()))
    const claimAt = db.calls.findIndex((c) => c[0] === 'events.insert')
    const stampAt = db.calls.findIndex((c) => c[0] === 'assignments.update')
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(stampAt).toBeGreaterThan(claimAt)
    expect(db.calls).toContainEqual(['assignments.update', 'is', 'arrived_at', null])
    expect(db.inserted[0]).toMatchObject({ source: 'geofence', match_outcome: 'matched', matched_assignment_id: 'assign-1' })
    // A dropped `.select('id')`/`.single()` on the claim, or `.select('id')` on
    // the stamp, would leave the generic mock returning data regardless — these
    // pin the actual chain so that regression stays caught.
    expect(db.calls).toContainEqual(['events.insert', 'select', 'id'])
    expect(db.calls).toContainEqual(['events.insert', 'single'])
    expect(db.calls).toContainEqual(['assignments.update', 'select', 'id'])
  })

  it('a claim that hits the mig 465 unique index is a terminal duplicate and stamps nothing', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()], claimError: { code: '23505', message: 'duplicate key' } })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { match_outcome: 'duplicate' } })
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  it('any other claim error → 503 transient and stamps nothing', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()], claimError: { message: 'insert failed' } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  it('shift-candidates select error → 503 transient with no audit row', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftSelectError: { message: 'db down' } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
    expect(db.inserted).toHaveLength(0)
  })

  it('a failed stamp releases the claimed audit row so the phone\'s retry is not swallowed', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()], stampError: { message: 'write failed' } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
    expect(db.deletes).toEqual(['staff_attendance_events'])
    expect(db.calls).toContainEqual(['events.delete', 'eq', 'id', 'ev-new'])
  })

  it('a failed stamp whose release ALSO errors still returns 503 transient and logs a warning', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({
      shiftRows: [shiftRow()],
      stampError: { message: 'write failed' },
      releaseError: { message: 'delete failed' },
    })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(503)
    expect((await res.json()).transient).toBe(true)
    expect(db.deletes).toEqual(['staff_attendance_events'])
    expect(logWarn).toHaveBeenCalled()
  })

  it('a stamp that touched zero rows (lost race) → already_stamped and the audit row says so', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()], stampRowsTouched: 0 })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('already_stamped')
    expect(db.updates).toContainEqual({ table: 'staff_attendance_events', patch: { match_outcome: 'already_stamped' } })
    expect(db.calls).toContainEqual(['events.update', 'eq', 'id', 'ev-new'])
  })

  it('a zero-row stamp whose relabel ALSO errors still returns already_stamped and logs a warning', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow()], stampRowsTouched: 0, relabelError: { message: 'relabel failed' } })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('already_stamped')
    expect(db.updates).toContainEqual({ table: 'staff_attendance_events', patch: { match_outcome: 'already_stamped' } })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a re-entry is audited (already_stamped, payload.reentry) and stamps nothing', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [shiftRow({ arrived_at: '2026-07-15T10:45:00Z' })] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('already_stamped')
    expect(db.inserted[0]).toMatchObject({ match_outcome: 'already_stamped', matched_assignment_id: 'assign-1' })
    expect(db.inserted[0].payload.reentry).toBe(true)
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  it('16 Sep regression: the coach\'s NEXT shift is never stamped by a ping while they are on site', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const earlier = shiftRow({
      id: 'assign-a', arrived_at: '2026-07-15T09:55:00Z',
      block: { id: 'blk-a', location_id: LOC, block_date: '2026-07-15', start_time: '11:00:00', end_time: '11:45:00' },
    })
    const next = shiftRow({
      id: 'assign-b',
      block: { id: 'blk-b', location_id: LOC, block_date: '2026-07-15', start_time: '12:05:00', end_time: '13:00:00' },
    })
    const db = mockDb({ shiftRows: [earlier, next] })
    await POST(postReq(validBody()))
    expect(shiftUpdates(db)).toHaveLength(0)
    expect(db.inserted[0].matched_assignment_id).toBe('assign-a')
  })

  it('a re-entry-window ping stamps a later shift instead of hiding it when the gap exceeds the re-entry window', async () => {
    // Mirrors the staff-attendance.test.js case (10:50 ping / A 09:00-10:00
    // arrived 08:55 / B 11:30-12:30), shifted +70 minutes so the ping lands
    // on this file's fixed "now" (2026-07-15T11:00:00Z = 12:00 Dublin summer
    // time): A 10:10-11:10 arrived 10:05, B 12:40-13:40. The 90-minute gap
    // between A ending and B starting is past the 60-minute re-entry window,
    // so the ping must stamp B rather than read as A's re-entry.
    getCurrentUser.mockResolvedValue(staff)
    const shiftA = shiftRow({
      id: 'assign-a', arrived_at: '2026-07-15T09:05:00Z', // 10:05 IST
      block: { id: 'blk-a', location_id: LOC, block_date: '2026-07-15', start_time: '10:10:00', end_time: '11:10:00' },
    })
    const shiftB = shiftRow({
      id: 'assign-b',
      block: { id: 'blk-b', location_id: LOC, block_date: '2026-07-15', start_time: '12:40:00', end_time: '13:40:00' },
    })
    const db = mockDb({ shiftRows: [shiftA, shiftB] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('matched')
    expect(shiftUpdates(db)).toEqual([{ table: 'shift_assignments', patch: { arrived_at: '2026-07-15T11:00:00.000Z', arrival_source: 'geofence' } }])
    expect(db.inserted[0].matched_assignment_id).toBe('assign-b')
  })

  it('no shift in window → no_shift_in_window, audit row written, no stamp', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const db = mockDb({ shiftRows: [] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('no_shift_in_window')
    expect(db.inserted).toHaveLength(1)
    expect(shiftUpdates(db)).toHaveLength(0)
  })

  // QUEUEDARRIVAL.1 — an arrival posted from the phone's offline queue is
  // recorded at the time the coach ARRIVED, not the time the queue drained.
  // The phone stamps entered_at at the moment the OS delivers the region
  // ENTER, so an older-than-skew timestamp IS a queued upload and needs no
  // extra flag from the client.
  describe('queued (offline) arrivals', () => {
    const agoIso = (ms) => new Date(Date.now() - ms).toISOString()

    it('trusts an entered_at inside the ±5 min skew window, unqueued', async () => {
      getCurrentUser.mockResolvedValue(staff)
      const db = mockDb({ shiftRows: [] })
      const entered = agoIso(60_000)
      await POST(postReq({ ...validBody(), entered_at: entered }))
      const ev = db.inserted[0]
      expect(ev.event_at).toBe(entered)
      expect(ev.payload.clamped).toBe(false)
      expect(ev.payload.queued).toBe(false)
    })

    it('trusts an hour-old queued entered_at and marks it queued', async () => {
      getCurrentUser.mockResolvedValue(staff)
      const db = mockDb({ shiftRows: [] })
      const entered = agoIso(60 * 60_000)
      await POST(postReq({ ...validBody(), entered_at: entered }))
      const ev = db.inserted[0]
      expect(ev.event_at).toBe(entered)
      expect(ev.payload.clamped).toBe(false)
      expect(ev.payload.queued).toBe(true)
      expect(ev.payload.client_age_ms).toBe(60 * 60_000)
    })

    it('trusts an entered_at just inside 24h and clamps one just outside', async () => {
      getCurrentUser.mockResolvedValue(staff)
      const inside = agoIso(23 * 3600_000)
      const db1 = mockDb({ shiftRows: [] })
      await POST(postReq({ ...validBody(), entered_at: inside }))
      expect(db1.inserted[0].event_at).toBe(inside)
      expect(db1.inserted[0].payload.queued).toBe(true)

      const db2 = mockDb({ shiftRows: [] })
      await POST(postReq({ ...validBody(), entered_at: agoIso(25 * 3600_000) }))
      const ev = db2.inserted[0]
      expect(new Date(ev.event_at).getTime()).toBe(Date.now())
      expect(ev.payload.clamped).toBe(true)
      expect(ev.payload.queued).toBe(false)
    })

    it('still clamps a phone clock running AHEAD of the server', async () => {
      getCurrentUser.mockResolvedValue(staff)
      const db = mockDb({ shiftRows: [] })
      await POST(postReq({ ...validBody(), entered_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
      const ev = db.inserted[0]
      expect(new Date(ev.event_at).getTime()).toBe(Date.now())
      expect(ev.payload.clamped).toBe(true)
      expect(ev.payload.queued).toBe(false)
    })

    // The point of the whole change: the windows decideGeofenceStamp works on
    // are measured from the REAL arrival, so a queued ping matches the shift
    // the coach actually turned up for and stamps the time they turned up.
    it('matches and stamps the shift the queued arrival really belongs to', async () => {
      getCurrentUser.mockResolvedValue(staff)
      // 11:00Z "now"; the coach arrived at 09:55Z for a 10:00Z shift and the
      // ping only uploaded an hour later.
      const db = mockDb({
        shiftRows: [shiftRow({
          block: { id: 'blk-1', location_id: LOC, block_date: '2026-07-15', start_time: '11:00:00', end_time: '12:00:00' },
        })],
      })
      const entered = '2026-07-15T09:55:00.000Z'
      const body = await (await POST(postReq({ ...validBody(), entered_at: entered }))).json()
      expect(body.data.match_outcome).toBe('matched')
      expect(shiftUpdates(db)).toEqual([{
        table: 'shift_assignments',
        patch: { arrived_at: entered, arrival_source: 'geofence' },
      }])
      expect(db.inserted[0].event_at).toBe(entered)
      expect(db.inserted[0].payload.queued).toBe(true)
    })

    it('records client_age_ms even when the timestamp was rejected', async () => {
      getCurrentUser.mockResolvedValue(staff)
      const db = mockDb({ shiftRows: [] })
      await POST(postReq({ ...validBody(), entered_at: agoIso(48 * 3600_000) }))
      expect(db.inserted[0].payload.client_age_ms).toBe(48 * 3600_000)
    })
  })
})
