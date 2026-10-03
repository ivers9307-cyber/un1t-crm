// CARDOCUPLOAD.1 (C124) — the web picker's car-document upload: sign →
// uploadToSignedUrl → finalise. The decisions pinned here are the row's bug:
// every response is parsed safely (a plain-text 413 or an HTML error page
// becomes a clear message, never a thrown `Unexpected token`), nothing
// throws, and the bytes never go through a Vercel function.
import { describe, it, expect, vi } from 'vitest'
import { uploadCarDocument, readUploadJson } from './car-document-upload-client.js'

const CAR = 'c0000000-0000-0000-0000-000000000001'
const MB = 1024 * 1024
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain' } })

function bigFile({ size = 12 * MB, type = 'application/pdf', name = 'scan.pdf', bytes = '%PDF-1.7' } = {}) {
  const f = new File([bytes], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function harness({ sign, upload, finalise } = {}) {
  const fetchImpl = vi.fn(async (url, init) => {
    if (url.endsWith('/sign')) return sign ? sign(JSON.parse(init.body)) : json(200, { success: true, path: `${CAR}/other/x.pdf`, token: 'tok', content_type: 'application/pdf' })
    if (url.endsWith('/finalise')) return finalise ? finalise(JSON.parse(init.body)) : json(201, { success: true, data: { id: 'd1', doc_type: 'other' } })
    throw new Error(`unexpected ${url}`)
  })
  const uploadToSignedUrl = vi.fn(upload || (async () => ({ data: { path: 'x' }, error: null })))
  const bucketFrom = vi.fn(() => ({ uploadToSignedUrl }))
  const storage = { from: bucketFrom }
  return { fetchImpl, storage, uploadToSignedUrl, bucketFrom }
}

describe('uploadCarDocument — the signed flow', () => {
  it('signs, uploads the bytes straight to car-documents, finalises, and returns the row', async () => {
    const h = harness()
    const file = bigFile()
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file, fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: true, data: { id: 'd1', doc_type: 'other' }, queue_warning: undefined })

    const [signUrl, signInit] = h.fetchImpl.mock.calls[0]
    expect(signUrl).toBe(`/api/cars/${CAR}/documents/sign`)
    expect(JSON.parse(signInit.body)).toEqual({ doc_type: 'other', file_name: 'scan.pdf', mime: 'application/pdf', size: 12 * MB })

    expect(h.bucketFrom).toHaveBeenCalledWith('car-documents')
    const [path, token, body, opts] = h.uploadToSignedUrl.mock.calls[0]
    expect([path, token]).toEqual([`${CAR}/other/x.pdf`, 'tok'])
    expect(body).toBeInstanceOf(Blob)
    expect(body.type).toBe('application/pdf')
    expect(opts).toEqual({ contentType: 'application/pdf' })

    const [finUrl, finInit] = h.fetchImpl.mock.calls[1]
    expect(finUrl).toBe(`/api/cars/${CAR}/documents/finalise`)
    expect(JSON.parse(finInit.body)).toEqual({ doc_type: 'other', path: `${CAR}/other/x.pdf`, file_name: 'scan.pdf', mime: 'application/pdf' })
    // No request carried the file: only JSON went to our routes.
    for (const [, init] of h.fetchImpl.mock.calls) expect(typeof init.body).toBe('string')
  })

  it('uploads under the type sign decided, not the file\'s own (an alias or an unlabelled file)', async () => {
    const h = harness({ sign: () => json(200, { success: true, path: 'p', token: 't', content_type: 'image/jpeg' }) })
    await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile({ type: 'image/jpg', name: 'a.jpg' }), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(h.uploadToSignedUrl.mock.calls[0][2].type).toBe('image/jpeg')
    expect(h.uploadToSignedUrl.mock.calls[0][3]).toEqual({ contentType: 'image/jpeg' })
  })

  it('sends the first bytes of an unlabelled file so sign can judge it, and only then', async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic')])
    const h = harness()
    await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile({ type: '', name: 'IMG.HEIC', bytes: heic }), fetchImpl: h.fetchImpl, storage: h.storage })
    const sent = JSON.parse(h.fetchImpl.mock.calls[0][1].body)
    expect(sent.mime).toBe('')
    expect(Buffer.from(sent.head, 'base64').equals(heic)).toBe(true)

    const h2 = harness()
    await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h2.fetchImpl, storage: h2.storage })
    expect(JSON.parse(h2.fetchImpl.mock.calls[0][1].body).head).toBeUndefined()
  })

  it('passes a queue warning through', async () => {
    const h = harness({ finalise: () => json(201, { success: true, data: { id: 'd1' }, queue_warning: 'queue down' }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: true, data: { id: 'd1' }, queue_warning: 'queue down' })
  })
})

describe('uploadCarDocument — every failure is a clear message, never a throw', () => {
  it('refuses a file over 25 MiB before any request', async () => {
    const h = harness()
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile({ size: 25 * MB + 1 }), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'File too large (max 25 MB)' })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it("shows sign's refusal", async () => {
    const h = harness({ sign: () => json(400, { success: false, error: 'Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)' }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)' })
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it("turns Vercel's plain-text 413 into words (main threw Unexpected token 'R')", async () => {
    const h = harness({ sign: () => text(413, 'Request Entity Too Large') })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/too large/i)
  })

  it('turns an HTML error page into a status and a snippet', async () => {
    const h = harness({ finalise: () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r.success).toBe(false)
    expect(r.error).toContain('502')
  })

  it('reports a network failure on sign', async () => {
    const h = harness()
    h.fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'Network error: Failed to fetch' })
  })

  it('reports a Storage refusal and never finalises', async () => {
    const h = harness({ upload: async () => ({ data: null, error: { message: 'The object exceeded the maximum allowed size' } }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'Upload failed: The object exceeded the maximum allowed size' })
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports a thrown Storage upload', async () => {
    const h = harness({ upload: async () => { throw new Error('socket hang up') } })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'Upload failed: socket hang up' })
  })

  it("shows finalise's refusal", async () => {
    const h = harness({ finalise: () => json(400, { success: false, error: 'The file did not finish uploading. Try again.' }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r).toEqual({ success: false, error: 'The file did not finish uploading. Try again.' })
  })

  it('treats a 2xx sign without a token as a failure', async () => {
    const h = harness({ sign: () => json(200, { success: true }) })
    const r = await uploadCarDocument({ carId: CAR, docType: 'other', file: bigFile(), fetchImpl: h.fetchImpl, storage: h.storage })
    expect(r.success).toBe(false)
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled()
  })

  it('refuses a missing file', async () => {
    const h = harness()
    expect(await uploadCarDocument({ carId: CAR, docType: 'other', file: null, fetchImpl: h.fetchImpl, storage: h.storage }))
      .toEqual({ success: false, error: 'No file chosen.' })
  })
})

describe('readUploadJson', () => {
  it('reads a JSON success', async () => {
    expect(await readUploadJson(json(200, { success: true, a: 1 }))).toEqual({ ok: true, body: { success: true, a: 1 } })
  })
  it('reads JSON that is not JSON', async () => {
    const r = await readUploadJson(new Response('{nope', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/invalid server response/i)
  })
  it('reads success:false on a 200 as a failure', async () => {
    expect(await readUploadJson(json(200, { success: false, error: 'nope' }))).toEqual({ ok: false, error: 'nope' })
  })
  it('names the status when the error has no words', async () => {
    expect(await readUploadJson(json(500, {}))).toEqual({ ok: false, error: 'Upload failed (500).' })
  })
})
