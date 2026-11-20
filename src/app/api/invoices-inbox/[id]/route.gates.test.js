// INVOICES.1 — GET/DELETE /api/invoices-inbox/[id] and GET .../attachment
// through the real withAuth wrapper (ROUTEWRAP.R6). loadInvoiceForUser keeps
// the gate: invoices_inbox AND master-or-owner at the row's studio, 404
// otherwise; no database or storage text in a failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, DELETE } = await import('./route.js')
const { GET: ATTACHMENT } = await import('./attachment/route.js')

const ROW_A = 'd1000000-0000-4000-8000-00000000000a'
const ROW_B = 'd1000000-0000-4000-8000-00000000000b'
let db, signResult
const props = (id) => ({ params: Promise.resolve({ id }) })
const get = (id = ROW_A) => GET(new Request(`http://localhost/api/invoices-inbox/${id}`), props(id))
const del = (id = ROW_A) => DELETE(new Request(`http://localhost/api/invoices-inbox/${id}`, { method: 'DELETE' }), props(id))
const attachment = (id = ROW_A) => ATTACHMENT(new Request(`http://localhost/api/invoices-inbox/${id}/attachment`), props(id))
const owner = (inbox = true) => person({ [LOC_A]: { role: 'owner', permissions: { invoices_inbox: inbox } } }, LOC_A)
const ids = () => db.tables.invoices_queue.map((r) => r.id)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    locations: [{ id: LOC_A, name: 'Studio A' }, { id: LOC_B, name: 'Studio B' }],
    invoices_queue: [
      { id: ROW_A, location_id: LOC_A, status: 'rejected', attachment_path: 'a/inv.pdf', attachment_bucket: 'inbound-invoices' },
      { id: ROW_B, location_id: LOC_B, status: 'rejected', attachment_path: 'b/inv.pdf', attachment_bucket: 'inbound-invoices' },
    ],
  } })
  signResult = { data: { signedUrl: 'https://signed.example/a.pdf' }, error: null }
  db.storage = { from: () => ({ createSignedUrl: vi.fn(async () => signResult), remove: vi.fn(async () => ({ error: null })) }) }
  createServerClient.mockReturnValue(db)
})

describe('/api/invoices-inbox/[id]', () => {
  it('401 signed out on every handler', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await get(), await del(), await attachment()]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(ids()).toEqual([ROW_A, ROW_B])
  })

  it('404 for an owner without invoices_inbox, and for a manager with it', async () => {
    getCurrentUser.mockResolvedValue(owner(false))
    expect((await get()).status).toBe(404)
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    expect((await del()).status).toBe(404)
    expect(ids()).toEqual([ROW_A, ROW_B])
  })

  it("404 for another studio's row on every handler; nothing deleted", async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await get(ROW_B)).status).toBe(404)
    expect((await attachment(ROW_B)).status).toBe(404)
    expect((await del(ROW_B)).status).toBe(404)
    expect(ids()).toEqual([ROW_A, ROW_B])
  })

  it("an owner with invoices_inbox reads, previews and deletes their studio's rejected row", async () => {
    getCurrentUser.mockResolvedValue(owner())
    const read = await get()
    expect(read.status).toBe(200)
    expect((await read.json()).data.id).toBe(ROW_A)
    const att = await attachment()
    expect(att.status).toBe(200)
    expect((await att.json()).data.url).toBe('https://signed.example/a.pdf')
    expect((await del()).status).toBe(200)
    expect(ids()).toEqual([ROW_B])
  })

  it('failures answer fixed messages', async () => {
    getCurrentUser.mockResolvedValue(owner())
    signResult = { data: null, error: { message: 'Bucket not found: inbound-invoices' } }
    const att = await attachment()
    expect(att.status).toBe(500)
    expect((await att.json()).error).not.toMatch(/Bucket/)
    db.errors.invoices_queue = { delete: { code: '23503', message: 'violates foreign key constraint "x_fkey"' } }
    const gone = await del()
    expect(gone.status).toBe(500)
    expect((await gone.json()).error).not.toMatch(/constraint/)
    db.errors.invoices_queue = { select: { code: '57014', message: 'statement timeout on invoices_queue' } }
    const read = await get()
    expect(read.status).toBe(500)
    expect((await read.json()).error).not.toMatch(/invoices_queue/)
  })
})
