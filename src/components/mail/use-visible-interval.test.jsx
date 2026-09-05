// @vitest-environment jsdom
//
// MAIL-PERF.1 — the hook's WIRING, not the state machine (that is
// visible-interval.test.js). jsdom has no real visibility, so
// document.visibilityState is stubbed and the events dispatched by hand:
// what this proves is that the hook listens where it says it does and tears
// down what it set up.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useVisibleInterval } from './use-visible-interval'

let visibility = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  cleanup()
  delete document.visibilityState
  vi.useRealTimers()
})

const hide = () => act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
const show = () => act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
const focus = () => act(() => { window.dispatchEvent(new Event('focus')) })

describe('useVisibleInterval', () => {
  it('ticks per cadence while visible; not on mount by default', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    expect(fn).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('hidden tab: no tick; visible again: an immediate tick, then the cadence', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    hide()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(fn).not.toHaveBeenCalled()
    show()
    expect(fn).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('window focus refreshes (the old pollers\' behaviour, kept)', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    focus()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a tab switch (visibilitychange + focus together) is ONE refresh', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    hide()
    show()
    focus()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reads the LATEST callback without restarting the clock', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ fn }) => useVisibleInterval(fn, 1000), { initialProps: { fn: first } })
    act(() => { vi.advanceTimersByTime(600) })
    rerender({ fn: second })
    act(() => { vi.advanceTimersByTime(400) }) // the original clock lands here
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('enabled:false runs nothing and listens to nothing', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000, { enabled: false }))
    act(() => { vi.advanceTimersByTime(5000) })
    focus()
    hide(); show()
    expect(fn).not.toHaveBeenCalled()
  })

  it('immediate:true ticks on mount when visible', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000, { immediate: true }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('unmount tears down the clock and both listeners', () => {
    const fn = vi.fn()
    const { unmount } = renderHook(() => useVisibleInterval(fn, 1000))
    unmount()
    act(() => { vi.advanceTimersByTime(5000) })
    focus()
    hide(); show()
    expect(fn).not.toHaveBeenCalled()
  })

  it('a cadence change restarts the clock at the new interval', () => {
    const fn = vi.fn()
    const { rerender } = renderHook(({ ms }) => useVisibleInterval(fn, ms), { initialProps: { ms: 10_000 } })
    rerender({ ms: 1000 })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
