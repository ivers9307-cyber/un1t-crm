// Client-side upload helper for the landing-page editor.
//
// Fixes two failure modes of posting media straight to
// /api/landing-page-settings/media:
//
//   1. Vercel caps a serverless function's request body at ~4.5MB. A
//      larger upload is rejected at the platform edge with a PLAIN-TEXT
//      "Request Entity Too Large" (413) before the route runs — so the
//      route's own 5MB image / 25MB video limits are unreachable. We
//      downscale images in the browser to stay well under the cap (and
//      to keep the public page fast — a hero background is the largest
//      thing on first paint).
//
//   2. Callers used to do `await res.json()` unconditionally, so that
//      plain-text 413 threw `Unexpected token 'R'… is not valid JSON`.
//      parseUploadResponse() reads the body safely and turns a 413 /
//      non-JSON response into a clear message.
//
// Browser-only (uses <canvas>) — import from client components. The DOM
// APIs are referenced only inside functions, so SSR import is safe.

const UPLOAD_URL = '/api/landing-page-settings/media'

// Stay comfortably under Vercel's ~4.5MB body cap after multipart
// overhead. Images are re-encoded down in quality steps until under it.
const TARGET_MAX_BYTES = 3.8 * 1024 * 1024
const MAX_EDGE = 2560 // px on the long side — ample for a full-bleed hero

/**
 * Upload one media file for the landing page. Images are downscaled +
 * re-encoded client-side first. Returns { success, url?, error? } and
 * never throws on an oversized / non-JSON response.
 *
 * @param {{ file: File, locationId: string, kind?: 'image'|'video' }} args
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function uploadLandingMedia({ file, locationId, kind = 'image' }) {
  if (!file || !locationId) return { success: false, error: 'Missing file or location.' }

  let toSend = file
  if (kind !== 'video' && (file.type || '').startsWith('image/')) {
    try {
      toSend = await compressImageFile(file)
    } catch {
      // Canvas decode/encode failed (unusual format) — send the
      // original; the safe parse still gives a clean message if the
      // platform rejects it for size.
      toSend = file
    }
  }

  const fd = new FormData()
  fd.append('file', toSend, toSend.name || file.name || 'upload')
  fd.append('location_id', locationId)
  fd.append('kind', kind)

  let res
  try {
    res = await fetch(UPLOAD_URL, { method: 'POST', body: fd })
  } catch (e) {
    return { success: false, error: `Network error: ${e?.message || e}` }
  }
  return parseUploadResponse(res)
}

/**
 * Turn an upload Response into { success, url?, error? } without ever
 * throwing. Exported + browser-free so it's unit-tested directly: a
 * non-JSON body (Vercel's plain-text 413) becomes a friendly message
 * instead of a JSON parse crash.
 *
 * @param {Response} res
 */
export async function parseUploadResponse(res) {
  const contentType = res.headers?.get?.('content-type') || ''
  if (!contentType.includes('application/json')) {
    if (res.status === 413) {
      return {
        success: false,
        error: 'That file is too large to upload (the server caps a single request at ~4.5MB). Use a smaller image, or a shorter / lower-bitrate video.',
      }
    }
    let text = ''
    try { text = await res.text() } catch { /* ignore */ }
    const snippet = text.trim().slice(0, 140)
    return { success: false, error: snippet ? `Upload failed (${res.status}): ${snippet}` : `Upload failed (${res.status}).` }
  }
  let j
  try { j = await res.json() } catch { return { success: false, error: 'Upload failed — invalid server response.' } }
  if (!res.ok || j?.success === false) {
    return { success: false, error: j?.error || `Upload failed (${res.status}).` }
  }
  return { success: true, url: j.url }
}

// ── image compression (browser) ─────────────────────────────────────

async function compressImageFile(file) {
  const bitmap = await decode(file)
  const srcW = bitmap.width || bitmap.naturalWidth
  const srcH = bitmap.height || bitmap.naturalHeight
  const { width, height } = fit(srcW, srcH, MAX_EDGE)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, width, height)
  if (typeof bitmap.close === 'function') bitmap.close()

  // PNGs may carry transparency (logos) — try to preserve it, but if a
  // PNG won't fit, fall back to JPEG (opaque, far smaller).
  const preferPng = file.type === 'image/png'
  let blob = await toBlob(canvas, preferPng ? 'image/png' : 'image/jpeg', 0.85)

  if (blob && blob.size > TARGET_MAX_BYTES && !preferPng) {
    for (let q = 0.75; q >= 0.5 && blob.size > TARGET_MAX_BYTES; q -= 0.1) {
      blob = await toBlob(canvas, 'image/jpeg', q)
    }
  }
  if (blob && blob.size > TARGET_MAX_BYTES && preferPng) {
    blob = await toBlob(canvas, 'image/jpeg', 0.82)
  }
  if (!blob) return file

  const ext = blob.type === 'image/png' ? 'png' : 'jpg'
  const base = (file.name || 'image').replace(/\.[^.]+$/, '')
  return new File([blob], `${base}.${ext}`, { type: blob.type })
}

async function decode(file) {
  // createImageBitmap honours EXIF orientation with imageOrientation.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch { /* fall through to <img> */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

function fit(w, h, maxEdge) {
  if (!w || !h) return { width: maxEdge, height: maxEdge }
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}
