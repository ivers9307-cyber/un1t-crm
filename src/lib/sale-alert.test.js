import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn() }))
const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', () => ({ after: afterMock }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { sendPushToRolesAtLocationOnce } from './push-dedup'
import { logError } from './log'
import { SALE_ALERT_ROLES, saleAlertKey, buildSaleAlertPayload, notifyNewSale, ringSaleAfterResponse } from './sale-alert'

const base = {
  source: 'offer',
  saleId: 'abc',
  locationId: 'loc-1',
  itemName: '20 Class Pack',
  amountCents: 25000,
  buyerFirstName: 'Jordan',
  locationName: 'Stillorgan',
}

beforeEach(() => {
  vi.clearAllMocks()
  sendPushToRolesAtLocationOnce.mockResolvedValue({ sent: 1 })
})

describe('buildSaleAlertPayload', () => {
  it('builds title and body', () => {
    const p = buildSaleAlertPayload(base)
    expect(p.title).toBe('New sale: 20 Class Pack (€250)')
    expect(p.body).toBe('Jordan · Stillorgan')
    expect(p.category).toBe('sale')
    expect(p.data).toEqual({ type: 'sale_new' })
  })

  it('omits the amount when unknown', () => {
    expect(buildSaleAlertPayload({ ...base, amountCents: null }).title).toBe('New sale: 20 Class Pack')
  })

  it('falls back to Purchase and carries contact_id', () => {
    const p = buildSaleAlertPayload({ ...base, itemName: '', contactId: 'c1' })
    expect(p.title).toBe('New sale: Purchase (€250)')
    expect(p.data).toEqual({ type: 'sale_new', contact_id: 'c1' })
  })

  it('flattens multi-line names', () => {
    const p = buildSaleAlertPayload({ ...base, itemName: 'A\n  B', buyerFirstName: 'Jo\nrdan' })
    expect(p.title).toBe('New sale: A B (€250)')
    expect(p.body).toBe('Jo rdan · Stillorgan')
  })

  it('drops missing body parts', () => {
    expect(buildSaleAlertPayload({ ...base, buyerFirstName: null }).body).toBe('Stillorgan')
  })
})

describe('saleAlertKey', () => {
  it('joins source and id', () => {
    expect(saleAlertKey('offer', 'abc')).toBe('sale:offer:abc')
  })
})

describe('notifyNewSale', () => {
  it('delegates once to the dedup sender', async () => {
    const r = await notifyNewSale({}, base)
    expect(r).toEqual({ sent: true })
    expect(sendPushToRolesAtLocationOnce).toHaveBeenCalledTimes(1)
    const [, key, loc, roles, payload, opts] = sendPushToRolesAtLocationOnce.mock.calls[0]
    expect(key).toBe('sale:offer:abc')
    expect(loc).toBe('loc-1')
    expect(roles).toEqual(['owner', 'manager'])
    expect(roles).toBe(SALE_ALERT_ROLES)
    expect(payload.category).toBe('sale')
    expect(opts).toEqual({ locationScoped: true })
  })

  it('does not ring for a negative amount', async () => {
    expect(await notifyNewSale({}, { ...base, amountCents: -500 })).toEqual({ sent: false, reason: 'zero_amount' })
    expect(sendPushToRolesAtLocationOnce).not.toHaveBeenCalled()
  })

  it('does not ring for a zero amount', async () => {
    expect(await notifyNewSale({}, { ...base, amountCents: 0 })).toEqual({ sent: false, reason: 'zero_amount' })
    expect(sendPushToRolesAtLocationOnce).not.toHaveBeenCalled()
  })

  it('rings when the amount is unknown', async () => {
    expect((await notifyNewSale({}, { ...base, amountCents: null })).sent).toBe(true)
  })

  it.each(['source', 'saleId', 'locationId'])('reports missing_key without %s', async (k) => {
    expect(await notifyNewSale({}, { ...base, [k]: undefined })).toEqual({ sent: false, reason: 'missing_key' })
    expect(sendPushToRolesAtLocationOnce).not.toHaveBeenCalled()
  })

  it('never throws when the sender rejects', async () => {
    sendPushToRolesAtLocationOnce.mockRejectedValue(new Error('boom'))
    expect(await notifyNewSale({}, base)).toEqual({ sent: false, reason: 'error' })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('uses the same key on repeat calls', async () => {
    await notifyNewSale({}, base)
    await notifyNewSale({}, base)
    expect(sendPushToRolesAtLocationOnce).toHaveBeenCalledTimes(2)
    expect(sendPushToRolesAtLocationOnce.mock.calls[0][1]).toBe(sendPushToRolesAtLocationOnce.mock.calls[1][1])
  })
})

describe('ringSaleAfterResponse', () => {
  beforeEach(() => { afterMock.mockReset() })

  it('hands the work to after() when a request scope exists', async () => {
    const fn = vi.fn(async () => {})
    await ringSaleAfterResponse(fn)
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(fn).not.toHaveBeenCalled()
    await afterMock.mock.calls[0][0]()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs the work immediately when after() throws (cron, tests)', async () => {
    afterMock.mockImplementation(() => { throw new Error('outside a request scope') })
    const fn = vi.fn(async () => {})
    await ringSaleAfterResponse(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('never throws, whichever way the work fails', async () => {
    afterMock.mockImplementation(() => { throw new Error('outside a request scope') })
    await expect(ringSaleAfterResponse(async () => { throw new Error('boom') })).resolves.toBeUndefined()
    afterMock.mockReset()
    ringSaleAfterResponse(() => { throw new Error('sync boom') })
    await expect(afterMock.mock.calls[0][0]()).resolves.toBeUndefined()
  })
})
