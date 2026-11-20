// SPEND.P3 — POST /api/card-receipts/upload-sign through the real withAuth
// wrapper: card_receipts somewhere, then the declared file, then a signed slot
// in the submitter's own folder.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const post = (body) => POST(new Request('http://localhost/api/card-receipts/upload-sign', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const FILE = { size: 1000, mime: 'application/pdf', file_name: 'receipt.pdf' }
const holder = (on) => person({ [LOC_A]: { role: 'staff', permissions: { card_receipts: on } } }, LOC_A)
let sign

beforeEach(() => {
  vi.clearAllMocks()
  sign = vi.fn(async () => ({ data: { token: 'tok-1' }, error: null }))
  const db = createFakeDb()
  db.storage = { from: () => ({ createSignedUploadUrl: sign }) }
  createServerClient.mockReturnValue(db)
})

describe('POST /api/card-receipts/upload-sign', () => {
  it('401 signed out, no slot minted', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(FILE)).status).toBe(401)
    expect(sign).not.toHaveBeenCalled()
  })

  it('403 without card_receipts anywhere', async () => {
    getCurrentUser.mockResolvedValue(holder(false))
    expect((await post(FILE)).status).toBe(403)
    expect(sign).not.toHaveBeenCalled()
  })

  it('400 for a file type that is not accepted', async () => {
    getCurrentUser.mockResolvedValue(holder(true))
    expect((await post({ ...FILE, mime: 'text/html' })).status).toBe(400)
  })

  it('a card holder gets a slot in their own folder', async () => {
    getCurrentUser.mockResolvedValue(holder(true))
    const res = await post(FILE)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ success: true, token: 'tok-1' })
    expect(json.path).toContain('user-1')
  })

  it('a refused signing is a 500 without the storage text', async () => {
    getCurrentUser.mockResolvedValue(holder(true))
    sign.mockResolvedValueOnce({ data: null, error: { message: 'secret detail' } })
    const res = await post(FILE)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
