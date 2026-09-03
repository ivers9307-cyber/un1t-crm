// @vitest-environment jsdom
//
// MAIL-HOOKS.1 — the serial action queue's own contract, tested at the hook
// seam (MailSurface.test.jsx pins the same behaviour end-to-end through the
// rendered surface; this file pins the machinery directly so a queue
// regression names the queue, not a symptom three components away).
//
// The perform* callbacks here are DEFERRED on purpose: every ordering claim
// below ("item 2 waits for item 1") is only a claim at all while item 1 is
// genuinely still in flight, so each test holds the resolve in its own hand.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useActionQueue } from './use-action-queue'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** An archive stub whose every call parks until the test resolves it. */
function deferredArchive(log) {
  const calls = []
  const fn = vi.fn((row, archived) => new Promise((resolve) => {
    if (log) log.push(`archive:${row.id}:${archived}`)
    calls.push({ row, archived, resolve })
  }))
  return { fn, calls }
}

function setup(overrides = {}) {
  const log = []
  const archiveCtl = deferredArchive(log)
  const mountedRef = { current: true }
  const setActionSaving = vi.fn()
  const setBusyId = vi.fn()
  const props = {
    performArchive: archiveCtl.fn,
    performMarkUnread: vi.fn(async (row) => { log.push(`markUnread:${row.id}`) }),
    performMarkRead: vi.fn(async (row) => { log.push(`markRead:${row.id}`) }),
    setActionSaving,
    setBusyId,
    mountedRef,
    ...overrides,
  }
  const view = renderHook(() => useActionQueue(props))
  return { ...view, props, log, archiveCtl, mountedRef, setActionSaving, setBusyId }
}

describe('useActionQueue — serial drain', () => {
  it('runs one write at a time, in enqueue order, dropping none', async () => {
    const { result, archiveCtl } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })
    act(() => { result.current.archive({ id: 'b' }, true) })
    act(() => { result.current.archive({ id: 'c' }, true) })
    // Item 1 started; 2 and 3 wait their turn — a second write starting while
    // the first is in flight is exactly the overlap the queue exists to stop.
    expect(archiveCtl.fn).toHaveBeenCalledTimes(1)
    expect(archiveCtl.calls[0].row.id).toBe('a')

    await act(async () => { archiveCtl.calls[0].resolve() })
    expect(archiveCtl.fn).toHaveBeenCalledTimes(2)
    expect(archiveCtl.calls[1].row.id).toBe('b')

    await act(async () => { archiveCtl.calls[1].resolve() })
    expect(archiveCtl.fn).toHaveBeenCalledTimes(3)
    expect(archiveCtl.calls[2].row.id).toBe('c')

    await act(async () => { archiveCtl.calls[2].resolve() })
    // Click 5 fires exactly as reliably as click 1 — nothing vanished.
    expect(archiveCtl.fn).toHaveBeenCalledTimes(3)
  })

  it('the three verbs share ONE queue — read-state writes wait behind an archive', async () => {
    const { result, archiveCtl, log, props } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })
    act(() => { result.current.markUnreadAction({ id: 'b' }) })
    act(() => { result.current.markReadAction({ id: 'c' }) })
    expect(props.performMarkUnread).not.toHaveBeenCalled()
    expect(props.performMarkRead).not.toHaveBeenCalled()

    await act(async () => { archiveCtl.calls[0].resolve() })
    expect(log).toEqual(['archive:a:true', 'markUnread:b', 'markRead:c'])
  })

  it('flags the queue as busy while an item runs and clears both flags at rest', async () => {
    const { result, archiveCtl, setActionSaving, setBusyId } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })
    expect(setActionSaving).toHaveBeenLastCalledWith(true)
    expect(setBusyId).toHaveBeenLastCalledWith('a')

    await act(async () => { archiveCtl.calls[0].resolve() })
    expect(setActionSaving).toHaveBeenLastCalledWith(false)
    expect(setBusyId).toHaveBeenLastCalledWith(null)
  })

  it('ignores a row without an id — no enqueue, no worker start', () => {
    const { result, archiveCtl } = setup()
    act(() => { result.current.archive(null, true) })
    act(() => { result.current.archive({}, true) })
    act(() => { result.current.markUnreadAction(undefined) })
    expect(archiveCtl.fn).not.toHaveBeenCalled()
  })
})

describe('useActionQueue — CONTRACTS M3 pending-target toggle', () => {
  it('a second archive on a queued row toggles relative to the PENDING target, not the caller’s stale boolean', async () => {
    const { result, archiveCtl } = setup()
    // Both presses read the same stale "not archived yet" and pass true —
    // the second plainly MEANS undo, and the map is what makes it one.
    act(() => { result.current.archive({ id: 'a' }, true) })
    act(() => { result.current.archive({ id: 'a' }, true) })
    await act(async () => { archiveCtl.calls[0].resolve() })
    expect(archiveCtl.calls[1].archived).toBe(false)
    await act(async () => { archiveCtl.calls[1].resolve() })
  })

  it('the pending entry survives an item finishing while more archive items remain queued for that row', async () => {
    const { result, archiveCtl } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })  // item 1: true (in flight)
    act(() => { result.current.archive({ id: 'a' }, true) })  // toggles → item 2: false
    // Item 1 completes with item 2 still queued — the map must KEEP the row's
    // pending target (false), or the next press reads stale list state again.
    await act(async () => { archiveCtl.calls[0].resolve() })
    act(() => { result.current.archive({ id: 'a' }, false) }) // stale caller boolean
    await act(async () => { archiveCtl.calls[1].resolve() })
    await act(async () => { archiveCtl.calls[2].resolve() })
    // Third press toggled against the surviving pending false → true.
    expect(archiveCtl.calls.map(c => c.archived)).toEqual([true, false, true])
  })

  it('once the row’s archives have all drained, the caller’s boolean is trusted again', async () => {
    const { result, archiveCtl } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })
    await act(async () => { archiveCtl.calls[0].resolve() })
    // Settled — list state is correct again, and a stale-toggle here would
    // invert a click the operator meant literally.
    act(() => { result.current.archive({ id: 'a' }, true) })
    expect(archiveCtl.calls[1].archived).toBe(true)
    await act(async () => { archiveCtl.calls[1].resolve() })
  })
})

describe('useActionQueue — unmount safety', () => {
  it('an in-flight item finishing after unmount starts nothing further and touches no state', async () => {
    const { result, unmount, archiveCtl, mountedRef, setActionSaving, setBusyId } = setup()
    act(() => { result.current.archive({ id: 'a' }, true) })
    act(() => { result.current.archive({ id: 'b' }, true) })
    expect(archiveCtl.fn).toHaveBeenCalledTimes(1)

    setActionSaving.mockClear()
    setBusyId.mockClear()
    // The real surface flips mountedRef in its own unmount cleanup; the
    // harness mirrors that ordering — flag first, teardown, then the write
    // that was still in flight lands.
    mountedRef.current = false
    unmount()
    await act(async () => { archiveCtl.calls[0].resolve() })

    // Item 2 is never started against a dead component…
    expect(archiveCtl.fn).toHaveBeenCalledTimes(1)
    // …and the post-item setState block is mountedRef-gated, so neither
    // saving flag is written after unmount.
    expect(setActionSaving).not.toHaveBeenCalled()
    expect(setBusyId).not.toHaveBeenCalled()
  })
})
