// DEPOSITREISSUE.1 — re-issuing a deposit link never orphans a payment on the
// old link: it asks Revolut about the old order first.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'u1' })), assertLocationAccessOr404: () => null }))
vi.mock('@/lib/permissions', () => ({ hasPermissionAtAnyLocation: () => true, hasPermissionForLocation: () => true }))
vi.mock('@/lib/app-url', () => ({ getDepositBaseUrl: () => 'https://pay.test', getRequestOrigin: () => 'https://pay.test' }))
vi.mock('@/lib/orders', () => ({ syncOrderFromCarDeposit: vi.fn() }))
vi.mock('@/lib/contact-events', () => ({ emitEvent: vi.fn(), EVENT_TYPES: { ORDER_CREATED: 'order_created' } }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ getOrder: vi.fn() }))
vi.mock('@/lib/car-deposit-revolut', async (orig) => ({ ...(await orig()), applyCarDepositUpdates: vi.fn(async () => ({ written: true })) }))

let car, writes, supersedeErr
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const q = {}
      q.select = () => q
      q.eq = async () => ({ error: null })
      q.single = async () => ({ data: car, error: null })
      if (table === 'cars') {
        q.select = () => ({ eq: () => ({ single: async () => ({ data: car, error: null }) }) })
        q.update = (patch) => { writes.push({ table, patch }); return { eq: async () => ({ error: null }) } }
      }
      q.upsert = async (row) => { writes.push({ table, upsert: row }); return { error: supersedeErr } }
      q.insert = async () => ({ error: null })
      return q
    },
  }),
}))

const { POST } = await import('./route.js')
const { getOrder } = await import('@/lib/revolut')
const { applyCarDepositUpdates } = await import('@/lib/car-deposit-revolut')
const issue = () => POST(new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: 'car1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  supersedeErr = null
  car = { id: 'car1', location_id: 'loc1', deposit_status: 'terms_accepted', deposit_token: 't-old', deposit_amount: 500, deposit_revolut_order_id: 'o-old', locations: { timezone: 'Europe/Dublin' } }
})

const carWrite = () => writes.find((w) => w.table === 'cars')

describe('POST /api/cars/[id]/issue-deposit-link — the previous order', () => {
  it('a still-pending old order is recorded as superseded, then the link is re-issued', async () => {
    getOrder.mockResolvedValue({ state: 'pending' })
    const res = await issue()
    expect(res.status).toBe(200)
    expect(writes.find((w) => w.table === 'car_deposit_superseded_orders').upsert).toMatchObject({ order_id: 'o-old', car_id: 'car1' })
    expect(carWrite().patch).toMatchObject({ deposit_revolut_order_id: null, deposit_status: 'sent' })
  })

  it('no record of the superseded order, no re-issue (503)', async () => {
    getOrder.mockResolvedValue({ state: 'pending' })
    supersedeErr = { message: 'down' }
    expect((await issue()).status).toBe(503)
    expect(carWrite()).toBeUndefined()
  })

  it('an old order already paid is recorded and the link is not re-issued (409)', async () => {
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
    const res = await issue()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('already_paid')
    expect(applyCarDepositUpdates).toHaveBeenCalled()
    expect(carWrite()).toBeUndefined()
  })

  it('a payment going through on the old link blocks the re-issue (409)', async () => {
    getOrder.mockResolvedValue({ state: 'processing' })
    expect((await issue()).status).toBe(409)
    expect(carWrite()).toBeUndefined()
  })

  it('an unreadable old order blocks the re-issue (503)', async () => {
    getOrder.mockRejectedValue(new Error('revolut down'))
    expect((await issue()).status).toBe(503)
    expect(carWrite()).toBeUndefined()
  })

  it('a cancelled old order, or no old order, re-issues straight away', async () => {
    getOrder.mockResolvedValue({ state: 'cancelled' })
    expect((await issue()).status).toBe(200)
    car = { ...car, deposit_revolut_order_id: null }
    getOrder.mockClear()
    expect((await issue()).status).toBe(200)
    expect(getOrder).not.toHaveBeenCalled()
  })
})
