// INVOICEPREP.1 — a manually uploaded invoice file stores its content hash.
import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { sha256Hex } from '@/lib/inbound-invoices'

const LOC = 'a0000000-0000-4000-8000-0000000000a1'
let db
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'master', profileRole: 'master', locations: [], activeLocation: null })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

const { POST } = await import('./route.js')

describe('POST /api/invoices-inbox', () => {
  it('stores the sha256 of the uploaded bytes on the queue row', async () => {
    db = createFakeDb({ tables: { invoices_queue: [] } })
    db.storage = { from: () => ({ upload: vi.fn(async () => ({ error: null })) }) }
    const bytes = new TextEncoder().encode('%PDF-1.4 example')
    const form = new FormData()
    form.set('file', new File([bytes], 'invoice.pdf', { type: 'application/pdf' }))
    form.set('location_id', LOC)

    const res = await POST(new Request('http://localhost/api/invoices-inbox', { method: 'POST', body: form }))

    expect(res.status).toBe(201)
    expect(db.tables.invoices_queue).toHaveLength(1)
    expect(db.tables.invoices_queue[0].content_hash).toBe(sha256Hex(Buffer.from(bytes)))
  })
})
