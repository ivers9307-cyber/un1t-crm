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

import { useScheduleData, readJson, SESSION_ENDED_MESSAGE, NO_ACCESS_MESSAGE } from './useScheduleData'

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

// ROSTER-FIX.6a-8 — an expired cookie answers 401 on every schedule endpoint
// at once. As "Request failed (401)" that reads like an outage and sends the
// operator hunting for a server problem, so the one thing they can actually do
// about it is named instead. No redirect: unpublished roster edits may be on
// screen. A 403 is a DIFFERENT state (a live session that may not read this
// location) and must not tell them to sign in again.
describe('readJson session handling (ROSTER-FIX.6a-8)', () => {
  it('names a signed-out session on 401', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('keeps the server\'s own words on a 403, and never says signed out', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden - location not in your assignments' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow('Forbidden - location not in your assignments')
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden - location not in your assignments' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.not.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('falls back to a permission sentence when a 403 carries no message', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(NO_ACCESS_MESSAGE)
  })

  it('says so even when the 401 body is not JSON', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => { throw new Error('not json') } }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('leaves other statuses to the server\'s own words', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Database is unavailable' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow('Database is unavailable')
  })

  it('surfaces the signed-out message through the hook', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(SESSION_ENDED_MESSAGE)
  })

  // ROSTER-FIX.6a-8 (finding 7) — every other failure fixture omits
  // `success`, so `!res.ok` could be deleted from the check and the suite
  // would still pass. This one is non-OK AND claims success.
  it('fails a non-OK response even when the body claims success', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: true }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(/500/)
  })
})

// ROSTER-FIX.6a-9 (finding 4) — keeping the last-good data under the banner is
// right for a flaky refresh of the SAME week and wrong the moment the header
// has moved on: the previous week's blocks then render under the new week's
// dates, and a sparse week reads as "nobody is rostered" with nothing on
// screen saying otherwise.
describe('stale data on a failed load (ROSTER-FIX.6a-9)', () => {
  it('keeps the week on screen when a refresh of THAT week fails, and flags it', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))

    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })

    expect(result.current.error).toBeTruthy()
    expect(result.current.blocks).toHaveLength(1)
    expect(result.current.showingStaleData).toBe(true)
  })

  it('clears the range-scoped slices when the load for a DIFFERENT range fails', async () => {
    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    expect(result.current.contractorSpend).toEqual({ spend: 100 })

    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.blocks).toEqual([])
    expect(result.current.contractorSpend).toBeNull()
    // Nothing is being shown, so the banner must not claim otherwise.
    expect(result.current.showingStaleData).toBe(false)
  })

  it('does not flag stale data when the very first load fails', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showingStaleData).toBe(false)
    expect(result.current.blocks).toEqual([])
  })

  it('drops the stale flag once a load succeeds again', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })
    expect(result.current.showingStaleData).toBe(true)

    global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
    await act(async () => { await result.current.refresh() })
    expect(result.current.showingStaleData).toBe(false)
    expect(result.current.error).toBeNull()
  })
})
