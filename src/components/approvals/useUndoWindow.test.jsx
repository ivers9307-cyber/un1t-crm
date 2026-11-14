// @vitest-environment jsdom
// APPROVALSQ.5 — the two-minute window an Undo button lives in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useUndoWindow, undoWindowOpen } from './useUndoWindow'
import { UNDO_CLEAR_WINDOW_MS } from '@/lib/approvals/undo-clear'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('undoWindowOpen', () => {
  it('is open strictly inside the window and closed at and after it', () => {
    expect(undoWindowOpen(1000, 1000)).toBe(true)
    expect(undoWindowOpen(1000, 1000 + UNDO_CLEAR_WINDOW_MS - 1)).toBe(true)
    expect(undoWindowOpen(1000, 1000 + UNDO_CLEAR_WINDOW_MS)).toBe(false)
  })
  it('is closed with no start', () => {
    expect(undoWindowOpen(null, 5)).toBe(false)
    expect(undoWindowOpen(undefined, 5)).toBe(false)
  })
})

describe('useUndoWindow', () => {
  it('is open at the start, still open a tick before the end, closed at 120 seconds', async () => {
    const start = Date.now()
    const { result } = renderHook(() => useUndoWindow(start))
    expect(result.current).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS - 1) })
    expect(result.current).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current).toBe(false)
  })

  it('is closed with no start and sets no timer', () => {
    const { result } = renderHook(() => useUndoWindow(null))
    expect(result.current).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one timer and clears it on unmount', () => {
    const start = Date.now()
    const { unmount } = renderHook(() => useUndoWindow(start))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a window that already ended is closed at once', () => {
    const start = Date.now() - UNDO_CLEAR_WINDOW_MS - 1
    const { result } = renderHook(() => useUndoWindow(start))
    expect(result.current).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a new start re-opens it', async () => {
    let start = Date.now()
    const { result, rerender } = renderHook(() => useUndoWindow(start))
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_CLEAR_WINDOW_MS) })
    expect(result.current).toBe(false)
    start = Date.now()
    rerender()
    expect(result.current).toBe(true)
  })
})
