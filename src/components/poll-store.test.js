// MAIL-PERF.1 — the URL subscription store: refcount, one request per cadence
// for N subscribers, visibility forwarding, and eviction on auth change.
// Every input is injected; nothing here touches fetch, document or supabase.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPollStore, fetchCount } from './poll-store'

let visible
let fetches
let answers
let store

function make(opts = {}) {
  fetches = []
  answers = {}
  return createPollStore({
    fetcher: async (url) => {
      fetches.push(url)
      return answers[url]
    },
    intervalMs: 1000,
    isVisible: () => visible,
    ...opts,
  })
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  visible = true
  store = make()
})

afterEach(() => {
  store._resetForTests()
  vi.useRealTimers()
})

describe('createPollStore — refcount', () => {
  it('two subscribers of one URL: one request on subscribe, one per cadence, both told', async () => {
    answers['/a'] = 3
    const seenA = []
    const seenB = []
    store.subscribe('/a', (v) => seenA.push(v))
    store.subscribe('/a', (v) => seenB.push(v))
    await flush()
    expect(fetches).toEqual(['/a'])
    expect(seenA).toEqual([3])
    expect(seenB).toEqual([3])

    answers['/a'] = 4
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetches).toEqual(['/a', '/a'])
    expect(seenA).toEqual([3, 4])
    expect(seenB).toEqual([3, 4])
    expect(store.size()).toBe(1)
    expect(store.subscriberCount('/a')).toBe(2)
  })

  it('a late joiner is handed the last good value and causes no request', async () => {
    answers['/a'] = 7
    store.subscribe('/a', () => {})
    await flush()
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    expect(seen).toEqual([7])
    expect(fetches).toHaveLength(1)
  })

  it('distinct URLs are distinct clocks', async () => {
    answers['/a'] = 1
    answers['/b'] = 2
    store.subscribe('/a', () => {})
    store.subscribe('/b', () => {})
    await flush()
    expect(fetches.sort()).toEqual(['/a', '/b'])
    expect(store.size()).toBe(2)
  })

  it('the last unsubscribe drops the entry and its clock; unsubscribe is idempotent', async () => {
    const offA = store.subscribe('/a', () => {})
    const offB = store.subscribe('/a', () => {})
    await flush()
    offA()
    offA() // twice — must not disturb B's subscription
    expect(store.subscriberCount('/a')).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetches).toHaveLength(2)
    offB()
    expect(store.size()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetches).toHaveLength(2)
  })

  it('a re-subscribe after teardown starts a fresh entry (fresh request)', async () => {
    answers['/a'] = 1
    const off = store.subscribe('/a', () => {})
    await flush()
    off()
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    expect(fetches).toHaveLength(2)
    expect(seen).toEqual([1])
  })

  it('an undefined answer (blip) keeps the last good value and tells nobody', async () => {
    answers['/a'] = 5
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    answers['/a'] = undefined
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([5])
    // …and a late joiner still gets the 5, never a 0.
    const late = []
    store.subscribe('/a', (v) => late.push(v))
    expect(late).toEqual([5])
  })

  it('a rejecting fetcher is a blip too', async () => {
    store = make({ fetcher: async () => { throw new Error('boom') } })
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toEqual([])
  })
})

describe('createPollStore — visibility', () => {
  it('hidden: no clock; visible again: one immediate request then cadence', async () => {
    answers['/a'] = 1
    store.subscribe('/a', () => {})
    await flush()
    expect(fetches).toHaveLength(1)
    visible = false
    store.onVisibilityChange()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetches).toHaveLength(1)
    visible = true
    store.onVisibilityChange()
    await flush()
    expect(fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetches).toHaveLength(3)
  })

  it('a subscribe while hidden defers the first request to the resume', async () => {
    visible = false
    store.subscribe('/a', () => {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetches).toHaveLength(0)
    visible = true
    store.onVisibilityChange()
    await flush()
    expect(fetches).toHaveLength(1)
  })

  it('focus forwards to every clock', async () => {
    store.subscribe('/a', () => {})
    store.subscribe('/b', () => {})
    await flush()
    store.onFocus()
    await flush()
    expect(fetches).toHaveLength(4)
  })
})

describe('createPollStore — eviction on auth change', () => {
  it('the first auth report only records — no eviction, no restart', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    store.setAuth('user-a')
    await flush()
    expect(seen).toEqual([2])
    expect(fetches).toHaveLength(1)
    expect(store.isHalted()).toBe(false)
  })

  it('sign-out halts every clock, drops cached values, tells subscribers 0, keeps subscribers', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    store.setAuth('user-a')
    store.setAuth(null)
    expect(seen).toEqual([2, 0])
    expect(store.isHalted()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetches).toHaveLength(1) // nothing polls for a signed-out screen
    // A joiner while signed out is told nothing (no cached number) and
    // starts no clock.
    const late = []
    store.subscribe('/a', (v) => late.push(v))
    store.subscribe('/b', (v) => late.push(v))
    await vi.advanceTimersByTimeAsync(2000)
    expect(late).toEqual([])
    expect(fetches).toHaveLength(1)
    expect(store.subscriberCount('/a')).toBe(2)
  })

  it('an in-flight answer for the signed-out user is dropped', async () => {
    let resolveFetch
    store = make({
      fetcher: () => new Promise((r) => { resolveFetch = r }),
    })
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    store.setAuth('user-a')
    await flush()
    store.setAuth(null) // sign out while the request is still open
    resolveFetch(99)
    await flush()
    expect(seen).toEqual([0]) // the 99 belonged to user-a's screen
  })

  it('a sign-in after a halt restarts every entry that still has a subscriber, with a fresh request', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    const offB = store.subscribe('/b', () => {})
    await flush()
    store.setAuth('user-a')
    store.setAuth(null)
    offB() // /b's reader unmounted during the signed-out interval
    answers['/a'] = 6
    store.setAuth('user-b')
    await flush()
    expect(seen).toEqual([2, 0, 6])
    expect(store.isHalted()).toBe(false)
    expect(store.size()).toBe(1) // /b was dropped, not restarted
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetches.filter((u) => u === '/a')).toHaveLength(3)
  })

  it('user A → user B in one step: A\'s number is never shown to B', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    store.setAuth('user-a')
    answers['/a'] = 8
    store.setAuth('user-b')
    await flush()
    expect(seen).toEqual([2, 0, 8])
  })

  it('same user again (TOKEN_REFRESHED / INITIAL_SESSION on focus) is a no-op', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    store.setAuth('user-a')
    store.setAuth('user-a')
    store.setAuth('user-a')
    await flush()
    expect(seen).toEqual([2])
    expect(fetches).toHaveLength(1)
  })

  it('the same user signing back in after a sign-out restarts', async () => {
    answers['/a'] = 2
    const seen = []
    store.subscribe('/a', (v) => seen.push(v))
    await flush()
    store.setAuth('user-a')
    store.setAuth(null)
    store.setAuth('user-a')
    await flush()
    expect(seen).toEqual([2, 0, 2])
    expect(store.isHalted()).toBe(false)
  })
})

describe('fetchCount — the badge envelope', () => {
  afterEach(() => { delete global.fetch })

  it('reads data.count from a success envelope', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { count: 12 } }) }))
    expect(await fetchCount('/x')).toBe(12)
    expect(global.fetch).toHaveBeenCalledWith('/x', { cache: 'no-store' })
  })

  it('a non-ok status or a failed envelope is undefined (keep last good), a missing count is 0', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ success: true, data: { count: 1 } }) }))
    expect(await fetchCount('/x')).toBeUndefined()
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) }))
    expect(await fetchCount('/x')).toBeUndefined()
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }))
    expect(await fetchCount('/x')).toBe(0)
  })
})
