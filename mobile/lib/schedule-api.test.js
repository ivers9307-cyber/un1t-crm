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
      'claimShiftOffer',
      'createSwapRequest',
      'createTimeOffRequest',
      'getBlockCandidates',
      'getLeavePreview',
      'getLocationStaff',
      'getManagedOffers',
      'getMyAllowance',
      'getMyShifts',
      'getMyTimeOff',
      'getOffersForMe',
      'getOpenSwaps',
      'getScheduleBlocks',
      'getSwapsForMe',
      'getTeamShifts',
      'offerBlockToTeam',
      'removeAssignment',
      'replaceAssignment',
      'respondToSwap',
      'respondToTimeOff',
      'unassignLeaveClashes',
      'withdrawLeaveCancelRequest',
      'withdrawShiftOffer',
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

  it('getMyShifts asks for arrivals only when told to (ARRIVALSHOW.1: the Schedule tab Me view)', () => {
    schedule.getMyShifts({ locationId: LOC, profileId: 'p1', startDate: '2026-09-07', endDate: '2026-09-13', withArrivals: true })
    expect(lastQuery()).toEqual({
      location_id: LOC, profile_id: 'p1', start_date: '2026-09-07', end_date: '2026-09-13', include: 'arrival',
    })
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

  // LEAVECANCEL.1 — the requester withdraws their ask; the leave stays approved.
  it('withdrawLeaveCancelRequest DELETEs the cancel-request sub-route', () => {
    schedule.withdrawLeaveCancelRequest('t1', LOC)
    expect(lastCall()).toEqual(['/api/schedule/time-off/t1/cancel-request', { method: 'DELETE', locationId: LOC }])
  })

  it('unassignLeaveClashes POSTs only the shifts the approver was shown', () => {
    schedule.unassignLeaveClashes('t1', { assignmentIds: ['a1', 'a2'], locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/time-off/t1/unassign-clashes', {
      method: 'POST', locationId: LOC, body: { assignment_ids: ['a1', 'a2'] },
    }])
  })

  it('respondToTimeOff PUTs the decision plus a nullable review note', () => {
    schedule.respondToTimeOff('t1', 'approved', 'Cover arranged', LOC)
    expect(lastCall()).toEqual(['/api/schedule/time-off/t1', {
      method: 'PUT', locationId: LOC, body: { status: 'approved', review_note: 'Cover arranged' },
    }])
  })

  // ROSTER-FIX.7f — the coach-side self-cancel goes through
  // cancelTimeOffRequest (above); respondToTimeOff is the MANAGER decision
  // helper and keeps its own contract because approvals.jsx still calls it.
  // Both hit the same PUT, so pin that a manager-issued 'cancelled' still
  // carries the review_note field the approvals screen relies on.
  it('respondToTimeOff can also carry a cancelled decision', () => {
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

  it('respondToSwap with confirmConflicts re-sends the approval as confirm_conflicts: true', () => {
    schedule.respondToSwap('s1', 'approved', null, LOC, { confirmConflicts: true })
    expect(lastCall()).toEqual(['/api/schedule/swaps/s1', {
      method: 'PUT', locationId: LOC, body: { status: 'approved', review_note: null, confirm_conflicts: true },
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

  it('getBlockCandidates GETs the ranked list for one block through api(), escaping the id (CANDIDATES.1)', () => {
    schedule.getBlockCandidates('b1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/blocks/b1/candidates', { locationId: LOC }])
    api.mockClear()
    schedule.getBlockCandidates('a/b', { locationId: LOC })
    expect(lastCall()[0]).toBe('/api/schedule/blocks/a%2Fb/candidates')
  })
})

describe('LEAVEPHONE.1 — leave form reads', () => {
  it('getMyAllowance asks for the caller\'s own allowance: a year, and NO profile_id', async () => {
    await schedule.getMyAllowance({ year: 2026, locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/allowances')
    expect(lastQuery()).toEqual({ year: '2026' })
    expect(lastCall()[1]).toEqual({ locationId: LOC })
  })

  it('getLeavePreview sends preview=1, the type, the route\'s date names and the studio the POST will file at — and NO profile_id', async () => {
    await schedule.getLeavePreview({ type: 'holiday', startDate: '2026-06-01', endDate: '2026-06-07', locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/time-off')
    expect(lastQuery()).toEqual({ preview: '1', type: 'holiday', start_date: '2026-06-01', end_date: '2026-06-07', location_id: LOC })
    expect(lastCall()[1]).toEqual({ locationId: LOC })
  })

  it('getLeavePreview with a one-tap pick sends end_date = start_date; no studio sends no location_id', async () => {
    await schedule.getLeavePreview({ type: 'sick', startDate: '2026-10-05', endDate: null, locationId: undefined })
    expect(lastQuery()).toEqual({ preview: '1', type: 'sick', start_date: '2026-10-05', end_date: '2026-10-05' })
  })

  it('getLeavePreview asks about the SAME studio createTimeOffRequest files at', async () => {
    await schedule.getLeavePreview({ type: 'holiday', startDate: '2026-06-01', endDate: '2026-06-07', locationId: LOC })
    const previewStudio = lastQuery().location_id
    api.mockClear()   // lastCall() insists on exactly one call
    await schedule.createTimeOffRequest({ type: 'holiday', startDate: '2026-06-01', endDate: '2026-06-07', locationId: LOC })
    expect(lastCall()[1].body.location_id).toBe(previewStudio)
    expect(previewStudio).toBe(LOC)
  })
})

describe('REPLACE.1a — replaceAssignment', () => {
  it('POSTs the new coach to /assignments/:id/replace, confirm only when asked', () => {
    schedule.replaceAssignment('as-1', { profileId: 'p2', locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/assignments/as-1/replace', { method: 'POST', locationId: LOC, body: { profile_id: 'p2' } }])
    api.mockClear()
    schedule.replaceAssignment('as-1', { profileId: 'p2', confirmConflicts: true, locationId: LOC })
    expect(lastCall()[1].body).toEqual({ profile_id: 'p2', confirm_conflicts: true })
  })
})

describe('REPLACE.1b — offer wrappers', () => {
  it('coach list, manager list, offer, claim, withdraw', () => {
    schedule.getOffersForMe({ locationId: LOC })
    expect(lastPathname()).toBe('/api/schedule/offers'); expect(lastQuery()).toEqual({ location_id: LOC }); api.mockClear()
    schedule.getManagedOffers({ locationId: LOC, startDate: '2026-09-28', endDate: '2026-10-04' })
    expect(lastQuery()).toEqual({ location_id: LOC, view: 'manage', start_date: '2026-09-28', end_date: '2026-10-04' }); api.mockClear()
    schedule.offerBlockToTeam('b1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/blocks/b1/offer', { method: 'POST', locationId: LOC }]); api.mockClear()
    schedule.claimShiftOffer('o1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/offers/o1/claim', { method: 'POST', locationId: LOC }]); api.mockClear()
    schedule.withdrawShiftOffer('o1', { locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/offers/o1', { method: 'DELETE', locationId: LOC }])
  })
})
