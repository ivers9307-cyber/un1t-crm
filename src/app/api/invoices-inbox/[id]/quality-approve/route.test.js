// INVOICES.1 — POST /api/invoices-inbox/[id]/quality-approve through the real
// withAuth wrapper: invoices_inbox and master-or-owner at the invoice's studio,
// every refusal a 404 (loadInvoiceForCaller).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const INV = 'c1000000-0000-4000-8000-000000000001'
const INV_B = 'c1000000-0000-4000-8000-000000000002'
const rows = () => [
  { id: INV, location_id: LOC_A, status: 'received', attachment_path: 'inv/one.pdf' },
  { id: INV_B, location_id: LOC_B, status: 'received', attachment_path: 'inv/two.pdf' },
]
const post = (id = INV) => POST(new Request(`http://localhost/api/invoices-inbox/${id}/quality-approve`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const ownerA = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { invoices_queue: rows(), locations: [{ id: LOC_A, name: 'A' }, { id: LOC_B, name: 'B' }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/invoices-inbox/[id]/quality-approve', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('404 for a manager at the studio (approval is owner or master), nothing changed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(404)
    expect(db.tables.invoices_queue[0].status).toBe('received')
  })

  it('404 for an invoice at another studio', async () => {
    getCurrentUser.mockResolvedValue(ownerA())
    const res = await post(INV_B)
    expect(res.status).toBe(404)
    expect(db.tables.invoices_queue[1].status).toBe('received')
  })

  it('an owner at the studio approves it', async () => {
    getCurrentUser.mockResolvedValue(ownerA())
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: INV, status: 'quality_approved', quality_reviewed_by: 'user-1' })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(ownerA())
    createServerClient.mockReturnValue(createFakeDb({ tables: { invoices_queue: rows() }, errors: { invoices_queue: { update: { message: 'secret detail' } } } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
