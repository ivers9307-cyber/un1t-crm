// @vitest-environment jsdom
//
// GRID.1 — the grid's read. Pinned: it fires only while the grid is on screen,
// a failed first load is an error and not an empty grid, a failed refresh of
// the same week keeps the grid, and a slow answer for a week the manager has
// left never lands under the new one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'
import { useRosterGrid, browserStorage } from './useRosterGrid'

const ARGS = { locationId: 'loc1', weekStart: '2026-09-21', enabled: true }
const GRID = { week_start: '2026-09-21', week_end: '2026-09-27', members: [], shifts: [], cross_studio_checked: true }
const ok = (body) => ({ ok: true, status: 200, redirected: false, json: async () => body })

beforeEach(() => { global.fetch = vi.fn(async () => ok({ success: true, data: GRID })) })
// cleanup unmounts each hook's host tree before jsdom is torn down
// (see tests/rtl-cleanup-after-each.test.js).
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useRosterGrid', () => {
  it('asks for the studio and the week, and hands back the grid', async () => {
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.grid).toEqual(GRID))
    expect(global.fetch).toHaveBeenCalledWith('/api/schedule/grid?location_id=loc1&start_date=2026-09-21', undefined)
    expect(result.current.gridError).toBeNull()
    expect(result.current.gridLoading).toBe(false)
  })

  it('fires nothing while the grid is not on screen, or without a studio or a week', async () => {
    renderHook(() => useRosterGrid({ ...ARGS, enabled: false }))
    renderHook(() => useRosterGrid({ ...ARGS, locationId: null }))
    renderHook(() => useRosterGrid({ ...ARGS, weekStart: null }))
    await waitFor(() => expect(global.fetch).not.toHaveBeenCalled())
  })

  it('a failed first load is an error and no grid, never an empty grid', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, redirected: false, json: async () => ({ success: false, error: 'Could not load the coach grid' }) }))
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.gridError).toBe('Could not load the coach grid'))
    expect(result.current.grid).toBeNull()
  })

  it('a failed refresh of the same week keeps the grid on screen and names the failure', async () => {
    const { result } = renderHook(() => useRosterGrid(ARGS))
    await waitFor(() => expect(result.current.grid).toEqual(GRID))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refreshGrid() })
    expect(result.current.grid).toEqual(GRID)
    expect(result.current.gridError).toBe('Failed to fetch')
  })

  it('a slow answer for the week the manager has left never lands under the new one', async () => {
    const gate = {}
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      if (call === 1) return new Promise((resolve) => { gate.first = resolve })
      return ok({ success: true, data: { ...GRID, week_start: '2026-09-28' } })
    })
    const { result, rerender } = renderHook((props) => useRosterGrid(props), { initialProps: ARGS })
    rerender({ ...ARGS, weekStart: '2026-09-28' })
    await waitFor(() => expect(result.current.grid?.week_start).toBe('2026-09-28'))
    await act(async () => { gate.first(ok({ success: true, data: GRID })) })
    expect(result.current.grid.week_start).toBe('2026-09-28')
  })

  // GRID.1 review 2 — the grid in state belongs to ONE studio and week. The
  // first render after the manager moves must not hand back the old one: the
  // calendar would build the new week's rows from last week's shifts, which
  // reads as everyone 0h and every contract "to place" (a false all-clear).
  // Every render is recorded, so the frame BEFORE the effect runs is checked.
  for (const [what, next] of [
    ['a week change', { weekStart: '2026-09-28' }],
    ['a studio change', { locationId: 'loc2' }],
  ]) {
    it(`${what}: not one render hands back the previous grid, and it reads as loading, not empty`, async () => {
      const renders = []
      const { result, rerender } = renderHook((props) => {
        const r = useRosterGrid(props)
        renders.push({ props, ...r })
        return r
      }, { initialProps: ARGS })
      await waitFor(() => expect(result.current.grid).toEqual(GRID))
      let release
      global.fetch = vi.fn(() => new Promise((resolve) => { release = resolve }))
      const from = renders.length
      rerender({ ...ARGS, ...next })
      const after = renders.slice(from)
      expect(after.length).toBeGreaterThan(0)
      for (const r of after) {
        expect(r.grid).toBeNull()
        expect(r.gridLoading).toBe(true)
        expect(r.gridError).toBeNull()
      }
      await act(async () => { release(ok({ success: true, data: { ...GRID, week_start: next.weekStart || GRID.week_start } })) })
      expect(result.current.grid).not.toBeNull()
      expect(result.current.gridLoading).toBe(false)
    })
  }

  it("a failure for the previous week is not shown under the new one", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, redirected: false, json: async () => ({ success: false, error: 'db down' }) }))
    const renders = []
    const { result, rerender } = renderHook((props) => {
      const r = useRosterGrid(props)
      renders.push(r)
      return r
    }, { initialProps: ARGS })
    await waitFor(() => expect(result.current.gridError).toBe('db down'))
    global.fetch = vi.fn(() => new Promise(() => {}))
    const from = renders.length
    rerender({ ...ARGS, weekStart: '2026-09-28' })
    for (const r of renders.slice(from)) expect(r.gridError).toBeNull()
  })

  it('browserStorage is localStorage, or null when the browser refuses it', () => {
    expect(browserStorage()).toBe(window.localStorage)
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError') })
    expect(browserStorage()).toBeNull()
    spy.mockRestore()
  })
})
