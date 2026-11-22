// ARRIVALFIX.1 — PUT /api/attendance/arrival. The rules are in
// src/lib/manual-arrival.test.js; this pins the route: the gate, the studio
// scope (another studio's shift is a 404), the compare-and-set write, and the
// audit row whose failure never undoes the arrival. Synthetic data only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { PUT } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const AID = 'b0000000-0000-0000-0000-000000000001'
const MANAGER = { id: 'mgr-1', role: 'manager', activeLocation: { id: LOC, name: 'Studio One' } }

const put = (body) => new Request('http://localhost/api/attendance/arrival', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

function row(over = {}) {
  return { id: AID, profile_id: 'p-a', status: 'scheduled', arrived_at: null, arrival_source: null, block: { id: 'blk', location_id: LOC, block_date: '2026-07-15' }, ...over }
}

function fakeDb({ assignment = row(), readError = null, updated = [{ id: AID }], writeError = null, eventError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'neq', 'is', 'update', 'insert']) {
        b[name] = (...args) => { q.ops.push([name, ...args]); return b }
      }
      b.maybeSingle = () => Promise.resolve(table === 'locations'
        ? { data: { id: LOC, timezone: 'Europe/Dublin' }, error: null }
        : { data: readError ? null : (assignment && assignment.block.location_id === LOC ? assignment : null), error: readError })
      b.then = (resolve, reject) => {
        const isUpdate = q.ops.some((o) => o[0] === 'update')
        const res = table === 'staff_attendance_events' ? { data: null, error: eventError }
          : isUpdate ? { data: writeError ? null : updated, error: writeError } : { data: null, error: null }
        return Promise.resolve(res).then(resolve, reject)
      }
      return b
    },
  }
}

const op = (db, table, name) => db.calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter((o) => o[0] === name))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MANAGER)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('PUT /api/attendance/arrival (ARRIVALFIX.1)', () => {
  it('401 signed out; 403 for a head coach, before any read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...MANAGER, role: 'head_coach' })
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('400 on a malformed body, before any read', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '7' }))).status).toBe(400)
    expect(db.calls).toEqual([])
  })

  it("stamps an unstamped shift at the studio's clock, only where it is still unstamped", async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ assignment_id: AID, time: '06:55' }))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assignment_id: AID, arrived_at: '2026-07-15T05:55:00.000Z', arrival_source: 'manual' })
    expect(op(db, 'shift_assignments', 'update')[0][1]).toEqual({ arrived_at: '2026-07-15T05:55:00.000Z', arrival_source: 'manual' })
    expect(op(db, 'shift_assignments', 'is')).toContainEqual(['is', 'arrived_at', null])
    // The read was scoped to the active studio.
    expect(op(db, 'shift_assignments', 'eq')).toContainEqual(['eq', 'block.location_id', LOC])
    const [, event] = op(db, 'staff_attendance_events', 'insert')[0]
    expect(event).toMatchObject({ source: 'manual', match_outcome: 'matched', matched_assignment_id: AID, profile_id: 'p-a', location_id: LOC, payload: { entered_by: 'mgr-1' } })
  })

  it('another studio\'s shift is a 404 and nothing is written', async () => {
    const db = fakeDb({ assignment: row({ block: { id: 'blk', location_id: OTHER, block_date: '2026-07-15' } }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(404)
    expect(op(db, 'shift_assignments', 'update')).toEqual([])
  })

  it('a manual stamp is corrected only if it is still the stamp that was read', async () => {
    const db = fakeDb({ assignment: row({ arrived_at: '2026-07-15T05:50:00Z', arrival_source: 'manual' }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:10' }))).status).toBe(200)
    const eqs = op(db, 'shift_assignments', 'eq')
    expect(eqs).toContainEqual(['eq', 'arrived_at', '2026-07-15T05:50:00Z'])
    expect(eqs).toContainEqual(['eq', 'arrival_source', 'manual'])
  })

  it('409 when the row changed under the write (zero rows updated)', async () => {
    const db = fakeDb({ updated: [] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(409)
    expect(op(db, 'staff_attendance_events', 'insert')).toEqual([])
  })

  it('a future time is refused', async () => {
    createServerClient.mockReturnValue(fakeDb())
    expect((await PUT(put({ assignment_id: AID, time: '13:30' }))).status).toBe(400)
  })

  it('a failed read or write is a logged 500, never a success', async () => {
    createServerClient.mockReturnValue(fakeDb({ readError: { message: 'boom' } }))
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(500)
    createServerClient.mockReturnValue(fakeDb({ writeError: { message: 'boom' } }))
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(500)
    expect(logError).toHaveBeenCalled()
  })

  it('a failed audit row is logged and the arrival still stands', async () => {
    createServerClient.mockReturnValue(fakeDb({ eventError: { message: 'boom' } }))
    expect((await PUT(put({ assignment_id: AID, time: '07:00' }))).status).toBe(200)
    expect(logError).toHaveBeenCalledWith('attendance', 'manual arrival audit row failed', expect.any(Object))
  })
})

describe('PUT /api/attendance/arrival — a phone-logged arrival (ARRIVALFIX.2)', () => {
  const PHONE = { arrived_at: '2026-07-15T05:50:00Z', arrival_source: 'geofence' }

  it('a manager corrects it at the studio\'s clock, only if it is still the phone stamp that was read', async () => {
    const db = fakeDb({ assignment: row(PHONE) })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ assignment_id: AID, time: '07:05' }))
    expect(res.status).toBe(200)
    // 07:05 Dublin summer time is 06:05Z.
    expect((await res.json()).data).toEqual({ assignment_id: AID, arrived_at: '2026-07-15T06:05:00.000Z', arrival_source: 'manual' })
    expect(op(db, 'shift_assignments', 'update')[0][1]).toEqual({ arrived_at: '2026-07-15T06:05:00.000Z', arrival_source: 'manual' })
    const eqs = op(db, 'shift_assignments', 'eq')
    expect(eqs).toContainEqual(['eq', 'arrived_at', '2026-07-15T05:50:00Z'])
    expect(eqs).toContainEqual(['eq', 'arrival_source', 'geofence'])
    expect(eqs).toContainEqual(['eq', 'block.location_id', LOC])
  })

  it('writes the audit row with who corrected it and what the phone had recorded', async () => {
    const db = fakeDb({ assignment: row(PHONE) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:05' }))).status).toBe(200)
    const inserts = op(db, 'staff_attendance_events', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toEqual({
      profile_id: 'p-a', location_id: LOC, source: 'manual', event_at: '2026-07-15T06:05:00.000Z',
      matched_assignment_id: AID, match_outcome: 'matched',
      payload: { entered_by: 'mgr-1', previous_arrived_at: '2026-07-15T05:50:00Z', previous_source: 'geofence' },
    })
    // The phone's own event row is never touched.
    expect(op(db, 'staff_attendance_events', 'update')).toEqual([])
  })

  it('staff (and a head coach) get 403 before any read', async () => {
    for (const role of ['staff', 'head_coach']) {
      getCurrentUser.mockResolvedValue({ ...MANAGER, role })
      const db = fakeDb({ assignment: row(PHONE) })
      createServerClient.mockReturnValue(db)
      expect((await PUT(put({ assignment_id: AID, time: '07:05' }))).status).toBe(403)
      expect(db.calls).toEqual([])
    }
  })

  it("another studio's phone arrival is a 404 and nothing is written", async () => {
    const db = fakeDb({ assignment: row({ ...PHONE, block: { id: 'blk', location_id: OTHER, block_date: '2026-07-15' } }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:05' }))).status).toBe(404)
    expect(op(db, 'shift_assignments', 'update')).toEqual([])
    expect(op(db, 'staff_attendance_events', 'insert')).toEqual([])
  })

  it('in winter the same wall clock is GMT', async () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    const db = fakeDb({ assignment: row({ arrived_at: '2026-01-15T06:50:00Z', arrival_source: 'geofence', block: { id: 'blk', location_id: LOC, block_date: '2026-01-15' } }) })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ assignment_id: AID, time: '07:05' }))
    expect((await res.json()).data.arrived_at).toBe('2026-01-15T07:05:00.000Z')
  })

  it('a stamp with no recorded source is matched on a null source', async () => {
    const db = fakeDb({ assignment: row({ arrived_at: '2026-07-15T05:50:00Z', arrival_source: null }) })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:05' }))).status).toBe(200)
    expect(op(db, 'shift_assignments', 'is')).toContainEqual(['is', 'arrival_source', null])
    expect(op(db, 'shift_assignments', 'is')).not.toContainEqual(['is', 'arrived_at', null])
  })

  it('409 when the phone stamp changed under the write, and no audit row', async () => {
    const db = fakeDb({ assignment: row(PHONE), updated: [] })
    createServerClient.mockReturnValue(db)
    expect((await PUT(put({ assignment_id: AID, time: '07:05' }))).status).toBe(409)
    expect(op(db, 'staff_attendance_events', 'insert')).toEqual([])
  })
})
