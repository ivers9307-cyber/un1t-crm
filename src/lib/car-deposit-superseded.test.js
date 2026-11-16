// DEPOSITREISSUE.1 — what a re-issue does with the old order, and how an order
// a re-issue superseded is settled.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./orders', () => ({ syncOrderFromCarDeposit: vi.fn() }))
vi.mock('./contact-events', () => ({ emitEvent: vi.fn(), EVENT_TYPES: {} }))
vi.mock('./sequences', () => ({ triggerSequencesForOrderStatus: vi.fn() }))
vi.mock('./log', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))

const { reissueDecision, settleSupersededOrder } = await import('./car-deposit-revolut.js')
const { logError } = await import('./log')

describe('reissueDecision', () => {
  it('maps the old order state', () => {
    expect(reissueDecision('completed')).toBe('paid')
    expect(reissueDecision('processing')).toBe('in_flight')
    expect(reissueDecision('authorised')).toBe('in_flight')
    expect(reissueDecision('pending')).toBe('record_then_rotate')
    expect(reissueDecision('cancelled')).toBe('rotate')
    expect(reissueDecision('failed')).toBe('rotate')
  })
})

function fakeDb({ row = { order_id: 'o-old', car_id: 'car1', settled_at: null }, car = { id: 'car1', location_id: 'loc1', deposit_status: 'sent', deposit_amount: 500, deposit_revolut_order_id: null, buyer_email: null } } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const q = { table }
      q.select = () => q
      q.eq = () => q
      q.is = () => q
      q.maybeSingle = async () => ({ data: table === 'car_deposit_superseded_orders' ? row : car, error: null })
      q.upsert = async (r) => { writes.push({ table, upsert: r }); return { error: null } }
      q.update = (patch) => {
        writes.push({ table, patch })
        const w = { eq: () => w, is: () => w, select: async () => ({ data: [{ id: 'car1' }], error: null }), then: (r) => Promise.resolve({ error: null }).then(r) }
        return w
      }
      return q
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('settleSupersededOrder', () => {
  it('a completed old order marks the car paid and becomes its order of record', async () => {
    const db = fakeDb()
    const r = await settleSupersededOrder({ db, orderId: 'o-old', getOrder: async () => ({ state: 'completed', amount: 50000, currency: 'EUR' }) })
    expect(r.outcome).toBe('settled')
    const carWrite = db.writes.find((w) => w.table === 'cars')
    expect(carWrite.patch).toMatchObject({ deposit_status: 'paid', deposit_paid_amount: 500, deposit_revolut_order_id: 'o-old' })
    expect(db.writes.find((w) => w.table === 'car_deposit_superseded_orders').patch).toMatchObject({ settled_state: 'completed' })
  })

  it('a cancelled or failed old order is closed and the car (its new link live) is untouched', async () => {
    const db = fakeDb()
    expect((await settleSupersededOrder({ db, orderId: 'o-old', getOrder: async () => ({ state: 'cancelled' }) })).outcome).toBe('closed')
    expect(db.writes.find((w) => w.table === 'cars')).toBeUndefined()
  })

  it('a still-pending order is left open', async () => {
    expect((await settleSupersededOrder({ db: fakeDb(), orderId: 'o-old', getOrder: async () => ({ state: 'pending' }) })).outcome).toBe('still_pending')
  })

  it('a completed old order on a car already paid by its new link is a double payment, logged for a refund', async () => {
    const db = fakeDb({ car: { id: 'car1', deposit_status: 'paid', deposit_amount: 500, deposit_revolut_order_id: 'o-new' } })
    expect((await settleSupersededOrder({ db, orderId: 'o-old', getOrder: async () => ({ state: 'completed' }) })).outcome).toBe('double_payment')
    expect(logError).toHaveBeenCalledWith('car-deposit-revolut', expect.stringMatching(/DOUBLE PAYMENT/), expect.anything())
    expect(db.writes.find((w) => w.table === 'cars')).toBeUndefined()
  })

  it('an old order that paid less than the current deposit never marks the car paid', async () => {
    const db = fakeDb()
    const r = await settleSupersededOrder({ db, orderId: 'o-old', getOrder: async () => ({ state: 'completed', amount: 30000, currency: 'EUR' }) })
    expect(r.outcome).toBe('amount_mismatch')
    expect(db.writes.find((w) => w.table === 'cars')).toBeUndefined()
    expect(db.writes.find((w) => w.patch?.settled_state)?.patch.settled_state).toBe('amount_mismatch')
    expect(logError).toHaveBeenCalled()
  })

  it('an old order in another currency never marks the car paid', async () => {
    const r = await settleSupersededOrder({ db: fakeDb(), orderId: 'o-old', getOrder: async () => ({ state: 'completed', amount: 90000, currency: 'GBP' }) })
    expect(r.outcome).toBe('amount_mismatch')
  })

  it("the car's newer order stays tracked as superseded before the old one becomes the order of record", async () => {
    const db = fakeDb({ car: { id: 'car1', location_id: 'loc1', deposit_status: 'terms_accepted', deposit_amount: 500, deposit_revolut_order_id: 'o-new' } })
    const r = await settleSupersededOrder({ db, orderId: 'o-old', getOrder: async () => ({ state: 'completed', amount: 50000, currency: 'EUR' }) })
    expect(r.outcome).toBe('settled')
    expect(db.writes.find((w) => w.upsert)?.upsert).toMatchObject({ order_id: 'o-new', car_id: 'car1' })
    expect(db.writes.find((w) => w.table === 'cars').patch.deposit_revolut_order_id).toBe('o-old')
  })

  it('an order no re-issue superseded is not ours here', async () => {
    expect((await settleSupersededOrder({ db: fakeDb({ row: null }), orderId: 'x', getOrder: vi.fn() })).outcome).toBe('not_superseded')
  })
})
