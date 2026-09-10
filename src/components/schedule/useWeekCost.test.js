// @vitest-environment jsdom
//
// ROSTER-FIX.6c — the FTE hours slice is a separate hook precisely so it can
// fail without the roster failing. These pin the three properties that decision
// rests on: it fails soft, it never fires for a non-manager, and a slow answer
// for a week the operator has left cannot overwrite a newer one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useWeekCost } from './useWeekCost'

const ARGS = { locationId: 'loc1', weekStart: '2026-05-04', enabled: true }

const PAYLOAD = {
  weekStartIso: '2026-05-04',
  weekEndIso: '2026-05-10',
  coaches: [{ profile_id: 'p1', full_name: 'Sarah', allocated_hours: 34, contracted_hours: 30, overtime_hours: 4, status: 'overtime', over_threshold: true }],
  totals: { coaches: 1, allocated_hours: 34, overtime_hours: 4, over_threshold: 1 },
}

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

beforeEach(() => {
  global.fetch = vi.fn(async () => okResponse({ success: true, data: PAYLOAD }))
})
afterEach(() => { vi.restoreAllMocks() })

describe('useWeekCost', () => {
  it('loads the week and asks for the location and week it was given', async () => {
    const { result } = renderHook(() => useWeekCost(ARGS))
    await waitFor(() => expect(result.current.weekCost).toEqual(PAYLOAD))
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/schedule/week-cost?location_id=loc1&week_start=2026-05-04'
    )
  })

  it('fires nothing at all when disabled, so a coach never asks for a 403', async () => {
    const { result } = renderHook(() => useWeekCost({ ...ARGS, enabled: false }))
    await waitFor(() => expect(result.current.weekCost).toBeNull())
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fires nothing without a location or a week', async () => {
    renderHook(() => useWeekCost({ ...ARGS, locationId: null }))
    renderHook(() => useWeekCost({ ...ARGS, weekStart: null }))
    await waitFor(() => expect(global.fetch).not.toHaveBeenCalled())
  })

  it('fails soft on a server error: no rows, a named error, nothing thrown', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'blocks read failed' }) }))
    const { result } = renderHook(() => useWeekCost(ARGS))
    await waitFor(() => expect(result.current.weekCostError).toBe('blocks read failed'))
    expect(result.current.weekCost).toBeNull()
  })

  it('fails soft on a thrown fetch and on a non-JSON body', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useWeekCost(ARGS))
    await waitFor(() => expect(result.current.weekCostError).toBe('Network error'))

    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json') } }))
    const second = renderHook(() => useWeekCost({ ...ARGS, weekStart: '2026-05-11' }))
    await waitFor(() => expect(second.result.current.weekCostError).toBe('Request failed (502)'))
  })

  it('drops a stale response that resolves after a newer one', async () => {
    const gate = {}
    const first = new Promise((resolve) => { gate.resolveFirst = resolve })
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      if (call === 1) return first
      return okResponse({ success: true, data: { ...PAYLOAD, weekStartIso: 'NEWER' } })
    })

    const { result } = renderHook(() => useWeekCost(ARGS))
    // A second request supersedes the first while it is still in flight.
    await act(async () => { await result.current.refreshWeekCost() })
    expect(result.current.weekCost.weekStartIso).toBe('NEWER')

    await act(async () => {
      gate.resolveFirst(okResponse({ success: true, data: { ...PAYLOAD, weekStartIso: 'STALE' } }))
      await first
    })
    expect(result.current.weekCost.weekStartIso).toBe('NEWER')
  })

  it('a stale FAILURE cannot blank a newer success either', async () => {
    const gate = {}
    const first = new Promise((_resolve, reject) => { gate.rejectFirst = reject })
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      if (call === 1) return first
      return okResponse({ success: true, data: PAYLOAD })
    })

    const { result } = renderHook(() => useWeekCost(ARGS))
    await act(async () => { await result.current.refreshWeekCost() })
    expect(result.current.weekCost).toEqual(PAYLOAD)

    await act(async () => {
      gate.rejectFirst(new TypeError('Failed to fetch'))
      await first.catch(() => {})
    })
    expect(result.current.weekCost).toEqual(PAYLOAD)
    expect(result.current.weekCostError).toBeNull()
  })

  // ROSTER-FIX.6c — the cancelling path used to clear the rows and return
  // WITHOUT bumping the generation, so the request already in flight still
  // carried the current stamp and wrote when it landed: a week's hours under a
  // location the operator had already left.
  it('a request cancelled by a falsy input cannot write when it finally lands', async () => {
    const gate = {}
    const held = new Promise((resolve) => { gate.resolve = resolve })
    global.fetch = vi.fn(() => held)

    const { result, rerender } = renderHook(
      ({ locationId }) => useWeekCost({ ...ARGS, locationId }),
      { initialProps: { locationId: 'loc1' } }
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    // The location goes away while the answer is still in flight.
    await act(async () => { rerender({ locationId: null }) })
    expect(result.current.weekCost).toBeNull()

    await act(async () => {
      gate.resolve(okResponse({ success: true, data: PAYLOAD }))
      await held
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.weekCost).toBeNull()
    expect(result.current.weekCostError).toBeNull()
  })
})
