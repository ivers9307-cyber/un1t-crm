// CARXERO.1 — pushing a car document's bill to Xero records it on the car
// document, which is what the car's completion gate (completionGaps) waits
// for. Before this, nothing wrote car_documents.xero_sent_at once the
// per-document Email button was removed, so no car could be completed
// (audit 2026-11-15: 7 cars pending, 0 of 12 documents stamped).
// Fictional ids only.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn(), XeroError: class extends Error {} }))
vi.mock('@/lib/xero/attachments', () => ({ attachInvoiceFile: vi.fn() }))

import { markCarDocumentInXero } from './push-xero'
import { completionGaps, REQUIRED_DOCUMENT_TYPES } from '@/lib/cars'

function fakeDb({ rows = [{ id: 'doc-1' }], error = null } = {}) {
  const calls = []
  const chain = {
    update: vi.fn((patch) => { calls.push({ op: 'update', patch }); return chain }),
    eq: vi.fn((c, v) => { calls.push({ op: 'eq', c, v }); return chain }),
    is: vi.fn((c, v) => { calls.push({ op: 'is', c, v }); return chain }),
    select: vi.fn(() => Promise.resolve({ data: error ? null : rows, error })),
  }
  return { calls, from: vi.fn((t) => { calls.push({ op: 'from', t }); return chain }) }
}

const CAR_ROW = { id: 'q-1', source_type: 'car_document', source_car_document_id: 'doc-1' }

describe('markCarDocumentInXero', () => {
  it('stamps xero_sent_at and the bill id on the source document, first stamp only', async () => {
    const db = fakeDb()
    expect(await markCarDocumentInXero(db, CAR_ROW, 'bill-1')).toBe(true)
    expect(db.calls).toContainEqual({ op: 'from', t: 'car_documents' })
    const upd = db.calls.find((c) => c.op === 'update').patch
    expect(upd.xero_bill_id).toBe('bill-1')
    expect(typeof upd.xero_sent_at).toBe('string')
    expect(db.calls).toContainEqual({ op: 'eq', c: 'id', v: 'doc-1' })
    expect(db.calls).toContainEqual({ op: 'is', c: 'xero_sent_at', v: null })
  })

  it('does nothing for a queue row that is not a car document', async () => {
    const db = fakeDb()
    expect(await markCarDocumentInXero(db, { id: 'q-2', source_type: 'email', source_car_document_id: null }, 'bill-2')).toBe(false)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('a failed stamp is logged and reported false, never thrown (the bill exists)', async () => {
    const db = fakeDb({ error: { code: '57014', message: 'timeout' } })
    await expect(markCarDocumentInXero(db, CAR_ROW, 'bill-1')).resolves.toBe(false)
  })

  it('an already-stamped document reports false (no row matched)', async () => {
    const db = fakeDb({ rows: [] })
    expect(await markCarDocumentInXero(db, CAR_ROW, 'bill-1')).toBe(false)
  })
})

describe('the completion gate reads the stamp', () => {
  const car = (stamped) => ({
    buyer_name: 'Buyer', xero_invoice_id: 'inv-1', uk_vat_refund_received: true,
    car_documents: REQUIRED_DOCUMENT_TYPES.map((r) => ({ doc_type: r.key, xero_sent_at: stamped ? '2026-11-15T10:00:00Z' : null })),
  })
  it('every required document stamped → no gaps; none stamped → one waiting gap per type', () => {
    expect(completionGaps(car(true))).toEqual([])
    const gaps = completionGaps(car(false))
    expect(gaps).toHaveLength(REQUIRED_DOCUMENT_TYPES.length)
    for (const g of gaps) expect(g).toMatch(/waiting for the bookkeeper to send it to Xero$/)
  })
})
