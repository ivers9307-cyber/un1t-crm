// XEROBULK.1 (October audit A16) — the shared record of a Xero push.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supplier-defaults.js', () => ({ recordSupplierDefault: vi.fn(async () => {}) }))
const { recordSupplierDefault } = await import('./supplier-defaults.js')
const { recordPushOutcome, rememberSupplierCoding } = await import('./push-outcome.js')

function fakeDb({ rows = [{ id: 'q1' }], error = null } = {}) {
  const writes = []
  return {
    writes,
    from: () => {
      const q = { ops: [] }
      q.update = (p) => { writes.push({ patch: p, ops: q.ops }); return q }
      q.eq = (...a) => { q.ops.push(['eq', ...a]); return q }
      q.select = async () => ({ data: rows, error })
      q.then = (res) => Promise.resolve({ data: null, error }).then(res)
      return q
    },
  }
}
const PUSHED = { billId: 'b1', billNumber: 'INV-1', deepLinkUrl: 'https://xero.test/b1' }

beforeEach(() => vi.clearAllMocks())

describe('recordPushOutcome', () => {
  it('a clean push is forwarded, compare-and-set on data_approved', async () => {
    const db = fakeDb()
    expect(await recordPushOutcome(db, 'q1', PUSHED)).toEqual({ outcome: 'ok', row: { id: 'q1' } })
    expect(db.writes[0].patch).toMatchObject({ status: 'forwarded', xero_bill_id: 'b1', xero_error: null })
    expect(db.writes[0].ops).toContainEqual(['eq', 'status', 'data_approved'])
  })

  it('a failed attachment is never forwarded: it keeps the bill id and an error to retry', async () => {
    const db = fakeDb()
    const r = await recordPushOutcome(db, 'q1', { ...PUSHED, attachmentError: 'storage down' })
    expect(r.outcome).toBe('attachment_failed')
    expect(db.writes[0].patch).not.toHaveProperty('status')
    expect(db.writes[0].patch).toMatchObject({ xero_bill_id: 'b1' })
    expect(db.writes[0].patch.xero_error).toMatch(/storage down/)
  })

  it('a row someone else moved is a conflict; a write error is an error', async () => {
    expect((await recordPushOutcome(fakeDb({ rows: [] }), 'q1', PUSHED)).outcome).toBe('conflict')
    expect((await recordPushOutcome(fakeDb({ error: { message: 'down' } }), 'q1', PUSHED)).outcome).toBe('error')
  })
})

describe('recordPushOutcome — a supplier created on send (NEWSUPPLIER.1)', () => {
  const resolved = { kind: 'existing', xero_contact_id: 'C-NEW', name: 'Brand New Co' }
  const withRow = (row) => {
    const db = fakeDb()
    const from = db.from
    db.from = () => {
      const q = from()
      q.select = () => q
      q.maybeSingle = async () => ({ data: row, error: null })
      const eq = q.eq
      // The forward write still ends in .select(); keep that awaitable.
      q.eq = (...a) => { eq(...a); return Object.assign(q, { select: (cols) => (cols === 'id, location_id, extracted_fields' ? q : Promise.resolve({ data: [{ id: 'q1' }], error: null })) }) }
      return q
    }
    return db
  }
  const sent = { id: 'q1', location_id: 'loc1', extracted_fields: { xero_contact_ref: { kind: 'new', name: 'Brand New Co' }, xero_account_id: 'a1', account_code: '400' } }

  it('remembers the coding under the created contact', async () => {
    const out = await recordPushOutcome(withRow(sent), 'q1', { ...PUSHED, supplierResolved: resolved })
    expect(out.outcome).toBe('ok')
    expect(recordSupplierDefault).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: 'loc1', xeroContactId: 'C-NEW', xeroAccountId: 'a1', supplierName: 'Brand New Co' }))
  })

  it('does nothing extra for an ordinary push', async () => {
    await recordPushOutcome(fakeDb(), 'q1', PUSHED)
    expect(recordSupplierDefault).not.toHaveBeenCalled()
  })

  it('a failure to remember never changes the outcome', async () => {
    recordSupplierDefault.mockRejectedValueOnce(new Error('memory down'))
    expect((await recordPushOutcome(withRow(sent), 'q1', { ...PUSHED, supplierResolved: resolved })).outcome).toBe('ok')
  })
})

describe('rememberSupplierCoding', () => {
  it('records an existing contact with a picked account', async () => {
    const row = { location_id: 'loc1', extracted_fields: { xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1', name: 'Acme' }, xero_account_id: 'a1', account_code: '400', category: 'Supplies' } }
    expect(await rememberSupplierCoding({}, row)).toBe(true)
    expect(recordSupplierDefault).toHaveBeenCalledWith({}, expect.objectContaining({ locationId: 'loc1', xeroContactId: 'c1', xeroAccountId: 'a1' }))
  })
  it('records nothing for a new contact or no account', async () => {
    expect(await rememberSupplierCoding({}, { extracted_fields: { xero_contact_ref: { kind: 'new' }, xero_account_id: 'a1' } })).toBe(false)
    expect(await rememberSupplierCoding({}, { extracted_fields: { xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1' } } })).toBe(false)
    expect(recordSupplierDefault).not.toHaveBeenCalled()
  })
  const base = (ef) => ({ location_id: 'loc1', extracted_fields: { xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1' }, xero_account_id: 'a1', ...ef } })
  const taxTypeSent = () => recordSupplierDefault.mock.calls[0][1].taxType

  const cases = [
    ['manual pick', { tax_type: 'INPUT2', tax_type_source: 'manual' }, 'INPUT2'],
    ['source-less type', { tax_type: 'INPUT2' }, 'INPUT2'],
    ['derived with a breakdown', { tax_type: 'INPUT2', tax_type_source: 'derived', subtotal: 100, tax_amount: 23, total: 123 }, 'INPUT2'],
    ['derived NONE on a no-breakdown receipt', { tax_type: 'NONE', tax_type_source: 'derived', subtotal: 0, tax_amount: 0, total: 96 }, null],
    ['derived NONE with a stated subtotal', { tax_type: 'NONE', tax_type_source: 'derived', subtotal: 96, tax_amount: 0, total: 96 }, 'NONE'],
    ['no type, subtotal shown, zero tax', { subtotal: 96, tax_amount: 0 }, 'NONE'],
    ['no type, subtotal 0, zero tax', { subtotal: 0, tax_amount: 0 }, null],
    ['no type, subtotal blank, zero tax', { subtotal: '', tax_amount: 0 }, null],
    ['no type, null tax_amount', { subtotal: 96, tax_amount: null }, null],
  ]
  it.each(cases)('%s', async (_n, ef, expected) => {
    await rememberSupplierCoding({}, base(ef))
    expect(taxTypeSent()).toBe(expected)
  })
})
