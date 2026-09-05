// @vitest-environment jsdom
//
// MAIL-PERF.1 — the badge poller at the hook seam. Before this ticket every
// usePolledCount() call owned its own setInterval, so the sidebar's Messages
// badge and the Communications tab strip — same URL, same cadence — each
// fetched `/api/email/mail/count?scope=all` (and the WhatsApp count) on their
// own clock: two requests per minute per URL for one number. The hook now
// subscribes through the shared poll store, so N mounted readers of one URL
// are ONE request per cadence, the tab being hidden stops the clock, and a
// sign-out empties the store rather than leaving module state polling for a
// user who has left the shared front-desk Mac.
//
// jsdom cannot see real visibility; the state machine is pinned in
// visible-interval.test.js and the refcount/eviction in poll-store.test.js.
// This file proves the wiring: two hooks, one URL, one fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({ auth: { onAuthStateChange: vi.fn() } }),
}))

import { usePolledCount } from './use-polled-count'
import { pollStore } from './poll-store'

const URL_MAIL = '/api/email/mail/count?scope=all'

function stubFetch(counts = {}) {
  const calls = []
  global.fetch = vi.fn(async (url) => {
    calls.push(url)
    const count = counts[url] ?? 0
    return { ok: true, json: async () => ({ success: true, data: { count } }) }
  })
  return calls
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  // The store is module-level by design — drain it between tests so one
  // test's subscribers cannot leak into the next.
  pollStore._resetForTests?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePolledCount — one poller per URL', () => {
  it('two hooks on the same URL cause ONE fetch on mount and ONE per cadence', async () => {
    const calls = stubFetch({ [URL_MAIL]: 3 })
    const a = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    const b = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls.filter(u => u === URL_MAIL)).toHaveLength(1)
    expect(a.result.current).toBe(3)
    expect(b.result.current).toBe(3)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(calls.filter(u => u === URL_MAIL)).toHaveLength(2)

    // Both readers still agree after the shared tick.
    expect(a.result.current).toBe(3)
    expect(b.result.current).toBe(3)
  })

  it('different URLs are different pollers', async () => {
    const calls = stubFetch({ [URL_MAIL]: 1, '/api/whatsapp/unread-count': 2 })
    const a = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    const b = renderHook(() => usePolledCount({ enabled: true, url: '/api/whatsapp/unread-count' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls).toHaveLength(2)
    expect(a.result.current).toBe(1)
    expect(b.result.current).toBe(2)
  })

  it('disabled → 0 and no fetch', async () => {
    const calls = stubFetch({ [URL_MAIL]: 5 })
    const h = renderHook(() => usePolledCount({ enabled: false, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(calls).toHaveLength(0)
    expect(h.result.current).toBe(0)
  })

  it('a late joiner reads the last good value without a new request', async () => {
    const calls = stubFetch({ [URL_MAIL]: 9 })
    renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(calls).toHaveLength(1)
    const late = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(late.result.current).toBe(9)
    expect(calls).toHaveLength(1)
  })

  it('the last unmount stops the clock', async () => {
    const calls = stubFetch({ [URL_MAIL]: 1 })
    const a = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    const b = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    a.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(calls).toHaveLength(2) // b still polls
    b.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(calls).toHaveLength(2) // nobody is looking; nothing polls
  })

  it('a non-ok response keeps the last good count (network blip posture)', async () => {
    let ok = true
    global.fetch = vi.fn(async () => (ok
      ? { ok: true, json: async () => ({ success: true, data: { count: 4 } }) }
      : { ok: false, json: async () => ({ success: false }) }))
    const h = renderHook(() => usePolledCount({ enabled: true, url: URL_MAIL }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(h.result.current).toBe(4)
    ok = false
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(h.result.current).toBe(4)
  })
})
