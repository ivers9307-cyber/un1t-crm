// XEROBULK.1 (October audit A16) — bulk send records each push through the
// shared outcome, so a bill whose source file did not attach stays retryable,
// and it remembers supplier coding the way single-row approve does.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ROW = (id, extra = {}) => ({
  id, location_id: 'loc1', status: 'extracted', source_type: 'email',
  extracted_fields: {
    vat_rate: 'INPUT2', tax_type: 'INPUT2',
    xero_contact_ref: { kind: 'existing', xero_contact_id: 'c1', name: 'Acme' }, xero_account_id: 'a1',
  },
  ...extra,
})
let rows
vi.mock('../_bulk-helpers', async (orig) => ({
  ...(await orig()),
  loadBookkeeper: vi.fn(async () => ({ user: { id: 'bk' }, db: fakeDb })),
  loadAndScopeBulkRows: vi.fn(async ({ ids }) => ({
    rowsById: Object.fromEntries(ids.filter((i) => rows[i]).map((i) => [i, rows[i]])), missingIds: [], forbiddenIds: [],
  })),
}))
vi.mock('@/lib/invoices-queue/vat', () => ({ hasResolvedVatRate: () => true }))
vi.mock('@/lib/invoices-queue/push-xero', () => ({ pushQueueRowToXero: vi.fn() }))
vi.mock('@/lib/invoices-queue/push-outcome', () => ({ recordPushOutcome: vi.fn(), rememberSupplierCoding: vi.fn(async () => true) }))

const fakeDb = {
  from: () => {
    const q = {}
    q.update = () => q
    q.eq = () => q
    q.select = () => q
    q.maybeSingle = async () => ({ data: { id: 'x' }, error: null })
    q.then = (res) => Promise.resolve({ data: null, error: null }).then(res)
    return q
  },
}

const { POST } = await import('./route.js')
const { pushQueueRowToXero } = await import('@/lib/invoices-queue/push-xero')
const { recordPushOutcome, rememberSupplierCoding } = await import('@/lib/invoices-queue/push-outcome')
const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'a0000000-0000-4000-8000-00000000000b'
const send = (ids) => POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ ids }), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  vi.clearAllMocks()
  rows = { [A]: ROW(A), [B]: ROW(B) }
  pushQueueRowToXero.mockImplementation(async (id) => ({ billId: `bill-${id}`, billNumber: 'N', deepLinkUrl: 'u' }))
  recordPushOutcome.mockResolvedValue({ outcome: 'ok', row: { id: A } })
})

describe('POST /api/invoices-inbox/bulk-send', () => {
  it('a missing attachment is reported per row, never counted as sent', async () => {
    recordPushOutcome
      .mockResolvedValueOnce({ outcome: 'ok', row: { id: A } })
      .mockResolvedValueOnce({ outcome: 'attachment_failed', message: 'attach failed' })
    const res = await send([A, B])
    const { data } = await res.json()
    expect(data.counts).toEqual({ ok: 1, attachment_failed: 1 })
    expect(data.results.find((r) => r.id === B)).toMatchObject({ outcome: 'attachment_failed', retry_state: 'data_approved', bill_id: `bill-${B}` })
  })

  it('every push goes through the shared outcome', async () => {
    await send([A])
    expect(recordPushOutcome).toHaveBeenCalledWith(fakeDb, A, expect.objectContaining({ billId: `bill-${A}` }))
  })

  it('remembers supplier coding on approval, as single-row approve does', async () => {
    await send([A])
    expect(rememberSupplierCoding).toHaveBeenCalledWith(fakeDb, rows[A])
  })

  it('a supplier-memory failure never blocks the send', async () => {
    rememberSupplierCoding.mockRejectedValueOnce(new Error('down'))
    const { data } = await (await send([A])).json()
    expect(data.counts).toEqual({ ok: 1 })
  })

  it('a conflict or write error is a failed row', async () => {
    recordPushOutcome.mockResolvedValueOnce({ outcome: 'conflict' }).mockResolvedValueOnce({ outcome: 'error', message: 'down' })
    const { data } = await (await send([A, B])).json()
    expect(data.counts).toEqual({ failed: 2 })
  })

  it('a row that needs a look is skipped before any change and never pushed', async () => {
    rows[A] = ROW(A, { review_reasons: ['no_vat_rate'] })
    const { loadAndScopeBulkRows } = await import('../_bulk-helpers')
    const { data } = await (await send([A])).json()
    expect(data.results).toEqual([{ id: A, outcome: 'skipped', reason: 'needs_a_look' }])
    expect(pushQueueRowToXero).not.toHaveBeenCalled()
    expect(rememberSupplierCoding).not.toHaveBeenCalled()
    expect(loadAndScopeBulkRows.mock.calls[0][0].select).toMatch(/\breview_reasons\b/)
  })

  it('a row with no reasons, or none recorded yet, is sent', async () => {
    rows[A] = ROW(A, { review_reasons: [] })
    rows[B] = ROW(B, { review_reasons: null })
    const { data } = await (await send([A, B])).json()
    expect(data.counts).toEqual({ ok: 2 })
    expect(pushQueueRowToXero).toHaveBeenCalledWith(A)
    expect(pushQueueRowToXero).toHaveBeenCalledWith(B)
  })

  it.each([[null], [[]]])('a credit note is never sent, whatever its reasons (%j)', async (reasons) => {
    rows = { [A]: ROW(A, { review_reasons: reasons, extracted_fields: { ...ROW(A).extracted_fields, document_type: 'credit_note' } }) }
    const { data } = await (await send([A])).json()
    expect(data.results).toEqual([{ id: A, outcome: 'skipped', reason: 'credit_note' }])
    expect(pushQueueRowToXero).not.toHaveBeenCalled()
  })
})
