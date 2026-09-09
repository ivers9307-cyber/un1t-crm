// ROSTER-FIX.7 — the wire contract of every /api/schedule/* call the mobile
// app makes: path, query string, method and body shape.
//
// Why it earns its keep: these wrappers are the ONLY place the mobile app
// spells the route contract, and nothing else checks them. A renamed query
// param or a body key that drifts from the route's Zod schema fails at
// runtime, on a handset, as an unexplained 400 — and half of these calls are
// mutations a coach or manager only makes occasionally. Mocking ./api keeps it
// a pure contract test: no network, no Supabase, no RN runtime.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn(() => Promise.resolve({ success: true, data: [] })) }))

const { api } = await import('./api')
const schedule = await import('./schedule-api')

const LOC = 'a0000000-0000-0000-0000-000000000001'

// The single call `api` received, as [path, options].
function lastCall() {
  expect(api).toHaveBeenCalledTimes(1)
  return api.mock.calls[0]
}
// Query params of the single call, order-insensitive.
function lastQuery() {
  const [path] = lastCall()
  const [, qs = ''] = path.split('?')
  return Object.fromEntries(new URLSearchParams(qs))
}
function lastPathname() {
  return lastCall()[0].split('?')[0]
}

beforeEach(() => { api.mockClear() })

describe('schedule-api — every helper is exercised', () => {
  it('exports exactly the helpers this file pins', () => {
    // A new helper added without a test below fails here rather than shipping
    // its path unchecked.
    expect(Object.keys(schedule).sort()).toEqual([
      'adjustShiftAssignment',
      'assignCoachToBlock',
      'cancelSwapRequest',
      'cancelTimeOffRequest',
      'createSwapRequest',
      'createTimeOffRequest',
      'getLocationStaff',
      'getMyShifts',
      'getMyTimeOff',
      'getOpenSwaps',
      'getScheduleBlocks',
      'getSwapsForMe',
      'getTeamShifts',
      'removeAssignment',
      'respondToSwap',
      'respondToTimeOff',
    ])
  })
})

describe('shift reads', () => {
  it('getMyShifts GETs /api/schedule/shifts scoped to one profile and week', () => {
    schedule.getMyShifts({ locationId: LOC, profileId: 'p1', startDate: '2026-09-07', endDate: '2026-09-13' })
    expect(lastPathname()).toBe('/api/schedule/shifts')
    expect(lastQuery()).toEqual({
      location_id: LOC, profile_id: 'p1', start_date: '2026-09-07', end_date: '2026-09-13',
    })
    // No method → GET; locationId rides as the x-active-location override.
    expect(lastCall()[1]).toEqual({ locationId: LOC })
  })

  it('getTeamShifts hits the SAME route with no profile_id — that omission is the whole difference', () => {
    schedule.getTeamShifts({ locationId: LOC, startDate: '2026-09-07', endDate: '2026-09-13' })
    expect(lastPathname()).toBe('/api/schedule/shifts')
    expect(lastQuery()).toEqual({ location_id: LOC, start_date: '2026-09-07', end_date: '2026-09-13' })
    expect(lastQuery().profile_id).toBeUndefined()
  })

  it('omits absent params rather than sending empty ones', () => {
    schedule.getMyShifts({})
    expect(lastCall()[0]).toBe('/api/schedule/shifts?')
    expect(lastQuery()).toEqual({})
  })
})

describe('time off', () => {
  it('getMyTimeOff GETs /api/schedule/time-off with the optional status filter', () => {
    schedule.getMyTimeOff({ locationId: LOC, profileId: 'p1', status: 'pending' })
    expect(lastPathname()).toBe('/api/schedule/time-off')
    expect(lastQuery()).toEqual({ location_id: LOC, profile_id: 'p1', status: 'pending' })
  })

  it('createTimeOffRequest POSTs snake_case dates and carries location_id in the BODY as well', () => {
    schedule.createTimeOffRequest({
      type: 'holiday', startDate: '2026-09-21', endDate: '2026-09-25', reason: 'Away', locationId: LOC,
    })
    expect(lastCall()).toEqual(['/api/schedule/time-off', {
      method: 'POST',
      locationId: LOC,
      body: { type: 'holiday', start_date: '2026-09-21', end_date: '2026-09-25', reason: 'Away', location_id: LOC },
    }])
  })

  it('createTimeOffRequest sends reason: null, never an empty string', () => {
    schedule.createTimeOffRequest({ type: 'sick', startDate: '2026-09-21', endDate: '2026-09-21', reason: '', locationId: LOC })
    expect(lastCall()[1].body.reason).toBe(null)
  })

  it('cancelTimeOffRequest PUTs status: cancelled to the detail route', () => {
    schedule.cancelTimeOffRequest('t1', LOC)
    expect(lastCall()).toEqual(['/api/schedule/time-off/t1', {
      method: 'PUT', locationId: LOC, body: { status: 'cancelled' },
    }])
  })

  it('respondToTimeOff PUTs the decision plus a nullable review note', () => {
    schedule.respondToTimeOff('t1', 'approved', 'Cover arranged', LOC)
    expect(lastCall()).toEqual(['/api/schedule/time-off/t1', {
      method: 'PUT', locationId: LOC, body: { status: 'approved', review_note: 'Cover arranged' },
    }])
  })

  it('respondToTimeOff is also the coach-side self-cancel (ROSTER-FIX.7)', () => {
    schedule.respondToTimeOff('t1', 'cancelled', null, LOC)
    expect(lastCall()[1].body).toEqual({ status: 'cancelled', review_note: null })
  })
})

describe('swaps', () => {
  it('createSwapRequest POSTs the ASSIGNMENT id as requester_shift_id, with null targets', () => {
    schedule.createSwapRequest({ requesterShiftId: 'a1', locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/swaps', {
      method: 'POST',
      locationId: LOC,
      body: { requester_shift_id: 'a1', target_shift_id: null, target_id: null, reason: null },
    }])
  })

  it('createSwapRequest carries a directed target when one is named', () => {
    schedule.createSwapRequest({ requesterShiftId: 'a1', targetShiftId: 'a2', targetId: 'p2', reason: 'Swap?', locationId: LOC })
    expect(lastCall()[1].body).toEqual({
      requester_shift_id: 'a1', target_shift_id: 'a2', target_id: 'p2', reason: 'Swap?',
    })
  })

  it('respondToSwap PUTs status + nullable review_note', () => {
    schedule.respondToSwap('s1', 'approved', null, LOC)
    expect(lastCall()).toEqual(['/api/schedule/swaps/s1', {
      method: 'PUT', locationId: LOC, body: { status: 'approved', review_note: null },
    }])
  })

  it('cancelSwapRequest PUTs status: cancelled', () => {
    schedule.cancelSwapRequest('s1', LOC)
    expect(lastCall()).toEqual(['/api/schedule/swaps/s1', {
      method: 'PUT', locationId: LOC, body: { status: 'cancelled' },
    }])
  })

  it('getSwapsForMe and getOpenSwaps are the SAME route split by one flag', () => {
    schedule.getSwapsForMe({ locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/swaps')
    expect(lastQuery()).toEqual({ location_id: LOC, for_me: '1' })

    api.mockClear()
    schedule.getOpenSwaps({ locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/swaps')
    expect(lastQuery()).toEqual({ location_id: LOC, open: '1' })
  })
})

describe('assignments and blocks (manager surfaces)', () => {
  it('adjustShiftAssignment PUTs all three override fields, coalescing undefined to null', () => {
    schedule.adjustShiftAssignment('a1', { startTime: '09:00', endTime: '12:00', reason: 'Late start', locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/assignments/a1', {
      method: 'PUT',
      locationId: LOC,
      body: { start_time_override: '09:00', end_time_override: '12:00', partial_reason: 'Late start' },
    }])
  })

  it('adjustShiftAssignment sends explicit nulls to CLEAR an override, not an absent key', () => {
    schedule.adjustShiftAssignment('a1', { startTime: null, endTime: null, reason: null, locationId: LOC })
    expect(lastCall()[1].body).toEqual({ start_time_override: null, end_time_override: null, partial_reason: null })
    api.mockClear()
    schedule.adjustShiftAssignment('a1', { locationId: LOC })
    expect(lastCall()[1].body).toEqual({ start_time_override: null, end_time_override: null, partial_reason: null })
  })

  it('removeAssignment DELETEs the detail route with no body', () => {
    schedule.removeAssignment('a1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/assignments/a1', { method: 'DELETE', locationId: LOC }])
  })

  it('getScheduleBlocks GETs the week of blocks for the location', () => {
    schedule.getScheduleBlocks({ locationId: LOC, startDate: '2026-09-07', endDate: '2026-09-13' })
    expect(lastPathname()).toBe('/api/schedule/blocks')
    expect(lastQuery()).toEqual({ location_id: LOC, start_date: '2026-09-07', end_date: '2026-09-13' })
  })

  it('assignCoachToBlock POSTs to the nested assignments collection', () => {
    schedule.assignCoachToBlock('b1', { profileId: 'p2', locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/blocks/b1/assignments', {
      method: 'POST', locationId: LOC, body: { profile_id: 'p2', allow_over_capacity: undefined },
    }])
  })

  it('assignCoachToBlock only sends allow_over_capacity when the operator confirmed the override', () => {
    schedule.assignCoachToBlock('b1', { profileId: 'p2', allowOverCapacity: true, locationId: LOC })
    expect(lastCall()[1].body.allow_over_capacity).toBe(true)
  })

  it('getLocationStaff pins the pay-free picker shape (ROSTER-FIX.2)', () => {
    schedule.getLocationStaff({ locationId: LOC })
    // fields=picker is load-bearing: plain /api/staff hands an admin caller
    // hourly_rate and annual_salary just to render a dropdown.
    expect(lastCall()).toEqual(['/api/staff?fields=picker', { locationId: LOC }])
  })
})
