// COVERLOOP.2 — the picker -> confirm-sheet sequencing decision. Pure, because
// there is no React Native component test runner and this is the part that
// wedged: iOS refuses to present a Modal while another is still animating out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextSwapFlowStep, createInFlightGuard, createSwapFlow, PICKER_DISMISS_FALLBACK_MS } from './swap-flow'

const shift = { id: 'a1', shift_date: '2026-09-24' }
const coach = { id: 'c1', full_name: 'Coach T' }
const request = { shift, coach }

describe('nextSwapFlowStep', () => {
  it.each([
    {
      name: 'iOS: picking a coach WAITS for the picker to finish dismissing',
      input: { event: 'pick', platform: 'ios', pickerVisible: true, pending: null, picked: request },
      expected: { action: 'wait_for_dismiss', pending: request, request: null },
    },
    {
      name: 'iOS: the picker finished dismissing with a pick waiting -> open the confirm sheet, consume the pick',
      input: { event: 'dismissed', platform: 'ios', pickerVisible: false, pending: request },
      expected: { action: 'open_confirm', pending: null, request },
    },
    {
      name: 'Android (no onDismiss): picking opens the confirm sheet at once',
      input: { event: 'pick', platform: 'android', pickerVisible: true, pending: null, picked: request },
      expected: { action: 'open_confirm', pending: null, request },
    },
    {
      name: 'any non-iOS platform opens at once',
      input: { event: 'pick', platform: 'web', pickerVisible: true, pending: null, picked: request },
      expected: { action: 'open_confirm', pending: null, request },
    },
    {
      name: 'cancelling the picker clears everything',
      input: { event: 'cancel', platform: 'ios', pickerVisible: true, pending: request },
      expected: { action: 'reset', pending: null, request: null },
    },
    {
      name: 'iOS: the dismiss that follows a CANCEL is a no-op (nothing was picked)',
      input: { event: 'dismissed', platform: 'ios', pickerVisible: false, pending: null },
      expected: { action: 'noop', pending: null, request: null },
    },
    {
      name: 'a fresh start discards a stale pick left behind by a dismiss that never came',
      input: { event: 'start', platform: 'ios', pickerVisible: false, pending: request },
      expected: { action: 'reset', pending: null, request: null },
    },
    {
      name: 'a fresh start also resets when the picker is somehow still up',
      input: { event: 'start', platform: 'ios', pickerVisible: true, pending: null },
      expected: { action: 'reset', pending: null, request: null },
    },
    {
      name: 'a dismiss while the picker is visible again never opens a sheet over it; the stale pick is dropped',
      input: { event: 'dismissed', platform: 'ios', pickerVisible: true, pending: request },
      expected: { action: 'noop', pending: null, request: null },
    },
    {
      name: 'an open post (no picker involved) opens the confirm sheet on every platform and drops any stale pick',
      input: { event: 'post', platform: 'ios', pickerVisible: false, pending: request, picked: { shift, coach: null } },
      expected: { action: 'open_confirm', pending: null, request: { shift, coach: null } },
    },
    {
      name: 'a pick with no shift behind it is a reset, not a request',
      input: { event: 'pick', platform: 'ios', pickerVisible: true, pending: null, picked: { shift: null, coach } },
      expected: { action: 'reset', pending: null, request: null },
    },
    {
      name: 'an unknown event changes nothing it should not: no sheet, pick dropped',
      input: { event: 'nonsense', platform: 'ios', pickerVisible: false, pending: request },
      expected: { action: 'noop', pending: null, request: null },
    },
  ])('$name', ({ input, expected }) => {
    expect(nextSwapFlowStep(input)).toEqual(expected)
  })

  it('survives no argument at all', () => {
    expect(nextSwapFlowStep()).toEqual({ action: 'noop', pending: null, request: null })
  })

  it('only ever opens the sheet with a request that has a shift', () => {
    const out = nextSwapFlowStep({ event: 'dismissed', platform: 'ios', pickerVisible: false, pending: { shift: null, coach } })
    expect(out).toEqual({ action: 'noop', pending: null, request: null })
  })
})

// A second tap lands before React re-renders, so `if (sending) return` read
// from the render closure lets it through and the swap is POSTed twice.
describe('createInFlightGuard', () => {
  it('lets exactly one caller in until end()', () => {
    const g = createInFlightGuard()
    expect(g.busy).toBe(false)
    expect(g.begin()).toBe(true)
    expect(g.busy).toBe(true)
    expect(g.begin()).toBe(false) // the double tap, same tick
    expect(g.begin()).toBe(false)
    g.end()
    expect(g.busy).toBe(false)
    expect(g.begin()).toBe(true) // a retry after a failure is allowed
  })

  it('end() without begin() is harmless, and guards are independent', () => {
    const a = createInFlightGuard()
    const b = createInFlightGuard()
    a.end()
    expect(a.begin()).toBe(true)
    expect(b.begin()).toBe(true)
  })

  it('two synchronous submits make one request', async () => {
    const g = createInFlightGuard()
    let posts = 0
    async function submit() {
      if (!g.begin()) return
      try { posts += 1; await Promise.resolve() } finally { g.end() }
    }
    await Promise.all([submit(), submit()])
    expect(posts).toBe(1)
  })
})

// run() is begin + try/finally in one place, so a caller cannot take the latch
// and then fail to release it (the Schedule tab took it, then threw while
// BUILDING the request, before the promise its .finally hung off existed: every
// later post was blocked until the screen remounted).
describe('createInFlightGuard().run', () => {
  it('resolves with the work\'s value and releases', async () => {
    const g = createInFlightGuard()
    await expect(g.run(async () => 'posted')).resolves.toBe('posted')
    expect(g.busy).toBe(false)
  })

  it('work that THROWS SYNCHRONOUSLY (before any promise exists) still releases', async () => {
    const g = createInFlightGuard()
    const activeLocation = null
    await expect(g.run(() => ({ locationId: activeLocation.id }))).rejects.toThrow(TypeError)
    expect(g.busy).toBe(false)
    await expect(g.run(async () => 'second try')).resolves.toBe('second try')
  })

  it('work that rejects still releases', async () => {
    const g = createInFlightGuard()
    await expect(g.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(g.busy).toBe(false)
  })

  it('a re-entrant call while held does not run its work, resolves undefined, and does not release the holder', async () => {
    const g = createInFlightGuard()
    let release
    const first = g.run(() => new Promise((resolve) => { release = () => resolve('first') }))
    const second = vi.fn(async () => 'second')
    await expect(g.run(second)).resolves.toBeUndefined()
    expect(second).not.toHaveBeenCalled()
    expect(g.busy).toBe(true) // the skipped call must not have end()ed the first
    release()
    await expect(first).resolves.toBe('first')
    expect(g.busy).toBe(false)
  })

  it('shares the latch with begin()/end()', async () => {
    const g = createInFlightGuard()
    expect(g.begin()).toBe(true)
    const work = vi.fn()
    await g.run(work)
    expect(work).not.toHaveBeenCalled()
    g.end()
    await g.run(work)
    expect(work).toHaveBeenCalledTimes(1)
  })
})

// Belt and braces: iOS opens the confirm sheet from the picker Modal's
// onDismiss, but if a React Native build never fires it the feature is dead on
// iOS. A fallback timer opens it instead. Whichever comes first consumes the
// parked pick; the other finds nothing parked.
describe('nextSwapFlowStep — fallback_elapsed', () => {
  it.each([
    {
      name: 'the timer beat onDismiss: open the sheet, consume the pick',
      input: { event: 'fallback_elapsed', platform: 'ios', pickerVisible: false, pending: request },
      expected: { action: 'open_confirm', pending: null, request },
    },
    {
      name: 'onDismiss already consumed it (or the coach cancelled, or restarted): nothing',
      input: { event: 'fallback_elapsed', platform: 'ios', pickerVisible: false, pending: null },
      expected: { action: 'noop', pending: null, request: null },
    },
    {
      name: 'never over a picker that is on screen again',
      input: { event: 'fallback_elapsed', platform: 'ios', pickerVisible: true, pending: request },
      expected: { action: 'noop', pending: null, request: null },
    },
  ])('$name', ({ input, expected }) => {
    expect(nextSwapFlowStep(input)).toEqual(expected)
  })
})

describe('createSwapFlow — onDismiss and the fallback timer, exactly once', () => {
  let opened
  let resets
  const flowFor = (platform) => createSwapFlow({
    platform,
    onOpenConfirm: (r) => opened.push(r),
    onReset: () => { resets += 1 },
  })
  const shiftB = { id: 'b2', shift_date: '2026-09-25' }

  beforeEach(() => { vi.useFakeTimers(); opened = []; resets = 0 })
  afterEach(() => { vi.useRealTimers() })

  it('the constant is long enough for the dismiss animation and short enough to feel like one step', () => {
    expect(PICKER_DISMISS_FALLBACK_MS).toBe(700)
  })

  it('iOS, onDismiss never fires: the timer opens the sheet, once, and a late dismiss adds nothing', () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    expect(opened).toEqual([])
    expect(flow.pending).toEqual(request)
    vi.advanceTimersByTime(PICKER_DISMISS_FALLBACK_MS - 1)
    expect(opened).toEqual([])
    vi.advanceTimersByTime(1)
    expect(opened).toEqual([request])
    flow.dispatch('dismissed')
    vi.advanceTimersByTime(5000)
    expect(opened).toEqual([request])
    expect(flow.pending).toBeNull()
  })

  it('iOS, onDismiss fires first: it opens the sheet, once, and the timer is disarmed', () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    vi.advanceTimersByTime(350)
    flow.dispatch('dismissed')
    expect(opened).toEqual([request])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(opened).toEqual([request])
  })

  it('the timer after a cancel does nothing', () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    flow.dispatch('cancel')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(opened).toEqual([])
    expect(resets).toBe(1)
  })

  it("a fresh start with a different shift: the OLD pick's deadline opens nothing, the new pick opens once on its own clock", () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true }) // t=0, deadline 700
    vi.advanceTimersByTime(500)
    flow.dispatch('start')
    const second = { shift: shiftB, coach }
    flow.dispatch('pick', { picked: second, pickerVisible: true }) // t=500, deadline 1200
    vi.advanceTimersByTime(200) // t=700: the old deadline
    expect(opened).toEqual([])
    vi.advanceTimersByTime(500) // t=1200
    expect(opened).toEqual([second])
  })

  it('the confirm sheet closing (cancel) and an open post both disarm a timer', () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    flow.dispatch('post', { picked: { shift: shiftB, coach: null } })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(opened).toEqual([{ shift: shiftB, coach: null }])
  })

  it('unmount (dispose) disarms the timer and drops the pick; the flow still works if remounted', () => {
    const flow = flowFor('ios')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    flow.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(opened).toEqual([])
    expect(flow.pending).toBeNull()
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    flow.dispatch('dismissed')
    expect(opened).toEqual([request])
  })

  it('Android never arms the timer: the sheet opens at once', () => {
    const flow = flowFor('android')
    flow.dispatch('pick', { picked: request, pickerVisible: true })
    expect(opened).toEqual([request])
    expect(vi.getTimerCount()).toBe(0)
  })
})
