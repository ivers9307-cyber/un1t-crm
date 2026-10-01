// CARDOCUPLOAD.1 (C124) — the web picker's car-document upload (browser).
//
// DocumentsCard used to post the file multipart to
// POST /api/cars/[id]/documents and call a bare res.json(): Vercel refuses a
// body over ~4.5 MB with a plain-text 413 before the route runs, so a 5–25 MB
// scan threw `Unexpected token 'R'`, the spinner never cleared and no error
// showed. Now the bytes go straight to Storage (the rules and routes are in
// src/lib/car-document-upload.js):
//   1. POST …/documents/sign (JSON: name, size, type; the first bytes of an
//      unlabelled file) → { path, token, content_type }
//   2. storage.from('car-documents').uploadToSignedUrl(path, token, the file
//      as a Blob of content_type) — the browser client; the token is the
//      authority, the bucket has no client policy
//   3. POST …/documents/finalise (JSON) → the car_documents row
// Every response is read with readUploadJson, and uploadCarDocument never
// throws: it returns { success, data?, queue_warning?, error? }.
//
// DOM/browser APIs are only touched inside functions, so SSR import is safe.

import { isUnlabelledCarDocumentType } from './car-document-media'
import { checkCarDocumentSize, CAR_DOCUMENT_HEAD_BYTES } from './car-document-upload'

/**
 * Read an upload route's response without ever throwing: a non-JSON body
 * (Vercel's plain-text 413, an HTML error page) or a JSON failure becomes
 * { ok: false, error } in words a person can act on (parseUploadResponse's
 * rules, src/lib/landing-media-upload.js, keeping the body).
 *
 * @returns {Promise<{ ok: true, body: object } | { ok: false, error: string }>}
 */
export async function readUploadJson(res) {
  const contentType = res.headers?.get?.('content-type') || ''
  if (!contentType.includes('application/json')) {
    if (res.status === 413) {
      return { ok: false, error: 'That file is too large to upload in one request. Try again, or use a smaller file.' }
    }
    let text = ''
    try { text = await res.text() } catch { /* ignore */ }
    const snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
    return { ok: false, error: snippet ? `Upload failed (${res.status}): ${snippet}` : `Upload failed (${res.status}).` }
  }
  let body
  try { body = await res.json() } catch { return { ok: false, error: 'Upload failed — invalid server response.' } }
  if (!res.ok || body?.success === false) {
    return { ok: false, error: body?.error || `Upload failed (${res.status}).` }
  }
  return { ok: true, body }
}

async function postJson(fetchImpl, url, payload) {
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return { ok: false, error: `Network error: ${e?.message || e}` }
  }
  return readUploadJson(res)
}

async function headBase64(file) {
  try {
    const bytes = new Uint8Array(await file.slice(0, CAR_DOCUMENT_HEAD_BYTES).arrayBuffer())
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  } catch {
    return undefined // sign then refuses it as an unknown type, in words
  }
}

async function browserStorage() {
  const { createBrowserClient } = await import('./supabase')
  return createBrowserClient().storage
}

/**
 * Upload one car document. Never throws.
 *
 * @param {{ carId: string, docType: string, file: File, fetchImpl?: typeof fetch, storage?: object }} args
 *   fetchImpl / storage are for tests; the defaults are window.fetch and the
 *   browser Supabase client's storage.
 * @returns {Promise<{ success: true, data: object, queue_warning?: string } | { success: false, error: string }>}
 */
export async function uploadCarDocument({ carId, docType, file, fetchImpl, storage }) {
  try {
    if (!file) return { success: false, error: 'No file chosen.' }
    const sizeError = checkCarDocumentSize(file.size)
    if (sizeError) return { success: false, error: sizeError }
    const doFetch = fetchImpl || ((...a) => fetch(...a))
    const base = `/api/cars/${carId}/documents`
    const mime = file.type || ''

    // 1. The slot, and the type to upload as.
    const signBody = { doc_type: docType, file_name: file.name, mime, size: file.size }
    if (isUnlabelledCarDocumentType(mime)) signBody.head = await headBase64(file)
    const signed = await postJson(doFetch, `${base}/sign`, signBody)
    if (!signed.ok) return { success: false, error: signed.error }
    const { path, token, content_type: contentType } = signed.body
    if (!path || !token || !contentType) return { success: false, error: 'Upload failed — the server did not return an upload slot.' }

    // 2. The bytes, straight to Storage (no Vercel function in the path).
    // Re-typed as the canonical type: the bucket checks the Content-Type.
    try {
      const store = storage || await browserStorage()
      const blob = new Blob([file], { type: contentType })
      const { error } = await store.from('car-documents').uploadToSignedUrl(path, token, blob, { contentType })
      if (error) return { success: false, error: `Upload failed: ${error.message || error}` }
    } catch (e) {
      return { success: false, error: `Upload failed: ${e?.message || e}` }
    }

    // 3. Record it.
    const done = await postJson(doFetch, `${base}/finalise`, { doc_type: docType, path, file_name: file.name, mime })
    if (!done.ok) return { success: false, error: done.error }
    return { success: true, data: done.body.data, queue_warning: done.body.queue_warning }
  } catch (e) {
    return { success: false, error: `Upload failed: ${e?.message || e}` }
  }
}
