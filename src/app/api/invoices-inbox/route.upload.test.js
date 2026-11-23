// INVOICEPREP.1 — a manually uploaded invoice file stores its content hash.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { sha256Hex } from '@/lib/inbound-invoices'

const LOC = 'a0000000-0000-4000-8000-0000000000a1'
let db
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'master', profileRole: 'master', locations: [], activeLocation: null })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

vi.mock('@/lib/invoices-queue/queue-preparation', () => ({ queueInvoicePreparation: vi.fn(async () => ({ queued: [] })) }))

const { POST } = await import('./route.js')
const { queueInvoicePreparation } = await import('@/lib/invoices-queue/queue-preparation')

beforeEach(() => {
  vi.clearAllMocks()
  queueInvoicePreparation.mockResolvedValue({ queued: [] })
})

function uploadRequest() {
  const form = new FormData()
  form.set('file', new File([new TextEncoder().encode('%PDF-1.4 example')], 'invoice.pdf', { type: 'application/pdf' }))
  form.set('location_id', LOC)
  return new Request('http://localhost/api/invoices-inbox', { method: 'POST', body: form })
}

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

  // INVOICEPREP.3 — an uploaded file is read and checked on arrival.
  it('queues the new row for preparation once, with the route client', async () => {
    db = createFakeDb({ tables: { invoices_queue: [] } })
    db.storage = { from: () => ({ upload: vi.fn(async () => ({ error: null })) }) }
    const res = await POST(uploadRequest())
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(queueInvoicePreparation).toHaveBeenCalledTimes(1)
    expect(queueInvoicePreparation).toHaveBeenCalledWith(db, [json.data.id])
  })

  it('does not queue when the storage upload fails', async () => {
    db = createFakeDb({ tables: { invoices_queue: [] } })
    db.storage = { from: () => ({ upload: vi.fn(async () => ({ error: { message: 'boom' } })) }) }
    const res = await POST(uploadRequest())
    expect(res.status).toBe(500)
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it('a helper that rejects leaves the 201 and its body unchanged', async () => {
    db = createFakeDb({ tables: { invoices_queue: [] } })
    db.storage = { from: () => ({ upload: vi.fn(async () => ({ error: null })) }) }
    queueInvoicePreparation.mockRejectedValue(new Error('qstash down'))
    const res = await POST(uploadRequest())
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.success).toBe(true)
    expect(json.data.attachment_path).toBeTruthy()
  })
})
