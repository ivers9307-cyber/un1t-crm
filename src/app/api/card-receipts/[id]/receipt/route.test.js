// GET /api/card-receipts/[id]/receipt through the real withAuth wrapper
// (ROUTEWRAP.R6): the submitter, an owner at the receipt's studio, or a
// master; 404 for anyone else; no database or storage text in a failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, MASTER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const REC = 'c3000000-0000-4000-8000-000000000001'
const SUBMITTER = 'c4000000-0000-4000-8000-000000000001'
let db, signResult
const get = () => GET(new Request(`http://localhost/api/card-receipts/${REC}/receipt`), { params: Promise.resolve({ id: REC }) })

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { card_receipts: [{ id: REC, location_id: LOC_A, submitter_id: SUBMITTER, receipt_path: 'u/r.pdf', receipt_mime_type: 'application/pdf' }] } })
  signResult = { data: { signedUrl: 'https://signed.example/r.pdf' }, error: null }
  db.storage = { from: () => ({ createSignedUrl: vi.fn(async () => signResult) }) }
  createServerClient.mockReturnValue(db)
})

describe('GET /api/card-receipts/[id]/receipt', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for an owner at another studio and a manager at this one', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    expect((await get()).status).toBe(404)
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    expect((await get()).status).toBe(404)
  })

  it("the submitter, an owner at the receipt's studio and a master get the link", async () => {
    for (const caller of [
      { ...person({ [LOC_B]: { role: 'staff' } }, LOC_B), id: SUBMITTER },
      person({ [LOC_A]: { role: 'owner' } }, LOC_A),
      MASTER,
    ]) {
      getCurrentUser.mockResolvedValue(caller)
      const res = await get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, url: 'https://signed.example/r.pdf', expires_in: 300, mime_type: 'application/pdf' })
    }
  })

  it('failures answer fixed messages with the same statuses', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    signResult = { data: null, error: { message: 'Bucket not found: company-card-receipts' } }
    const sign = await get()
    expect(sign.status).toBe(500)
    expect((await sign.json()).error).not.toMatch(/Bucket/)
    db.errors.card_receipts = { select: { code: '57014', message: 'statement timeout on card_receipts' } }
    const read = await get()
    expect(read.status).toBe(400)
    expect((await read.json()).error).not.toMatch(/card_receipts/)
  })
})
