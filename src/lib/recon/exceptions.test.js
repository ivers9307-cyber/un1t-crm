// RCOV.P2 — exceptions detection lib. Takes `db` as a parameter
// (statuses.js precedent), so no @/lib/supabase mock is needed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getExceptions } from './exceptions'

// Chain whose FINAL method resolves; intermediate steps return this.
function chainable(finalValue, terminal = 'limit') {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'lt', 'order', 'limit']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

const mockDb = { from: vi.fn() }

beforeEach(() => {
  mockDb.from.mockReset()
})

function queueFive(results) {
  // getExceptions issues exactly five sequential invoices_queue
  // selects: vatMismatches, agingDrafts, unattached, receiptless,
  // stuckRows — in that order.
  for (const r of results) mockDb.from.mockReturnValueOnce(r)
}

const empty = () => chainable({ data: [], error: null })

describe('getExceptions', () => {
  it('maps each section, deriving ocr_tax from extracted_fields on VAT mismatches', async () => {
    const vat = chainable({
      data: [{
        id: 'q-vat', subject: 'Cleaning invoice', xero_total_tax: 19.99,
        extracted_fields: { tax_amount: 23.0 },
        xero_deep_link_url: 'https://go.xero.com/x?InvoiceID=1', forwarded_at: '2026-06-20T10:00:00Z',
      }],
      error: null,
    })
    const drafts = chainable({
      data: [{ id: 'q-d', subject: 'Rent', xero_bill_number: 'B-1', xero_deep_link_url: 'u', forwarded_at: '2026-06-01T00:00:00Z', xero_bill_status_synced_at: '2026-07-03T00:00:00Z' }],
      error: null,
    })
    const unattached = chainable({
      data: [{ id: 'q-u', subject: 'Gear', xero_bill_number: 'B-2', xero_deep_link_url: 'u2', xero_error: 'Bill created in Xero, but attaching the source file failed: boom' }],
      error: null,
    })
    const receiptless = chainable({
      data: [{ id: 'q-r', subject: 'Mileage — coach', status: 'forwarded', forwarded_at: '2026-06-25T00:00:00Z' }],
      error: null,
    })
    const stuck = chainable({
      data: [{ id: 'q-s', subject: 'Old supplier email', status: 'received', received_at: '2026-06-10T00:00:00Z' }],
      error: null,
    })
    queueFive([vat, drafts, unattached, receiptless, stuck])

    const out = await getExceptions(mockDb, 'loc-1')

    expect(out.vatMismatches).toEqual([
      expect.objectContaining({ id: 'q-vat', xero_total_tax: 19.99, ocr_tax: 23.0 }),
    ])
    expect(out.agingDrafts).toHaveLength(1)
    expect(out.unattached).toHaveLength(1)
    expect(out.receiptless).toHaveLength(1)
    expect(out.stuckRows).toHaveLength(1)

    // Detection filters that carry the audit semantics:
    expect(vat.eq).toHaveBeenCalledWith('xero_tax_mismatch', true)
    expect(drafts.eq).toHaveBeenCalledWith('xero_bill_status', 'DRAFT')
    expect(unattached.eq).toHaveBeenCalledWith('status', 'data_approved')
    expect(unattached.not).toHaveBeenCalledWith('xero_bill_id', 'is', null)
    expect(receiptless.is).toHaveBeenCalledWith('attachment_path', null)
    expect(stuck.in).toHaveBeenCalledWith('status', ['received', 'quality_approved', 'extracted', 'data_approved'])
    // Every section scoped to the location.
    for (const c of [vat, drafts, unattached, receiptless, stuck]) {
      expect(c.eq).toHaveBeenCalledWith('location_id', 'loc-1')
    }
  })

  it('returns empty arrays when nothing matches', async () => {
    queueFive([empty(), empty(), empty(), empty(), empty()])
    const out = await getExceptions(mockDb, 'loc-1')
    expect(out).toEqual({
      vatMismatches: [], agingDrafts: [], unattached: [], receiptless: [], stuckRows: [],
    })
    expect(mockDb.from).toHaveBeenCalledTimes(5)
  })

  it('handles a VAT row whose extracted_fields is missing tax_amount', async () => {
    const vat = chainable({
      data: [{ id: 'q-vat', subject: 's', xero_total_tax: 5, extracted_fields: {}, xero_deep_link_url: null, forwarded_at: null }],
      error: null,
    })
    queueFive([vat, empty(), empty(), empty(), empty()])
    const out = await getExceptions(mockDb, 'loc-1')
    expect(out.vatMismatches[0].ocr_tax).toBeNull()
  })

  it('propagates section errors with the section name', async () => {
    queueFive([empty(), chainable({ data: null, error: { message: 'boom' } })])
    await expect(getExceptions(mockDb, 'loc-1')).rejects.toThrow(/agingDrafts failed: boom/)
  })
})
