// RACECONFIRM.1 — when the status-page refresh is the call that completes a
// race payment, it runs the completion effects (entry confirmations, or the
// gap receipt, plus the Glofox push): the webhook that lands later sees no
// fresh transition and sends nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./revolut', () => ({ createOrder: vi.fn(), getOrder: vi.fn() }))
const getPayment = vi.fn()
vi.mock('./payments', () => ({ paymentsFor: () => ({ getPayment }) }))
const runRacePaymentCompletedEffects = vi.fn()
vi.mock('./race-payment-completed', () => ({
  runRacePaymentCompletedEffects: (...a) => runRacePaymentCompletedEffects(...a),
}))
vi.mock('./orders', () => ({ syncOrderFromRacePayment: vi.fn(async () => {}) }))
vi.mock('./contact-events', () => ({ emitEvent: vi.fn(async () => {}), applyTagRules: vi.fn(async () => {}), EVENT_TYPES: {} }))
vi.mock('./sequences', () => ({ triggerSequencesForOrderStatus: vi.fn(async () => {}) }))
vi.mock('./host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn(async () => {}) }))

import { refreshRacePaymentFromProvider } from './race-payments'

const PAYMENT = {
  id: 'pay-1', kind: 'entry', status: 'pending', payment_provider: 'revolut', payment_provider_ref: 'ord-1',
  race_event_id: 'e1', race_registration_id: 'r1', contact_id: null, amount_cents: 3000, currency: 'EUR',
  race: { location_id: 'L1' },
}

// The payment row read, the compare-and-set status write (returns a row when
// `writeLands`), the registration flip, and the final re-read.
function makeDb({ writeLands = true } = {}) {
  return {
    from(table) {
      const q = { _op: 'select' }
      q.select = () => q
      q.update = () => { q._op = 'update'; return q }
      q.eq = () => q
      q.in = () => q
      q.is = () => q
      q.neq = () => q
      q.maybeSingle = async () => ({ data: PAYMENT, error: null })
      q.single = async () => ({ data: { ...PAYMENT, status: 'completed' }, error: null })
      q.then = (res) => res(q._op === 'update' && table === 'race_payments'
        ? { data: writeLands ? [{ id: PAYMENT.id }] : [], error: null }
        : { data: null, error: null })
      return q
    },
  }
}

beforeEach(() => {
  getPayment.mockReset()
  runRacePaymentCompletedEffects.mockReset()
})

describe('refreshRacePaymentFromProvider — completion effects', () => {
  it('runs the entry confirmations and the Glofox push when THIS refresh completed the payment', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 3000 })
    const glofoxPush = vi.fn(async () => {})
    runRacePaymentCompletedEffects.mockResolvedValue({ confirmations: { sent: ['email'] }, glofoxPush })
    await refreshRacePaymentFromProvider(makeDb(), { id: 'pay-1', payment_provider: 'revolut', payment_provider_ref: 'ord-1' })
    expect(runRacePaymentCompletedEffects).toHaveBeenCalledTimes(1)
    expect(runRacePaymentCompletedEffects.mock.calls[0][0].payment.id).toBe('pay-1')
    expect(runRacePaymentCompletedEffects.mock.calls[0][0].applied.status).toBe('completed')
    // Outside a request scope after() throws, so the push runs inline.
    expect(glofoxPush).toHaveBeenCalledTimes(1)
  })

  it('runs nothing when another path completed it first (the write landed on no row)', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 3000 })
    await refreshRacePaymentFromProvider(makeDb({ writeLands: false }), { id: 'pay-1', payment_provider: 'revolut', payment_provider_ref: 'ord-1' })
    expect(runRacePaymentCompletedEffects).not.toHaveBeenCalled()
  })

  it('runs nothing while the provider still says pending', async () => {
    getPayment.mockResolvedValue({ state: 'pending', amountCents: 3000 })
    await refreshRacePaymentFromProvider(makeDb(), { id: 'pay-1', payment_provider: 'revolut', payment_provider_ref: 'ord-1' })
    expect(runRacePaymentCompletedEffects).not.toHaveBeenCalled()
  })

  it('a failure in the effects never fails the refresh', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 3000 })
    runRacePaymentCompletedEffects.mockRejectedValue(new Error('mail down'))
    const out = await refreshRacePaymentFromProvider(makeDb(), { id: 'pay-1', payment_provider: 'revolut', payment_provider_ref: 'ord-1' })
    expect(out.status).toBe('completed')
  })
})
