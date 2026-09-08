// MOBILE-UPLOAD.1 — route tests for adding an expense item.
//
// The JSON path is the one the phone now takes: the receipt bytes are
// already in the bucket (uploaded against a slot from
// /api/expenses/[id]/upload-sign) and the body carries the path. The
// load-bearing assertions are that a path is proved to be THIS claimant's
// slot, that the stored object's own size and type are what get written,
// and that a bad receipt creates NO row at all. The multipart path is kept
// for the browser and for phone bundles that predate the OTA.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', full_name: 'Fiona FTE' },
  claim: null,
  claimedReceipts: [],
  listed: [],
  inserted: [],
  removed: [],
  uploaded: [],
  uploadError: null,
}))

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => h.user) }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table === 'fte_expense_claims') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.claim, error: null }) }) }) }
      }
      return {
        // the "is this receipt already used" lookup
        select: () => ({ eq: () => ({ limit: async () => ({ data: h.claimedReceipts, error: null }) }) }),
        insert: (row) => {
          h.inserted.push(row)
          return { select: () => ({ single: async () => ({ data: { id: 'item-1', ...row }, error: null }) }) }
        },
        update: (patch) => ({
          eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'item-1', ...patch }, error: null }) }) }),
        }),
      }
    },
    storage: {
      from: () => ({
        list: async () => ({ data: h.listed, error: null }),
        remove: async (paths) => { h.removed.push(...paths); return { data: null, error: null } },
        upload: async (path) => {
          h.uploaded.push(path)
          return h.uploadError ? { error: { message: h.uploadError } } : { error: null }
        },
      }),
    },
  }),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { isExpenseReceiptPath } from '@/lib/fte-expenses'

const CLAIM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const DRAFT_ITEM = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const RECEIPT_PATH = `${h.user.id}/${CLAIM_ID}/${DRAFT_ITEM}-ab12cd-IMG_0007.jpg`
const ctx = { params: { id: CLAIM_ID } }

const FIELDS = {
  expense_date: '2026-09-08',
  category: 'travel',
  amount: 42.555,
  vat_amount: 9.2,
  vendor: 'Iarnród Éireann',
  description: 'Return to Cork',
}

function jsonReq(body) {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  }
}
function formReq(fields, file) {
  const map = { ...fields, receipt: file ?? null }
  return {
    headers: { get: () => null },
    formData: async () => ({ get: (k) => (k in map ? map[k] : null) }),
  }
}
const stored = (size = 4096, mimetype = 'image/jpeg') => ([
  { name: `${DRAFT_ITEM}-ab12cd-IMG_0007.jpg`, metadata: { size, mimetype } },
])
const receiptRef = (over = {}) => ({
  path: RECEIPT_PATH, file_name: 'IMG_0007.jpg', size: 4096, mime: 'image/jpeg', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.claim = { id: CLAIM_ID, profile_id: h.user.id, status: 'draft' }
  h.claimedReceipts = []
  h.listed = stored()
  h.inserted = []
  h.removed = []
  h.uploaded = []
  h.uploadError = null
  getCurrentUser.mockResolvedValue(h.user)
})

describe('POST /api/expenses/[id]/items — JSON mode (direct-to-storage receipt)', () => {
  it('is the path the sign route mints', () => {
    // Guards the fixture itself: if buildReceiptPath's shape ever changes,
    // every assertion below would be testing a path nobody issues.
    expect(isExpenseReceiptPath(RECEIPT_PATH, h.user.id, CLAIM_ID)).toBe(true)
  })

  it('inserts the row complete, with the size + type STORAGE reports', async () => {
    h.listed = stored(51_200, 'image/png')
    const res = await POST(jsonReq({
      ...FIELDS,
      // A client is free to lie about size and type; nothing may read these.
      receipt: receiptRef({ size: 1, mime: 'application/pdf' }),
    }), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]).toMatchObject({
      claim_id: CLAIM_ID,
      amount: 42.56,          // rounded to 2dp
      vat_amount: 9.2,
      receipt_path: RECEIPT_PATH,
      receipt_size_bytes: 51_200,
      receipt_mime_type: 'image/png',
    })
  })

  it('accepts an item with no receipt at all', async () => {
    const res = await POST(jsonReq({ ...FIELDS, receipt: null }), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted[0].receipt_path).toBeUndefined()
  })

  it("refuses a path from someone else's claim, and creates no row", async () => {
    const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const res = await POST(jsonReq({
      ...FIELDS,
      receipt: receiptRef({ path: `${other}/${CLAIM_ID}/${DRAFT_ITEM}-ab12cd-IMG_0007.jpg` }),
    }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_bad_path')
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses a path that is not an upload slot at all', async () => {
    const res = await POST(jsonReq({
      ...FIELDS,
      receipt: receiptRef({ path: `${h.user.id}/${CLAIM_ID}/../../secrets.pdf` }),
    }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_bad_path')
  })

  it('refuses a receipt another item already owns', async () => {
    h.claimedReceipts = [{ id: 'item-9' }]
    const res = await POST(jsonReq({ ...FIELDS, receipt: receiptRef() }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_already_used')
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses an object that never arrived in the bucket', async () => {
    h.listed = []
    const res = await POST(jsonReq({ ...FIELDS, receipt: receiptRef() }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_missing')
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses an oversized object even when the client declared it small, and drops it', async () => {
    h.listed = stored(11 * 1024 * 1024)
    const res = await POST(jsonReq({ ...FIELDS, receipt: receiptRef({ size: 2048 }) }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_too_large')
    expect(h.removed).toEqual([RECEIPT_PATH])
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses a stored object whose real type is not accepted', async () => {
    h.listed = stored(4096, 'application/x-msdownload')
    const res = await POST(jsonReq({ ...FIELDS, receipt: receiptRef() }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('receipt_bad_type')
    expect(h.removed).toEqual([RECEIPT_PATH])
  })

  it('still applies the field rules', async () => {
    expect((await POST(jsonReq({ ...FIELDS, expense_date: '08/09/2026' }), ctx)).status).toBe(400)
    expect((await POST(jsonReq({ ...FIELDS, category: 'bribes' }), ctx)).status).toBe(400)
    expect((await POST(jsonReq({ ...FIELDS, amount: 0 }), ctx)).status).toBe(400)
    expect((await POST(jsonReq({ ...FIELDS, vat_amount: 99 }), ctx)).status).toBe(400)
    expect(h.inserted).toHaveLength(0)
  })

  it('keeps the claim gates', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(jsonReq({ ...FIELDS }), ctx)).status).toBe(401)
    getCurrentUser.mockResolvedValue(h.user)

    h.claim = null
    expect((await POST(jsonReq({ ...FIELDS }), ctx)).status).toBe(404)

    h.claim = { id: CLAIM_ID, profile_id: 'someone-else', status: 'draft' }
    expect((await POST(jsonReq({ ...FIELDS }), ctx)).status).toBe(403)

    h.claim = { id: CLAIM_ID, profile_id: h.user.id, status: 'submitted' }
    expect((await POST(jsonReq({ ...FIELDS }), ctx)).status).toBe(409)
  })
})

describe('POST /api/expenses/[id]/items — multipart mode still works', () => {
  const file = { size: 2048, type: 'image/jpeg', name: 'receipt.jpg', arrayBuffer: async () => new ArrayBuffer(2048) }

  it('inserts, uploads the inline bytes, then patches the row', async () => {
    const res = await POST(formReq({
      expense_date: FIELDS.expense_date,
      category: FIELDS.category,
      amount: String(FIELDS.amount),
      vat_amount: String(FIELDS.vat_amount),
    }, file), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0].receipt_path).toBeUndefined()  // path needs the row id
    expect(h.uploaded).toHaveLength(1)
    expect((await res.json()).data.receipt_path).toBe(h.uploaded[0])
  })

  it('reports the created row id when the inline upload fails', async () => {
    h.uploadError = 'network'
    const res = await POST(formReq({
      expense_date: FIELDS.expense_date,
      category: FIELDS.category,
      amount: String(FIELDS.amount),
    }, file), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).item_id).toBe('item-1')
  })
})
