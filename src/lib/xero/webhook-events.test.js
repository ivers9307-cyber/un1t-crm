// XEROHOOK.1 — one Xero INVOICE event: every failure is `failed` (so the route
// dead-letters it for replay), never `ignored`.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn() }))
const { processXeroInvoiceEvent, parseXeroDate } = await import('./webhook-events.js')

const EVENT = { eventCategory: 'INVOICE', resourceId: 'inv-1', eventType: 'UPDATE' }

function fakeDb({ car = null, carErr = null, bill = null, billErr = null, writeErr = null } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = async () => (table === 'cars' ? { data: car, error: carErr } : { data: bill, error: billErr })
      q.update = (patch) => ({ eq: async () => { writes.push({ table, patch }); return { error: writeErr } } })
      return q
    },
  }
}
const PAID = { Status: 'PAID', AmountPaid: 100, AmountDue: 0, FullyPaidOnDate: '/Date(1763251200000+0000)/' }
const ok = async () => ({ invoice: PAID })

describe('processXeroInvoiceEvent', () => {
  it('records a paid car invoice', async () => {
    const db = fakeDb({ car: { id: 'car1', location_id: 'loc1', xero_invoice_paid_at: null } })
    expect(await processXeroInvoiceEvent(db, EVENT, { fetchInvoice: ok })).toEqual({ status: 'processed', kind: 'car', locationId: 'loc1' })
    expect(db.writes[0]).toMatchObject({ table: 'cars', patch: { xero_invoice_status: 'PAID', xero_invoice_amount_paid: 100 } })
  })

  it('records a supplier bill', async () => {
    const db = fakeDb({ bill: { id: 'q1', location_id: 'loc1' } })
    expect((await processXeroInvoiceEvent(db, EVENT, { fetchInvoice: ok })).kind).toBe('bill')
    expect(db.writes[0].patch).toMatchObject({ xero_bill_status: 'PAID', xero_bill_amount_due: 0 })
  })

  it('a failed read, Xero fetch or write is failed, never skipped', async () => {
    expect((await processXeroInvoiceEvent(fakeDb({ carErr: { message: 'down' } }), EVENT, { fetchInvoice: ok })).reason).toBe('car_read_failed')
    expect((await processXeroInvoiceEvent(fakeDb({ billErr: { message: 'down' } }), EVENT, { fetchInvoice: ok })).reason).toBe('bill_read_failed')
    const fetchFails = async () => ({ error: new Error('token expired') })
    expect(await processXeroInvoiceEvent(fakeDb({ car: { id: 'c', location_id: 'loc1' } }), EVENT, { fetchInvoice: fetchFails }))
      .toMatchObject({ status: 'failed', reason: 'xero_fetch_failed', locationId: 'loc1' })
    expect((await processXeroInvoiceEvent(fakeDb({ car: { id: 'c', location_id: 'loc1' }, writeErr: { message: 'down' } }), EVENT, { fetchInvoice: ok })).reason).toBe('car_write_failed')
  })

  it('an invoice the CRM did not create, or a non-invoice event, is ignored', async () => {
    expect((await processXeroInvoiceEvent(fakeDb(), EVENT, { fetchInvoice: ok })).status).toBe('ignored')
    expect((await processXeroInvoiceEvent(fakeDb(), { eventCategory: 'CONTACT' })).status).toBe('ignored')
  })

  it('parses the Microsoft JSON date shape', () => {
    expect(parseXeroDate('/Date(1763251200000+0000)/')).toBe('2025-11-16T00:00:00.000Z')
    expect(parseXeroDate('not a date')).toBeNull()
  })
})
