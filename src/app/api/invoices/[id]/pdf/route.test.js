// GET /api/invoices/[id]/pdf through the real withAuth wrapper (ROUTEWRAP.R6):
// the contractor themself, an owner at the invoice's studio, or a master; a
// 404 for anyone else; no storage text in a failed sign.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const INV = 'c1000000-0000-4000-8000-000000000001'
const CONTRACTOR = 'c2000000-0000-4000-8000-000000000002'
let db, signResult
const get = () => GET(new Request(`http://localhost/api/invoices/${INV}/pdf`), { params: Promise.resolve({ id: INV }) })

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { contractor_invoices: [{ id: INV, contractor_id: CONTRACTOR, location_id: LOC_A, pdf_path: 'x/inv.pdf' }] } })
  signResult = { data: { signedUrl: 'https://signed.example/inv.pdf' }, error: null }
  db.storage = { from: () => ({ createSignedUrl: vi.fn(async () => signResult) }) }
  createServerClient.mockReturnValue(db)
})

describe('GET /api/invoices/[id]/pdf', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for an owner at another studio (and for a manager at this one)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    expect((await get()).status).toBe(404)
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    expect((await get()).status).toBe(404)
  })

  it("an owner at the invoice's studio and the contractor themself get the link", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, url: 'https://signed.example/inv.pdf', expires_in: 300 })
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_B]: { role: 'staff' } }, LOC_B), id: CONTRACTOR })
    expect((await get()).status).toBe(200)
  })

  it('a failed sign is a 500 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    signResult = { data: null, error: { message: 'Object not found in bucket contractor-invoices' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/bucket|Object/)
  })
})
