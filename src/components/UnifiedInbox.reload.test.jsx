// @vitest-environment jsdom
// INBOXPERM.1 — the unified inbox coalesces realtime-triggered list reloads:
// a 400 ms trailing debounce capped at 2 s, never two list requests in flight,
// the poll / manual refresh immediate, timers cleared on unmount.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

// Every realtime handler the component registers, so a test can fire "events".
const handlers = []
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    channel: () => { const ch = { on: (_t, _f, cb) => { handlers.push(cb); return ch }, subscribe: () => ch }; return ch },
    removeChannel: () => {},
  }),
}))
vi.mock('@/components/CommandCentre', () => ({ default: () => <div /> }))
vi.mock('@/components/WAInbox', () => ({ default: () => <div /> }))
vi.mock('@/components/IGInbox', () => ({ default: () => <div /> }))

import UnifiedInbox from './UnifiedInbox.jsx'

let waRequests
let gate // when set, the next WhatsApp list request waits on it

beforeEach(() => {
  vi.useFakeTimers()
  handlers.length = 0
  waRequests = 0
  gate = null
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const isWa = String(url).includes('/api/whatsapp/conversations')
    if (isWa) {
      waRequests += 1
      if (gate) await gate.promise
    }
    return { ok: true, status: 200, json: async () => ({ success: true, conversations: [] }) }
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const fire = () => act(async () => { for (const h of handlers) h({}) })
const fireOne = () => act(async () => { handlers[0]({}) })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

async function mount() {
  await act(async () => { render(<UnifiedInbox locationId="l1" userId="u1" />) })
  await advance(0)
  expect(waRequests).toBe(1) // the initial load
  expect(handlers.length).toBe(5) // five tables subscribed
}

describe('UnifiedInbox realtime reloads', () => {
  it('five events within 50 ms produce ONE reload', async () => {
    await mount()
    for (let i = 0; i < 5; i++) { await fireOne(); await advance(10) }
    expect(waRequests).toBe(1) // nothing yet: still inside the quiet window
    await advance(400)
    expect(waRequests).toBe(2)
    await advance(5000)
    expect(waRequests).toBe(2)
  })

  it('one event from each of the five tables is still one reload', async () => {
    await mount()
    await fire()
    await advance(400)
    expect(waRequests).toBe(2)
  })

  it('a steady stream (an event every 300 ms for 3 s) still reloads by the 2-second mark', async () => {
    await mount()
    for (let t = 0; t < 3000; t += 300) {
      await fireOne()
      await advance(300)
      // Never earlier than the wait allows, never later than 2 s after the first event.
      if (t + 300 < 2000) expect(waRequests).toBe(1)
      if (t + 300 >= 2000) expect(waRequests).toBeGreaterThanOrEqual(2)
    }
    expect(waRequests).toBeGreaterThanOrEqual(2)
    await advance(1000)
    // 3 s of events is at most two cap-bounded reloads plus the trailing one.
    expect(waRequests).toBeLessThanOrEqual(4)
  })

  it('a reload requested while one is in flight runs exactly one more when it finishes', async () => {
    await mount()
    gate = deferred()
    await fireOne()
    await advance(400) // the debounced reload starts and waits on the gate
    expect(waRequests).toBe(2)
    // Three more bursts while it is in flight: none starts a second request.
    for (let i = 0; i < 3; i++) { await fireOne(); await advance(500) }
    expect(waRequests).toBe(2)
    gate.resolve()
    gate = null
    await advance(0)
    expect(waRequests).toBe(3) // exactly one follow-up
    await advance(5000)
    expect(waRequests).toBe(3)
  })

  it('the manual refresh is immediate and shares the in-flight guard', async () => {
    await mount()
    gate = deferred()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await advance(0)
    expect(waRequests).toBe(2) // no debounce wait
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await advance(0)
    expect(waRequests).toBe(2) // in flight: not a third request yet
    gate.resolve()
    gate = null
    await advance(0)
    expect(waRequests).toBe(3) // one follow-up for all the clicks
  })

  it('the 60-second poll reloads immediately', async () => {
    await mount()
    await advance(60000)
    expect(waRequests).toBe(2)
  })

  it('unmount cancels a pending reload', async () => {
    await mount()
    await fireOne()
    cleanup()
    await advance(5000)
    expect(waRequests).toBe(1)
  })
})
