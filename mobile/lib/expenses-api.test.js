// MOBILE-UPLOAD.1 — addExpenseItem must always answer, never throw.
//
// The receipt used to ride as a multipart part; that stopped leaving the
// device at Expo SDK 57 (nothing has landed in the receipts bucket since
// 15 Jul) and the screen's "Add item" button kept spinning with nothing on
// screen to say why. The bytes now go device → Storage and the item POST
// carries the path.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer jwt' })),
  API_BASE: 'https://crm.repset.ie',
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { apiBaseUrl: 'https://crm.repset.ie' } } } }))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import { addExpenseItem, RECEIPT_BUCKET } from './expenses-api'

const CLAIM = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const PATH = `aaaa/${CLAIM}/dddd-ab12cd-receipt.pdf`
const PDF = { uri: 'file:///tmp/receipt.pdf', name: 'receipt.pdf', mimeType: 'application/pdf' }
const ITEM = {
  claimId: CLAIM,
  expenseDate: '2026-09-08',
  category: 'travel',
  amount: '42.55',
  vatAmount: '9.20',
  vendor: 'Iarnród Éireann',
  description: 'Return to Cork',
}

let uploadToSignedUrl

beforeEach(() => {
  vi.clearAllMocks()
  uploadToSignedUrl = vi.fn(async () => ({ data: { path: PATH }, error: null }))
  supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
  readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(51_200))
  global.fetch = vi.fn(async (url) =>
    String(url).endsWith('/upload-sign')
      ? { status: 200, json: async () => ({ success: true, slots: [{ path: PATH, token: 'tok' }] }) }
      : { status: 201, json: async () => ({ success: true, data: { id: 'item-1' } }) }
  )
})

describe('addExpenseItem', () => {
  it('uploads the receipt to storage, then posts the item with its path', async () => {
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r).toEqual({ success: true, data: { id: 'item-1' } })

    expect(global.fetch.mock.calls[0][0]).toBe(`https://crm.repset.ie/api/expenses/${CLAIM}/upload-sign`)
    expect(supabase.storage.from).toHaveBeenCalledWith(RECEIPT_BUCKET)
    expect(uploadToSignedUrl).toHaveBeenCalledWith(PATH, 'tok', expect.any(ArrayBuffer), { contentType: 'application/pdf' })

    const [url, init] = global.fetch.mock.calls[1]
    expect(url).toBe(`https://crm.repset.ie/api/expenses/${CLAIM}/items`)
    expect(JSON.parse(init.body)).toEqual({
      expense_date: '2026-09-08',
      category: 'travel',
      amount: 42.55,
      vat_amount: 9.2,
      vendor: 'Iarnród Éireann',
      description: 'Return to Cork',
      receipt: { path: PATH, file_name: 'receipt.pdf', size: 51_200, mime: 'application/pdf' },
    })
  })

  it('posts a receiptless item in one round-trip', async () => {
    const r = await addExpenseItem({ ...ITEM, receipt: null })
    expect(r.success).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).receipt).toBeNull()
  })

  it('resolves a camera photo\'s type from the picker, not the extension', async () => {
    await addExpenseItem({ ...ITEM, receipt: { uri: 'file:///a.heic', name: 'IMG_9.HEIC', mimeType: 'image/jpeg' } })
    expect(uploadToSignedUrl).toHaveBeenCalledWith(PATH, 'tok', expect.any(ArrayBuffer), { contentType: 'image/jpeg' })
  })

  it('answers an envelope when the network call rejects, rather than throwing', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Network request failed') })
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/network/i)
  })

  it('answers an envelope when the receipt cannot be read off the device', async () => {
    readFileAsArrayBuffer.mockRejectedValueOnce(new Error('ENOENT'))
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/could not read receipt/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('surfaces the sign refusal, and never creates the item behind it', async () => {
    global.fetch = vi.fn(async () => ({ status: 400, json: async () => ({ success: false, error: 'Receipt too large (max 10 MB).' }) }))
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r).toEqual({ success: false, error: 'Receipt too large (max 10 MB).' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('surfaces a storage failure', async () => {
    uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'signature expired' } })
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/signature expired/)
  })

  it('reports a non-JSON finalise response by status', async () => {
    global.fetch = vi.fn(async (url) =>
      String(url).endsWith('/upload-sign')
        ? { status: 200, json: async () => ({ success: true, slots: [{ path: PATH, token: 'tok' }] }) }
        : { status: 413, json: async () => { throw new SyntaxError('Unexpected token R') } }
    )
    const r = await addExpenseItem({ ...ITEM, receipt: PDF })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/413/)
  })
})
