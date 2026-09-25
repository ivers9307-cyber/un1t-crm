// ROSTER-FIX.1 (D1) — coaches never see draft shifts. The manager/non-manager
// split lives in the route, not the reader, so the calendar (managers) keeps
// its drafts while the mobile schedule feed (coaches) does not.
//
// COACHSCOPE.1 — the split is now per ROW LOCATION: the route hands the reader
// a viewer whose isManagerAt answers from rolesByLocation, never `user.role`
// (the active location's role). The filtering/slimming itself is pinned in
// src/lib/roster-read.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
  hasRoleAtLocation: (user, loc, roles) => {
    if (!user || !loc) return false
    if (user.profileRole === 'master') return true
    const role = user.rolesByLocation?.[loc]
    return !!role && roles.includes(role)
  },
}))
vi.mock('@/lib/roster-read', () => ({ fetchApiShiftRows: vi.fn(() => Promise.resolve({ rows: [], error: null })) }))
// COVERLOOP.2 — keep the real annotate (pure); stub only the read.
vi.mock('@/lib/shift-open-swaps', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchOwnOpenSwaps: vi.fn(() => Promise.resolve([])),
}))
// ARRIVALSHOW.1 — keep the real annotate (pure); stub only the read. The
// default answers "stamps unreadable", so every row carries arrival: null.
vi.mock('@/lib/shift-arrivals', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    fetchOwnArrivalFacts: vi.fn(() => Promise.resolve({ stamps: null, timezones: new Map(), tracked: null })),
    // Real by default; one test makes it throw (review 3).
    annotateOwnArrivals: vi.fn(real.annotateOwnArrivals),
  }
})
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
const { getCurrentUser } = await import('@/lib/auth')
const { fetchApiShiftRows } = await import('@/lib/roster-read')
const { fetchOwnOpenSwaps } = await import('@/lib/shift-open-swaps')
const { fetchOwnArrivalFacts, annotateOwnArrivals } = await import('@/lib/shift-arrivals')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')
const req = (url = 'http://x/api/schedule/shifts?location_id=loc-1') => ({ url })
beforeEach(() => { getCurrentUser.mockReset(); fetchApiShiftRows.mockClear() })

const viewerFor = async (user) => {
  getCurrentUser.mockResolvedValue(user)
  await GET(req())
  const opts = fetchApiShiftRows.mock.calls[0][1]
  expect(opts.publishedOnly).toBeFalsy()
  return opts.viewer
}

describe('GET /api/schedule/shifts — per-location viewer (D1 + COACHSCOPE.1)', () => {
  it('a coach is a non-manager at their location', async () => {
    const v = await viewerFor({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] })
    expect(v.id).toBe('c')
    expect(v.isManagerAt('loc-1')).toBe(false)
  })

  it('a manager is a manager at their location', async () => {
    const v = await viewerFor({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] })
    expect(v.isManagerAt('loc-1')).toBe(true)
  })

  it('an active-location head coach is still a coach at a studio where they are staff', async () => {
    const v = await viewerFor({
      id: 'x', role: 'head_coach', profileRole: 'head_coach',
      rolesByLocation: { 'loc-1': 'staff', 'loc-2': 'head_coach' },
      locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
    })
    expect(v.isManagerAt('loc-1')).toBe(false)
    expect(v.isManagerAt('loc-2')).toBe(true)
  })

  it('a master is a manager everywhere', async () => {
    const v = await viewerFor({ id: 'ms', role: 'master', profileRole: 'master', rolesByLocation: {}, locations: [{ id: 'loc-1' }] })
    expect(v.isManagerAt('loc-1')).toBe(true)
  })
})

// COVERLOOP.2 — the Schedule tab's "Swap pending" chip reads open_swap_status.
describe('GET /api/schedule/shifts — open_swap_status', () => {
  it("marks the caller's own shift that has an open swap, and nobody else's", async () => {
    getCurrentUser.mockResolvedValue({ id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] })
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [{ id: 'a1', profile_id: 'c' }, { id: 'a2', profile_id: 'other' }], error: null })
    fetchOwnOpenSwaps.mockResolvedValueOnce([
      { requester_shift_id: 'a1', status: 'pending' },
      { requester_shift_id: 'a2', status: 'pending' },
    ])

    const res = await GET(req())
    const body = await res.json()

    // Bounded: only the caller's own assignment ids in THIS payload are asked about.
    expect(fetchOwnOpenSwaps).toHaveBeenLastCalledWith(expect.anything(), 'c', ['a1'])
    expect(body.data).toEqual([
      { id: 'a1', profile_id: 'c', open_swap_status: 'pending', arrival: null },
      { id: 'a2', profile_id: 'other', open_swap_status: null, arrival: null },
    ])
  })

  // The Team view reads this same feed. A manager gets the field on their OWN
  // rows only: the read is keyed on the caller, and the annotate re-checks
  // profile_id, so other people's swap state never rides on this field.
  it("a manager reading the team feed gets no colleague's swap state", async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] })
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [{ id: 'a1', profile_id: 'coach-a' }, { id: 'a2', profile_id: 'm' }], error: null })
    fetchOwnOpenSwaps.mockResolvedValueOnce([
      { requester_shift_id: 'a1', status: 'pending' },
      { requester_shift_id: 'a2', status: 'awaiting_approval' },
    ])

    const body = await (await GET(req())).json()

    expect(fetchOwnOpenSwaps).toHaveBeenLastCalledWith(expect.anything(), 'm', ['a2'])
    expect(body.data).toEqual([
      { id: 'a1', profile_id: 'coach-a', open_swap_status: null, arrival: null },
      { id: 'a2', profile_id: 'm', open_swap_status: 'awaiting_approval', arrival: null },
    ])
  })

  it('a caller with no shift of their own in the window is asked about nothing', async () => {
    getCurrentUser.mockResolvedValue({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] })
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [{ id: 'a1', profile_id: 'coach-a' }], error: null })

    const body = await (await GET(req())).json()

    expect(fetchOwnOpenSwaps).toHaveBeenLastCalledWith(expect.anything(), 'm', [])
    expect(fetchOwnArrivalFacts).toHaveBeenLastCalledWith(expect.anything(), 'm', [], [])
    expect(body.data).toEqual([{ id: 'a1', profile_id: 'coach-a', open_swap_status: null, arrival: null }])
  })
})

// DATECHECK.1 — the phone's Schedule tab feed. Its range went to Postgres
// unchecked and came back as a 400 carrying Postgres's error text.
describe('GET /api/schedule/shifts — a date the calendar does not have', () => {
  const COACH = { id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }

  it('400s in the route\'s own words, before any read', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    for (const [qs, name] of [
      ['&start_date=2026-02-30&end_date=2026-03-06', 'start_date'],
      ['&start_date=2026-06-01&end_date=2026-06-31', 'end_date'],
    ]) {
      const res = await GET(req(`http://x/api/schedule/shifts?location_id=loc-1${qs}`))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: `${name}: not a real date` })
    }
    expect(fetchApiShiftRows).not.toHaveBeenCalled()
  })

  it('a real range (leap day included) is handed to the reader unchanged', async () => {
    getCurrentUser.mockResolvedValue(COACH)
    const res = await GET(req('http://x/api/schedule/shifts?location_id=loc-1&start_date=2028-02-28&end_date=2028-02-29'))
    expect(res.status).toBe(200)
    expect(fetchApiShiftRows.mock.calls[0][1]).toMatchObject({ startDate: '2028-02-28', endDate: '2028-02-29' })
  })
})

// ARRIVALSHOW.1 — the Schedule tab's arrival line reads `arrival`. Own rows only.
describe('GET /api/schedule/shifts — own arrival (ARRIVALSHOW.1)', () => {
  const coach = { id: 'c', role: 'staff', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
  const shiftRow = (id, profileId) => ({
    id, profile_id: profileId, location_id: 'loc-1', shift_date: '2026-10-01',
    block_start_time: '07:00:00', block_end_time: '08:00:00', start_time_override: null, end_time_override: null,
  })

  it("asks about the caller's own assignment ids and studios only", async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c'), shiftRow('a2', 'other')], error: null })
    await GET(req())
    expect(fetchOwnArrivalFacts).toHaveBeenLastCalledWith(expect.anything(), 'c', ['a1'], ['loc-1'])
  })

  it("puts the arrival on the caller's row and null on a colleague's", async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c'), shiftRow('a2', 'other')], error: null })
    fetchOwnArrivalFacts.mockResolvedValueOnce({
      stamps: new Map([
        ['a1', { id: 'a1', arrived_at: '2026-10-01T05:52:00.000Z', arrival_source: 'geofence' }],
        ['a2', { id: 'a2', arrived_at: '2026-10-01T05:40:00.000Z', arrival_source: 'geofence' }],
      ]),
      timezones: new Map([['loc-1', 'Europe/Dublin']]),
      tracked: new Map([['loc-1', true]]),
    })
    const body = await (await GET(req())).json()
    expect(body.data[0].arrival).toMatchObject({ at: '2026-10-01T05:52:00.000Z', at_local: '06:52', carried: false, tracked: true })
    expect(Number.isFinite(Date.parse(body.data[0].arrival.as_of))).toBe(true)
    expect(body.data[1].arrival).toBeNull()
  })

  it('a failed arrivals read still returns the roster, with no arrival on any row', async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c')], error: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.arrival)).toEqual([null])
  })

  it('an annotate that throws still returns the roster, with arrival: null on every row, and logs', async () => {
    getCurrentUser.mockResolvedValue(coach)
    fetchApiShiftRows.mockResolvedValueOnce({ rows: [shiftRow('a1', 'c'), shiftRow('a2', 'other')], error: null })
    fetchOwnOpenSwaps.mockResolvedValueOnce([{ requester_shift_id: 'a1', status: 'pending' }])
    annotateOwnArrivals.mockImplementationOnce(() => { throw new Error('boom') })
    logError.mockClear()
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => [r.id, r.arrival, r.open_swap_status])).toEqual([['a1', null, 'pending'], ['a2', null, null]])
    expect(logError).toHaveBeenCalledWith('schedule', expect.stringContaining('arrival'), expect.anything())
  })
})
