// MOBILE-UPLOAD.1 — the shared direct-to-storage upload flow.
//
// This module exists because a multipart `{ uri, name, type }` FormData
// part stopped leaving the device at Expo SDK 57, silently, in three
// features at once. Its contract is therefore narrow and absolute: it
// NEVER throws past its callers' expectations, it never uploads bytes it
// could not read, and it never hangs — a stalled request is what turned
// the original defect into a spinner nobody could clear.
//
// `./api`, `./supabase` and `./upload-bytes` are mocked BEFORE import:
// they pull the React-Native runtime, which must never load under
// vitest's Node environment (see vitest.config.js).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer jwt' })),
  API_BASE: 'https://crm.repset.ie',
}))
vi.mock('./supabase', () => ({ supabase: { storage: { from: vi.fn() } } }))
vi.mock('./upload-bytes', () => ({ readFileAsArrayBuffer: vi.fn() }))

import { authHeaders } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import {
  mimeResolver, readPickedFiles, resolvePhotoMime, uploadToSlots, withTimeout,
} from './upload-slots'

const PATH = 'loc/draft/att-photo.jpg'
let uploadToSignedUrl

beforeEach(() => {
  vi.clearAllMocks()
  uploadToSignedUrl = vi.fn(async () => ({ data: { path: PATH }, error: null }))
  supabase.storage.from.mockReturnValue({ uploadToSignedUrl })
  readFileAsArrayBuffer.mockResolvedValue(new ArrayBuffer(1024))
  global.fetch = vi.fn(async () => ({
    status: 200,
    json: async () => ({ success: true, slots: [{ path: PATH, token: 'tok' }] }),
  }))
})

describe('mimeResolver / resolvePhotoMime', () => {
  it('trusts the picker over the filename — an iPhone reports .HEIC on a re-encoded JPEG', () => {
    expect(resolvePhotoMime('IMG_1.HEIC', 'image/jpeg')).toBe('image/jpeg')
  })

  it('falls back to the extension, then to the default', () => {
    expect(resolvePhotoMime('IMG_1.HEIC', null)).toBe('image/heic')
    expect(resolvePhotoMime('scan', null)).toBe('image/jpeg')
  })

  it('builds a resolver for other surfaces (a receipt may be a PDF)', () => {
    const receipt = mimeResolver({ pdf: 'application/pdf' }, 'image/jpeg')
    expect(receipt('invoice.PDF', null)).toBe('application/pdf')
    expect(receipt('snap.xyz', null)).toBe('image/jpeg')
  })
})

describe('readPickedFiles', () => {
  it('reads each asset to an ArrayBuffer of its real bytes', async () => {
    const r = await readPickedFiles([{ uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' }], {
      resolveMime: resolvePhotoMime, label: 'photo',
    })
    expect(r.ok).toBe(true)
    expect(r.files[0]).toMatchObject({ name: 'a.jpg', mime: 'image/jpeg' })
    expect(r.files[0].bytes.byteLength).toBe(1024)
  })

  it('answers an envelope when the file cannot be read off the device', async () => {
    readFileAsArrayBuffer.mockRejectedValueOnce(new Error('ENOENT'))
    const r = await readPickedFiles([{ uri: 'file:///gone.jpg' }], { label: 'photo' })
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/could not read photo 1/i) })
  })

  it('answers an envelope when the file reads back empty — never upload 0 bytes', async () => {
    readFileAsArrayBuffer.mockResolvedValueOnce(new ArrayBuffer(0))
    const r = await readPickedFiles([{ uri: 'file:///empty.jpg' }], { label: 'receipt' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/empty/i)
  })

  it('reads nothing for an empty pick', async () => {
    expect(await readPickedFiles([], {})).toEqual({ ok: true, files: [] })
    expect(readFileAsArrayBuffer).not.toHaveBeenCalled()
  })
})

describe('uploadToSlots', () => {
  const files = [{ name: 'a.jpg', mime: 'image/jpeg', bytes: new ArrayBuffer(1024) }]

  it('signs, uploads the bytes, and returns descriptors for the finalise call', async () => {
    const r = await uploadToSlots({ signUrl: '/api/issues/upload-sign', bucket: 'issue-photos', files, locationId: 'loc-1' })
    expect(r.ok).toBe(true)
    expect(r.uploaded).toEqual([{ path: PATH, file_name: 'a.jpg', size: 1024, mime: 'image/jpeg' }])

    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('https://crm.repset.ie/api/issues/upload-sign')
    expect(JSON.parse(init.body)).toEqual({ files: [{ file_name: 'a.jpg', size: 1024, mime: 'image/jpeg' }] })
    expect(authHeaders).toHaveBeenCalledWith({ locationId: 'loc-1', json: true })

    expect(supabase.storage.from).toHaveBeenCalledWith('issue-photos')
    expect(uploadToSignedUrl).toHaveBeenCalledWith(PATH, 'tok', files[0].bytes, { contentType: 'image/jpeg' })
  })

  it('does nothing at all when there is nothing to upload', async () => {
    const r = await uploadToSlots({ signUrl: '/x', bucket: 'b', files: [] })
    expect(r).toEqual({ ok: true, uploaded: [] })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('surfaces the server refusal from the sign step', async () => {
    global.fetch = vi.fn(async () => ({ status: 400, json: async () => ({ success: false, error: 'Receipt too large (max 10 MB).' }) }))
    const r = await uploadToSlots({ signUrl: '/x', bucket: 'b', files })
    expect(r).toEqual({ ok: false, error: 'Receipt too large (max 10 MB).' })
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('reports a non-JSON sign response by status rather than throwing', async () => {
    global.fetch = vi.fn(async () => ({ status: 413, json: async () => { throw new SyntaxError('Unexpected token R') } }))
    const r = await uploadToSlots({ signUrl: '/x', bucket: 'b', files })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/413/)
  })

  it('refuses to upload when the server hands back fewer slots than files', async () => {
    global.fetch = vi.fn(async () => ({ status: 200, json: async () => ({ success: true, slots: [{ path: PATH, token: 'tok' }] }) }))
    const r = await uploadToSlots({
      signUrl: '/x', bucket: 'b',
      files: [...files, { name: 'b.jpg', mime: 'image/jpeg', bytes: new ArrayBuffer(10) }],
    })
    expect(r.ok).toBe(false)
    expect(uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('surfaces a storage error', async () => {
    uploadToSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'signature expired' } })
    const r = await uploadToSlots({ signUrl: '/x', bucket: 'b', files })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/signature expired/)
  })
})

describe('withTimeout', () => {
  it('gives up on a request that never settles, instead of hanging forever', async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise(() => {}), 'Uploading photo 1')
      const settled = expect(pending).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(60_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a value straight through and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve('done'), 'x')).resolves.toBe('done')
  })
})
