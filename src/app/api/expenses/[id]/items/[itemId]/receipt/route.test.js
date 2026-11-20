// FTE-EXPENSES.1 — GET /api/expenses/[id]/items/[itemId]/receipt through the
// real withAuth wrapper: whoever can see the claim (canSeeExpenseClaim), else
// the missing-item 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CLAIM = 'c1000000-0000-4000-8000-000000000001'
const ITEM = 'c2000000-0000-4000-8000-000000000001'
const CLAIMANT = 'a1000000-0000-4000-8000-000000000001'
let signError
const build = () => {
  const d = createFakeDb({
    tables: {
      fte_expense_claims: [{ id: CLAIM, profile_id: CLAIMANT, location_id: LOC_A }],
      fte_expense_items: [{ id: ITEM, claim_id: CLAIM, receipt_path: 'r/one.pdf', receipt_mime_type: 'application/pdf' }],
    },
  })
  d.storage = { from: () => ({ createSignedUrl: async (p) => (signError ? { data: null, error: signError } : { data: { signedUrl: `https://signed/${p}` }, error: null }) }) }
  return d
}
const get = () => GET(new Request(`http://localhost/api/expenses/${CLAIM}/items/${ITEM}/receipt`), { params: Promise.resolve({ id: CLAIM, itemId: ITEM }) })

beforeEach(() => {
  vi.clearAllMocks()
  signError = null
  createServerClient.mockReturnValue(build())
})

describe('GET /api/expenses/[id]/items/[itemId]/receipt', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('404 for staff at the studio who is not the claimant or an approver', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('404 for an owner of another studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    expect((await get()).status).toBe(404)
  })

  it('the claimant gets a signed URL', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), id: CLAIMANT })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, url: 'https://signed/r/one.pdf', expires_in: 300, mime_type: 'application/pdf' })
  })

  it('a failed signing is a 500 without the storage text', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    signError = { message: 'secret detail' }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
