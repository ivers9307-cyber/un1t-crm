// src/app/api/attendance/geofence-checkin/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

const staff = { id: 'prof-1', role: 'staff', activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }] }
const GEO = { enabled: true, latitude: 53.2905, longitude: -6.1988, radius_m: 200 }

function postReq(body) {
  return new Request('http://x/api/attendance/geofence-checkin', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const validBody = () => ({ location_id: 'a0000000-0000-0000-0000-000000000001', entered_at: new Date().toISOString() })

// Configurable fake DB. Tables: locations, profile_locations,
// staff_attendance_events (dedup select + insert), shift_assignments
// (select candidates + race-guarded update + post-update verify).
function mockDb({
  geo = GEO, exempt = false, recentGeofenceEvent = null,
  shiftRows = [], updateError = null, postUpdateStamp = undefined,
} = {}) {
  const inserted = []
  let updated = null
  createServerClient.mockReturnValue({
    from: (table) => {
      if (table === 'locations') return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({
          data: { id: 'a0000000-0000-0000-0000-000000000001', timezone: 'Europe/Dublin', settings: { geofence: geo } }, error: null }) }) }),
      }
      if (table === 'profile_locations') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({
          data: { geofence_exempt: exempt }, error: null }) }) }) }),
      }
      if (table === 'staff_attendance_events') return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ limit: () => Promise.resolve({
          data: recentGeofenceEvent ? [recentGeofenceEvent] : [], error: null }) }) }) }) }) }),
        insert: (row) => { inserted.push(row); return Promise.resolve({ error: null }) },
      }
      if (table === 'shift_assignments') return {
        select: (cols) => cols.includes('block:')
          ? { eq: () => ({ is: () => ({ neq: () => ({ gte: () => ({ lte: () => ({ eq: () =>
              Promise.resolve({ data: shiftRows, error: null }) }) }) }) }) }) }
          // Post-update verify: echo whatever update() wrote (or the
          // explicit postUpdateStamp override for the raced case).
          : { eq: () => ({ single: () => Promise.resolve({
              data: { start_time_override: postUpdateStamp !== undefined ? postUpdateStamp : updated?.start_time_override ?? null },
              error: null }) }) },
        update: (patch) => { updated = patch; return { eq: () => ({ is: () => Promise.resolve({ error: updateError }) }) } },
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  return { inserted: () => inserted, updated: () => updated }
}

// One shift starting 10 minutes ago, today, at loc1 (Dublin wall clock).
function nearbyShiftRow() {
  const now = new Date()
  const dub = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now.getTime() - 10 * 60000))
  const get = (t) => dub.find(p => p.type === t).value
  return {
    id: 'assign-1', profile_id: 'prof-1', status: 'scheduled', start_time_override: null,
    block: { id: 'blk-1', location_id: 'a0000000-0000-0000-0000-000000000001',
      block_date: `${get('year')}-${get('month')}-${get('day')}`,
      start_time: `${get('hour')}:${get('minute')}:00`, end_time: '23:59:00' },
  }
}

describe('POST /api/attendance/geofence-checkin', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(postReq(validBody()))).status).toBe(401)
  })

  it('400 on a malformed body', async () => {
    getCurrentUser.mockResolvedValue(staff)
    expect((await POST(postReq({ location_id: 'nope' }))).status).toBe(400)
  })

  it('404 when the location has geofencing disabled', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    mockDb({ geo: { ...GEO, enabled: false } })
    expect((await POST(postReq(validBody()))).status).toBe(404)
  })

  it('exempt staff → success with outcome geofence_exempt, no audit row', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ exempt: true })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.match_outcome).toBe('geofence_exempt')
    expect(db.inserted().length).toBe(0)
  })

  it('dedups a second ping within 10 minutes (no new audit row)', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ recentGeofenceEvent: { id: 'ev-1' } })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('duplicate')
    expect(db.inserted().length).toBe(0)
  })

  it('stamps a matching shift and logs matched', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ shiftRows: [nearbyShiftRow()] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.success).toBe(true)
    expect(body.data.match_outcome).toBe('matched')
    expect(db.updated()).toEqual({ start_time_override: expect.any(String) })
    expect(db.inserted().length).toBe(1)
    expect(db.inserted()[0].source).toBe('geofence')
    expect(db.inserted()[0].match_outcome).toBe('matched')
    expect(db.inserted()[0].matched_assignment_id).toBe('assign-1')
  })

  it('a raced stamp (verify reads back a different value) → already_stamped', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ shiftRows: [nearbyShiftRow()], postUpdateStamp: '05:00:00' })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('already_stamped')
    expect(db.inserted().length).toBe(1)
    expect(db.inserted()[0].match_outcome).toBe('already_stamped')
  })

  it('no shift in window → no_shift_in_window, audit row still written', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ shiftRows: [] })
    const body = await (await POST(postReq(validBody()))).json()
    expect(body.data.match_outcome).toBe('no_shift_in_window')
    expect(db.inserted().length).toBe(1)
  })

  it('clamps a client entered_at more than 5 min in the past to server now', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    const db = mockDb({ shiftRows: [] })
    const stale = new Date(Date.now() - 60 * 60000).toISOString()
    await POST(postReq({ ...validBody(), entered_at: stale }))
    const ev = db.inserted()[0]
    const delta = Math.abs(new Date(ev.event_at).getTime() - Date.now())
    expect(delta).toBeLessThan(10_000)
    expect(ev.payload.clamped).toBe(true)
  })
})
