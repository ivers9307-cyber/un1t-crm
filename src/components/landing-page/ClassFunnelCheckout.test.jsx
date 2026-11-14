// @vitest-environment jsdom
//
// TRIALLEAK.1 — the embedded checkout's status poll: with `onFailed` it also
// notices an order that failed or ran out of time (it used to watch `paid`
// alone and poll a dead order for ever); without it nothing changes for the
// class funnel and the donate card. A widget error with a way back shows
// "Try again" instead of nothing to press.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const sdk = vi.hoisted(() => ({ options: null }))
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn() }))
vi.mock('@/lib/revolut-embed', () => ({
  loadRevolutSdk: async () => ({ embeddedCheckout: (options) => { sdk.options = options; return { destroy: () => {} } } }),
  revolutMode: () => 'sandbox',
  revolutPublicKey: () => 'pk_test',
}))

import ClassFunnelCheckout from './ClassFunnelCheckout'

let answer
let fetchMock
beforeEach(() => {
  sdk.options = null
  answer = { paid: false, state: 'pending' }
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: answer }) }))
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

// The fake clock moves inside act() (CLAUDE.md): React renders on the act queue.
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const CHECKOUT = { provider: 'revolut', token: 'tok' }

describe('TRIALLEAK.1 — ClassFunnelCheckout status poll', () => {
  it('mounts the widget on the given order token', async () => {
    render(<ClassFunnelCheckout paymentId="p1" checkout={CHECKOUT} statusPath="/api/public/trial-purchases" />)
    await advance(0)
    expect(await sdk.options.createOrder()).toEqual({ publicId: 'tok' })
  })

  it('with onFailed, a failed or timed-out order is handed back once and the poll stops', async () => {
    for (const state of ['failed', 'expired']) {
      const onFailed = vi.fn()
      const onPaid = vi.fn()
      fetchMock.mockClear()
      answer = { paid: false, state: 'pending' }
      render(<ClassFunnelCheckout paymentId="p1" checkout={CHECKOUT} statusPath="/api/public/trial-purchases" onPaid={onPaid} onFailed={onFailed} />)
      await advance(3000)
      expect(onFailed).not.toHaveBeenCalled()
      answer = { paid: false, state, payment_status: 'expired' }
      await advance(3000)
      expect(onFailed).toHaveBeenCalledTimes(1)
      expect(onFailed).toHaveBeenCalledWith(answer)
      expect(onPaid).not.toHaveBeenCalled()
      const polled = fetchMock.mock.calls.length
      await advance(12000)
      expect(fetchMock.mock.calls).toHaveLength(polled)
      expect(fetchMock.mock.calls[0][0]).toBe('/api/public/trial-purchases/p1')
      cleanup()
    }
  })

  it('without onFailed a failed state is ignored and the poll carries on (the class funnel and donate card, unchanged)', async () => {
    answer = { paid: false, state: 'failed' }
    render(<ClassFunnelCheckout paymentId="p1" checkout={CHECKOUT} />)
    await advance(9000)
    expect(fetchMock.mock.calls.length).toBe(3)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/public/class-booking-payments/p1')
  })

  it('paid still wins, once', async () => {
    const onPaid = vi.fn()
    const onFailed = vi.fn()
    answer = { paid: true, state: 'paid' }
    render(<ClassFunnelCheckout paymentId="p1" checkout={CHECKOUT} onPaid={onPaid} onFailed={onFailed} />)
    await advance(9000)
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('a widget error with a way back shows "Try again"; before any error it is "← Back"', async () => {
    const onCancel = vi.fn()
    render(<ClassFunnelCheckout paymentId="p1" checkout={CHECKOUT} onCancel={onCancel} />)
    await advance(0)
    expect(screen.getByRole('button', { name: '← Back' })).toBeTruthy()
    act(() => { sdk.options.onError({ error: { message: 'Card declined' } }) })
    expect(screen.getByText('Card declined')).toBeTruthy()
    const again = screen.getByRole('button', { name: 'Try again' })
    expect(again.getAttribute('type')).toBe('button')
    fireEvent.click(again)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
