// MOBILE-UPLOAD.1 — the receipt slot this route mints must be exactly the
// one POST /api/expenses/[id]/items will accept, so the contract test
// below (isExpenseReceiptPath on what we hand out) is the one that matters.
// Both sides read the same pure helpers in @/lib/fte-expenses.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', full_name: 'Fiona FTE' },
  claim: null,
  signError: null,
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => h.user) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.claim, error: null }) }) }),
    }),
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path) =>
          h.signError
            ? { data: null, error: { message: h.signError } }
            : { data: { path, token: `token-for-${path}` }, error: null },
      }),
    },
  }),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { isExpenseReceiptPath } from '@/lib/fte-expenses'

const CLAIM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const ctx = { params: { id: CLAIM_ID } }

function req(body) {
  return { headers: { get: () => 'application/json' }, json: async () => body }
}
const jpeg = (size = 2_000_000) => ({ file_name: 'IMG_0007.HEIC', size, mime: 'image/heic' })

beforeEach(() => {
  vi.clearAllMocks()
  h.signError = null
  h.claim = { id: CLAIM_ID, profile_id: h.user.id, status: 'draft' }
  getCurrentUser.mockResolvedValue(h.user)
})

describe('POST /api/expenses/[id]/upload-sign', () => {
  it('mints a slot at a path the items route will accept', async () => {
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slots).toHaveLength(1)
    expect(body.slots[0].token).toBe(`token-for-${body.slots[0].path}`)
    // The contract: what we hand out is what the finalise route honours.
    expect(isExpenseReceiptPath(body.slots[0].path, h.user.id, CLAIM_ID)).toBe(true)
    // ...and nobody else's.
    expect(isExpenseReceiptPath(body.slots[0].path, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CLAIM_ID)).toBe(false)
  })

  it('also takes the older `photos` key', async () => {
    const res = await POST(req({ photos: [jpeg()] }), ctx)
    expect(res.status).toBe(200)
  })

  it('refuses an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(401)
  })

  it('404s a claim that does not exist', async () => {
    h.claim = null
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(404)
  })

  it("refuses someone else's claim", async () => {
    h.claim = { id: CLAIM_ID, profile_id: 'someone-else', status: 'draft' }
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(403)
  })

  it('refuses a claim that has left draft', async () => {
    h.claim = { id: CLAIM_ID, profile_id: h.user.id, status: 'submitted' }
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(409)
  })

  it('takes exactly one receipt per item', async () => {
    expect((await POST(req({ files: [] }), ctx)).status).toBe(400)
    const two = await POST(req({ files: [jpeg(), jpeg()] }), ctx)
    expect(two.status).toBe(400)
    expect((await two.json()).code).toBe('one_receipt')
  })

  it('refuses a receipt over the 10 MB cap before the device wastes an upload', async () => {
    const res = await POST(req({ files: [{ file_name: 'big.pdf', size: 11 * 1024 * 1024, mime: 'application/pdf' }] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_too_large')
  })

  it('refuses a type the bucket does not take', async () => {
    const res = await POST(req({ files: [{ file_name: 'notes.docx', size: 1000, mime: 'application/msword' }] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_bad_type')
  })

  it('refuses an empty file', async () => {
    const res = await POST(req({ files: [{ file_name: 'x.pdf', size: 0, mime: 'application/pdf' }] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_empty')
  })

  it('refuses a body that is not JSON', async () => {
    const res = await POST({
      headers: { get: () => 'application/json' },
      json: async () => { throw new SyntaxError('bad json') },
    }, ctx)
    expect(res.status).toBe(400)
  })

  it('surfaces a storage failure as a 500', async () => {
    h.signError = 'bucket not found'
    const res = await POST(req({ files: [jpeg()] }), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/bucket not found/)
  })
})
