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
})
