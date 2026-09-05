// MAIL-PERF.1 — the visibility state machine, with every input injected.
// jsdom cannot see layout or real visibility, so this pins the TRANSITIONS
// (hidden → no tick; visible → tick per cadence; hidden→visible → one
// immediate tick, then cadence from now; focus dedupe) against a fake clock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createVisibleInterval, RESUME_DEDUPE_MS, documentVisible } from './visible-interval'

let visible
let ticks
let ctl

function make(opts = {}) {
  ticks = 0
  return createVisibleInterval({
    tick: () => { ticks += 1 },
    intervalMs: 1000,
    isVisible: () => visible,
    now: () => Date.now(),
    ...opts,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  visible = true
})

afterEach(() => {
  ctl?.stop()
  vi.useRealTimers()
})

describe('createVisibleInterval — visible', () => {
  it('ticks once per cadence, no tick on start by default', () => {
    ctl = make()
    ctl.start()
    expect(ticks).toBe(0)
    vi.advanceTimersByTime(3000)
    expect(ticks).toBe(3)
  })

  it('immediate: ticks on start, then per cadence', () => {
    ctl = make({ immediate: true })
    ctl.start()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(ticks).toBe(3)
  })

  it('stop() tears the clock down; a later cadence never fires', () => {
    ctl = make()
    ctl.start()
    vi.advanceTimersByTime(1000)
    ctl.stop()
    vi.advanceTimersByTime(10_000)
    expect(ticks).toBe(1)
    expect(ctl.isArmed()).toBe(false)
  })
})

describe('createVisibleInterval — hidden', () => {
  it('hidden at start: no tick, no clock (even with immediate)', () => {
    visible = false
    ctl = make({ immediate: true })
    ctl.start()
    vi.advanceTimersByTime(10_000)
    expect(ticks).toBe(0)
    expect(ctl.isArmed()).toBe(false)
  })

  it('going hidden disarms the clock — nothing fires while hidden', () => {
    ctl = make()
    ctl.start()
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(1)
    visible = false
    ctl.onVisibilityChange()
    expect(ctl.isArmed()).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(ticks).toBe(1)
  })

  it('a missed visibilitychange still cannot fetch: the in-tick check drops the clock', () => {
    ctl = make()
    ctl.start()
    visible = false // no onVisibilityChange() call — the event was missed
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(0)
    expect(ctl.isArmed()).toBe(false)
  })
})

describe('createVisibleInterval — return', () => {
  it('hidden → visible: ONE immediate tick, then cadence restarts from now', () => {
    ctl = make()
    ctl.start()
    vi.advanceTimersByTime(600) // part-way into a cadence
    visible = false
    ctl.onVisibilityChange()
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(0)

    visible = true
    ctl.onVisibilityChange()
    expect(ticks).toBe(1) // immediate
    vi.advanceTimersByTime(999)
    expect(ticks).toBe(1) // the old 600ms-in clock did NOT carry over
    vi.advanceTimersByTime(1)
    expect(ticks).toBe(2)
  })

  it('a hidden start whose first tick was deferred ticks on the first resume', () => {
    visible = false
    ctl = make({ immediate: true })
    ctl.start()
    visible = true
    ctl.onVisibilityChange()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(2)
  })

  it('focus alone ticks (window-to-window return) without resetting the cadence', () => {
    ctl = make()
    ctl.start()
    vi.advanceTimersByTime(500)
    ctl.onFocus()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(500)
    expect(ticks).toBe(2) // the standing clock still fires on its own schedule
  })

  it('a focus inside RESUME_DEDUPE_MS of a visibility resume is the same return — one tick', () => {
    ctl = make()
    ctl.start()
    visible = false
    ctl.onVisibilityChange()
    visible = true
    ctl.onVisibilityChange()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(RESUME_DEDUPE_MS - 1)
    ctl.onFocus()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(1) // cadence tick lands here (1000ms after resume)
    expect(ticks).toBe(2)
    vi.advanceTimersByTime(1)
    ctl.onFocus() // past the dedupe window → a real focus refresh
    expect(ticks).toBe(3)
  })

  it('focus while hidden never ticks', () => {
    ctl = make()
    ctl.start()
    visible = false
    ctl.onVisibilityChange()
    ctl.onFocus()
    expect(ticks).toBe(0)
  })

  it('events after stop() are inert', () => {
    ctl = make()
    ctl.start()
    ctl.stop()
    ctl.onVisibilityChange()
    ctl.onFocus()
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(0)
  })

  it('start() is idempotent — a second start does not double the clock', () => {
    ctl = make({ immediate: true })
    ctl.start()
    ctl.start()
    expect(ticks).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(2)
  })
})

describe('documentVisible', () => {
  it('reads as visible with no document (SSR)', () => {
    expect(documentVisible()).toBe(true)
  })
})
