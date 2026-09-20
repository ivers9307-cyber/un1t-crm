// COVERLOOP.2 — the picker -> confirm-sheet sequencing decision. Pure, because
// there is no React Native component test runner and this is the part that
// wedged: iOS refuses to present a Modal while another is still animating out.
import { describe, it, expect } from 'vitest'
import { nextSwapFlowStep, createInFlightGuard } from './swap-flow'

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
