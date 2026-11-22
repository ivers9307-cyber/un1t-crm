// RCOV.P2 — POST /api/accounting/coverage/[id]/upload through the real withAuth
// wrapper: accounting_hub at the active studio, line scoped to it (404), the
// file into the studio's invoices_queue, the line flipped to 'submitted'.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/invoices-queue/queue-preparation', () => ({ queueInvoicePreparation: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { queueInvoicePreparation } = await import('@/lib/invoices-queue/queue-preparation')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const L1 = 'e1000000-0000-4000-8000-000000000011'
const L_OTHER = 'e1000000-0000-4000-8000-000000000012'
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46])
const post = (id = L1) => {
  const form = new FormData()
  form.append('file', new File([PDF], 'receipt.pdf', { type: 'application/pdf' }))
  return POST(new Request(`http://localhost/api/accounting/coverage/${id}/upload`, { method: 'POST', body: form }), { params: Promise.resolve({ id }) })
}
const owner = () => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: true } } }, LOC_A)
let db
let upload

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    recon_bank_lines: [
      { id: L1, location_id: LOC_A, status: 'uncovered', description: 'Card spend', hunt_queued_at: '2026-11-19T10:00:00Z' },
      { id: L_OTHER, location_id: LOC_B, status: 'uncovered' },
    ],
    invoices_queue: [],
  } })
  upload = vi.fn(async () => ({ error: null }))
  db.storage = { from: () => ({ upload }) }
  createServerClient.mockReturnValue(db)
  queueInvoicePreparation.mockResolvedValue({ queued: [] })
})

describe('POST /api/accounting/coverage/[id]/upload', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without accounting_hub, nothing uploaded', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { accounting_hub: false } } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('404 for a line at another studio', async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await post(L_OTHER)).status).toBe(404)
    expect(upload).not.toHaveBeenCalled()
  })

  it('queues the document and submits the line', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deduped).toBe(false)
    expect(db.tables.invoices_queue).toHaveLength(1)
    expect(db.tables.invoices_queue[0]).toMatchObject({ location_id: LOC_A, status: 'received', attachment_mime_type: 'application/pdf' })
    expect(db.tables.recon_bank_lines[0]).toMatchObject({ status: 'submitted', invoices_queue_id: body.data.queueId, hunt_queued_at: null })
    expect(queueInvoicePreparation).toHaveBeenCalledWith(db, [body.data.queueId])
  })

  it('a queueing failure is logged and never fails the upload', async () => {
    getCurrentUser.mockResolvedValue(owner())
    queueInvoicePreparation.mockRejectedValueOnce(new Error('down'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.tables.recon_bank_lines[0].status).toBe('submitted')
    expect(logError).toHaveBeenCalled()
  })

  it('a deduped upload is not queued again', async () => {
    getCurrentUser.mockResolvedValue(owner())
    await post()
    queueInvoicePreparation.mockClear()
    db.tables.recon_bank_lines[0].status = 'uncovered'
    const body = await (await post()).json()
    expect(body.data.deduped).toBe(true)
    expect(queueInvoicePreparation).not.toHaveBeenCalled()
  })

  it("a storage failure is a 502 without storage's text", async () => {
    getCurrentUser.mockResolvedValue(owner())
    upload.mockResolvedValueOnce({ error: { message: 'secret storage text' } })
    const res = await post()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Upload failed.' })
    expect(db.tables.recon_bank_lines[0].status).toBe('uncovered')
  })

  it('a failed queue insert is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(owner())
    db.errors.invoices_queue = { insert: { message: 'secret db text' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })
})
