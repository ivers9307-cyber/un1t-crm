// WORKTIME.1 — GET /api/schedule/working-time. The rules are pinned in
// shared/working-time.test.js and the read in src/lib/working-time-data.test.js.
// Locked here: the gate, who is asked about, and what never leaves the route.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: vi.fn(() => null),
    // REAL: the role AT the block's studio is what is under test.
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/working-time-data', () => ({ loadWorkingTimeShifts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser, assertLocationAccessOr404 } = await import('@/lib/auth')
const { loadWorkingTimeShifts } = await import('@/lib/working-time-data')
const { GET } = await import('./route.js')
const { NextResponse } = await import('next/server')

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BLOCK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// Wednesday 23 Sep 2026, 06:30-08:00.
const BLOCK = {
  id: BLOCK_ID, location_id: LOC, block_date: '2026-09-23', start_time: '06:30:00', end_time: '08:00:00',
  shift_templates: { name: 'Early', start_time: '06:30:00', end_time: '08:00:00' },
  shift_assignments: [{ profile_id: 'already', status: 'scheduled' }, { profile_id: 'gone', status: 'cancelled' }],
}
const MEMBERS = ['already', 'gone', 'late', 'busy', 'free', 'con']

const row = (profile_id, block_id, block_date, start_time, end_time, over = {}) => ({
  profile_id, block_id, block_date, start_time, end_time, location_id: LOC, location_name: 'Studio North', name: 'Class', ...over,
})
const READ = {
  shifts: [
    // Closes the other studio at 22:00 the night before: 8h 30m to 06:30.
    row('late', 'hs-1', '2026-09-22', '20:00:00', '22:00:00', { location_id: OTHER, location_name: 'Studio South', name: 'Evening' }),
    // 47 hours already this week; the 1h 30m shift makes 48h 30m.
    row('busy', 'b1', '2026-09-21', '09:00:00', '18:00:00'),
    row('busy', 'b2', '2026-09-22', '09:00:00', '18:00:00'),
    row('busy', 'b4', '2026-09-24', '09:00:00', '18:00:00'),
    row('busy', 'b5', '2026-09-25', '09:00:00', '18:00:00'),
    row('busy', 'b6', '2026-09-26', '09:00:00', '20:00:00'),
    // A contractor the reader should never have returned: the route must not list them either.
    row('con', 'c1', '2026-09-22', '21:00:00', '23:00:00'),
  ],
  people: new Map([
    ['late', { full_name: 'Sam Demo', employment_type: 'fte' }],
    ['busy', { full_name: 'Max Beta', employment_type: 'fte' }],
    ['free', { full_name: 'Toby Beta', employment_type: 'fte' }],
    ['con', { full_name: 'Casey Manager', employment_type: 'contractor' }],
  ]),
  crossStudioChecked: true,
  error: null,
}

function dbWith({ block = BLOCK, blockError = null, members = MEMBERS } = {}) {
  return {
    from(table) {
      if (table === 'shift_blocks') {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: blockError ? null : block, error: blockError }) }
        return chain
      }
      if (table === 'profile_locations') {
        return { select: () => ({ eq: async () => ({ data: members.map((profile_id) => ({ profile_id })), error: null }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const req = (params = {}) => {
  const url = new URL('http://test/api/schedule/working-time')
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return { url: url.toString() }
}
const userWith = (rolesByLocation, profileRole = 'staff') => ({
  id: 'u1', profileRole, rolesByLocation, locations: Object.keys(rolesByLocation).map((id) => ({ id })),
})

let db
beforeEach(() => {
  db = dbWith()
  createServerClient.mockReset().mockImplementation(() => db)
  getCurrentUser.mockReset()
  assertLocationAccessOr404.mockReset().mockReturnValue(null)
  loadWorkingTimeShifts.mockReset().mockResolvedValue(READ)
})

describe('GET /api/schedule/working-time', () => {
  it('403 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(403)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('403 for a coach at the block\'s studio, even though they manage another', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'staff', [OTHER]: 'manager' }))
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(403)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('400 on a missing or malformed block_id', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    expect((await GET(req({}))).status).toBe(400)
    expect((await GET(req({ block_id: 'nope' }))).status).toBe(400)
  })

  it('404 when the block does not exist', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    db = dbWith({ block: null })
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(404)
  })

  it('404, not 403, for a manager of another studio: the id is not confirmed', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [OTHER]: 'manager' }))
    assertLocationAccessOr404.mockReturnValue(NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }))
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(404)
    expect(loadWorkingTimeShifts).not.toHaveBeenCalled()
  })

  it('200: lists the employees this shift would leave short of rest or over 48 hours, from ONE read of the week', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'head_coach' }))
    const res = await GET(req({ block_id: BLOCK_ID }))
    expect(res.status).toBe(200)
    expect(loadWorkingTimeShifts).toHaveBeenCalledTimes(1)
    expect(loadWorkingTimeShifts).toHaveBeenCalledWith(db, {
      locationId: LOC, profileIds: ['gone', 'late', 'busy', 'free', 'con'], from: '2026-09-20', to: '2026-09-28',
    })
    expect(await res.json()).toEqual({
      success: true,
      data: {
        checked: true,
        untimed: 0,
        byProfile: {
          late: {
            restGap: { rest_minutes: 510, side: 'before', other: { block_id: 'hs-1', date: '2026-09-22', start: '20:00', end: '22:00', name: 'Evening', location_name: 'Studio South' } },
            weekHours: null,
          },
          busy: { restGap: null, weekHours: { week_start: '2026-09-21', minutes: 2910 } },
        },
      },
    })
  })

  it('never lists a contractor or someone already on the block, and no pay or employment field leaves the route', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    const body = await (await GET(req({ block_id: BLOCK_ID }))).json()
    expect(Object.keys(body.data.byProfile).sort()).toEqual(['busy', 'late'])
    expect(JSON.stringify(body)).not.toMatch(/employment|contractor|hourly|salary|contracted|rate|full_name/i)
  })

  it('a failed working-time read is checked:false with nobody listed, never an all-clear', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    loadWorkingTimeShifts.mockResolvedValue({ shifts: [], people: new Map(), crossStudioChecked: false, error: { message: 'down' } })
    const res = await GET(req({ block_id: BLOCK_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { byProfile: {}, checked: false, untimed: 0 } })
  })

  it('counts the candidates\' shifts it could not time, and the shift itself if it has none', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    loadWorkingTimeShifts.mockResolvedValue({ ...READ, shifts: [...READ.shifts, row('free', 'nt', '2026-09-24', null, null), row('con', 'nt2', '2026-09-24', null, null)] })
    expect((await (await GET(req({ block_id: BLOCK_ID }))).json()).data.untimed).toBe(1)
    db = dbWith({ block: { ...BLOCK, start_time: null, end_time: null, shift_templates: { name: 'Early' } } })
    loadWorkingTimeShifts.mockResolvedValue(READ)
    const body = await (await GET(req({ block_id: BLOCK_ID }))).json()
    expect(body.data).toMatchObject({ byProfile: {}, untimed: 1 })
  })

  it('500 when the block read fails', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [LOC]: 'manager' }))
    db = dbWith({ blockError: { message: 'db down' } })
    expect((await GET(req({ block_id: BLOCK_ID }))).status).toBe(500)
  })
})
