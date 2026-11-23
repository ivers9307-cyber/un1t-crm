// SALEALERT.1 — the sale push on a freshly completed race entry.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./race-confirmations', () => ({
  sendRaceConfirmations: vi.fn(async () => ({ sent: ['email'] })),
  sendGapPaidEmail: vi.fn(async () => ({ sent: ['email'] })),
}))
vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('./sale-alert-sources', () => ({ alertRaceSale: vi.fn(async () => ({ sent: true })) }))
vi.mock('./sale-alert', () => ({ ringSaleAfterResponse: vi.fn((fn) => fn()) }))

import { alertRaceSale } from './sale-alert-sources'
import { runRacePaymentCompletedEffects } from './race-payment-completed'

const ROW = {
  id: 'rp1', kind: 'entry', amount_cents: 6000, payment_provider: 'revolut', connected_account_id: null,
  contact_id: 'c9', contact_name: 'Ciara Walsh',
  race_events: { name: 'Summer Hyrox', location_id: 'loc-1' },
}

function makeDb(row, error = null) {
  const q = {}
  q.select = () => q
  q.eq = () => q
  q.maybeSingle = async () => ({ data: row, error })
  return { from: () => q }
}

beforeEach(() => vi.clearAllMocks())

describe('runRacePaymentCompletedEffects sale alert', () => {
  const applied = { status: 'completed' }

  it('rings with the fresh payment row and its event on an entry completion', async () => {
    const db = makeDb(ROW)
    await runRacePaymentCompletedEffects({ db, payment: { id: 'rp1' }, applied })
    expect(alertRaceSale).toHaveBeenCalledTimes(1)
    const [dbArg, payment, event] = alertRaceSale.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(payment).toMatchObject({ id: 'rp1', amount_cents: 6000 })
    expect(event).toEqual({ name: 'Summer Hyrox', location_id: 'loc-1' })
  })

  it('does not ring when nothing was completed here', async () => {
    await runRacePaymentCompletedEffects({ db: makeDb(ROW), payment: { id: 'rp1' }, applied: null })
    expect(alertRaceSale).not.toHaveBeenCalled()
  })

  it('does not ring for a price-difference payment', async () => {
    await runRacePaymentCompletedEffects({ db: makeDb(ROW), payment: { id: 'rp1', kind: 'move_gap' }, applied })
    expect(alertRaceSale).not.toHaveBeenCalled()
  })

  it('does not ring, and does not throw, when the payment cannot be read', async () => {
    await expect(runRacePaymentCompletedEffects({ db: makeDb(null, { message: 'down' }), payment: { id: 'rp1' }, applied })).resolves.toBeTruthy()
    expect(alertRaceSale).not.toHaveBeenCalled()
  })
})
