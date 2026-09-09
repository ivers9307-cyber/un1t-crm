// @vitest-environment jsdom
//
// ROSTER-FIX.6a — the schedule calendar's fetchData had no try/catch and no
// request ordering. Two live defects fell out of that:
//   1. Any failed fetch rejected the Promise.all, so setLoading(false) never
//      ran and the screen sat on "Loading roster..." forever with nothing
//      telling the operator why. (memory: discarded-error defect class)
//   2. Clicking the week arrow faster than the API answers let an OLDER
//      response land last and paint a week the operator had already left.
// These pin both.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useScheduleData } from './useScheduleData'

const ARGS = {
  locationId: 'loc1',
  startDate: '2026-05-04',
  endDate: '2026-05-10',
  spendReferenceDate: '2026-05-01',
}

// Every endpoint the hook fans out to, keyed by the path fragment that
// identifies it, so a test can answer one route differently from the rest.
function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

function defaultBody(url) {
  if (url.includes('/schedule/blocks')) return { data: [{ id: 'b1', block_date: '2026-05-04' }] }
  if (url.includes('/schedule/templates')) return { data: [{ id: 't1', active: true }, { id: 't2', active: false }] }
  if (url.includes('/api/staff')) return { data: [{ id: 's1' }] }
  if (url.includes('/schedule/time-off')) return { data: [{ id: 'to1' }] }
  if (url.includes('/holidays')) return { data: [{ date: '2026-05-04' }] }
  if (url.includes('contractor-spend')) return { success: true, data: { spend: 100 } }
  return { data: [] }
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
})
afterEach(() => { vi.restoreAllMocks() })

describe('useScheduleData', () => {
  it('loads every slice and clears loading', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.blocks).toHaveLength(1)
    // Inactive templates are filtered out here, as the calendar always did.
    expect(result.current.templates.map(t => t.id)).toEqual(['t1'])
    expect(result.current.staff).toHaveLength(1)
    expect(result.current.timeOff).toHaveLength(1)
    expect(result.current.holidays).toHaveLength(1)
    expect(result.current.contractorSpend).toEqual({ spend: 100 })
  })

  it('does not fetch without a location', async () => {
    const { result } = renderHook(() => useScheduleData({ ...ARGS, locationId: null }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('clears loading and sets error when a fetch rejects', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
  })

  it('clears loading and sets error when a route answers non-OK', async () => {
    global.fetch = vi.fn(async (url) =>
      url.includes('/schedule/blocks')
        ? { ok: false, status: 500, json: async () => ({ error: 'Could not read the roster' }) }
        : okResponse(defaultBody(url))
    )
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Could not read the roster')
  })

  it('surfaces an error even when the body is not JSON', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json') } }))
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/502/)
  })

  it('keeps the previously loaded week on screen when a refresh fails', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeTruthy()
    expect(result.current.blocks).toHaveLength(1)
  })

  it('clears a stale error on the next successful load', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeNull()
  })

  it('ignores an older response that resolves after a newer one', async () => {
    // Week A is slow, week B is fast. The operator clicks the arrow before A
    // answers; B paints, then A finally lands. A must be dropped.
    // Week A's requests are ALL held (three of the six carry the date) and
    // released together, or Promise.all never settles and the assertion is
    // vacuous - it passed with the guard deleted until this was fixed.
    const heldA = []
    global.fetch = vi.fn((url) => {
      if (!url.includes('2026-05-04')) return Promise.resolve(okResponse(defaultBody(url)))
      return new Promise((resolve) => {
        heldA.push(() => resolve(okResponse(
          url.includes('/schedule/blocks') ? { data: [{ id: 'STALE' }] } : defaultBody(url)
        )))
      })
    })

    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    // Navigate to week B before A has answered.
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.blocks.map(b => b.id)).toEqual(['b1'])

    await act(async () => { heldA.forEach(r => r()); await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.blocks.map(b => b.id)).toEqual(['b1'])
    expect(result.current.loading).toBe(false)
  })

  it('does not let a stale FAILED request wipe the current week', async () => {
    const gate = {}
    global.fetch = vi.fn((url) => {
      if (url.includes('2026-05-04')) {
        return new Promise((_resolve, reject) => { gate.failA = () => reject(new TypeError('Failed to fetch')) })
      }
      return Promise.resolve(okResponse(defaultBody(url)))
    })
    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { gate.failA(); await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})
