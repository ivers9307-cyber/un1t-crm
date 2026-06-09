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

import { compressVideoIfNeeded } from './video-compress'

const UPLOAD_URL = '/api/landing-page-settings/media'

// Stay comfortably under Vercel's ~4.5MB body cap after multipart
// overhead. Images are re-encoded down in quality steps until under it.
const TARGET_MAX_BYTES = 3.8 * 1024 * 1024
const MAX_EDGE = 2560 // px on the long side — ample for a full-bleed hero

// Input cap: a browser-memory sanity guard checked BEFORE transcoding.
const MAX_VIDEO_INPUT_BYTES = 500 * 1024 * 1024 // 500MB
// Output ceiling: matches the branding bucket file_size_limit (mig 250: 50MB).
const MAX_VIDEO_OUTPUT_BYTES = 50 * 1024 * 1024 // 50MB

/**
 * Upload one media file for the landing page. Images are downscaled +
 * re-encoded client-side first. Returns { success, url?, error? } and
 * never throws on an oversized / non-JSON response.
 *
 * @param {{ file: File, locationId: string, kind?: 'image'|'video' }} args
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function uploadLandingMedia({ file, locationId, kind = 'image', onProgress }) {
  if (!file || !locationId) return { success: false, error: 'Missing file or location.' }

  // Video → compress (if needed) then upload straight to Supabase Storage.
  if (kind === 'video') return uploadVideoDirect({ file, locationId, onProgress })

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
 * Compress (if needed) then direct-upload a video to Supabase Storage via
 * a server-minted signed URL (so the ~4.5MB Vercel function body cap never
 * applies). Accepts any video/* input (e.g. .mov from an iPhone) and
 * transcodes non-MP4/WebM + oversized clips to a 720p MP4 before upload.
 * Returns { success, url?, error? }.
 */
async function uploadVideoDirect({ file, locationId, onProgress }) {
  if (!(file.type || '').startsWith('video/')) {
    return { success: false, error: 'Unsupported file. Please choose a video (MP4, WebM, or MOV).' }
  }
  if (file.size > MAX_VIDEO_INPUT_BYTES) {
    return { success: false, error: `That video is very large (${Math.round(file.size / 1024 / 1024)}MB). Trim it or export at 720p, then re-upload.` }
  }

  // Compress in-browser when needed (fail-open: returns the original on error).
  let toUpload
  try {
    toUpload = await compressVideoIfNeeded(file, { onProgress })
  } catch {
    toUpload = file
  }

  if (toUpload.size > MAX_VIDEO_OUTPUT_BYTES) {
    return { success: false, error: `Video is still too large (${Math.round(toUpload.size / 1024 / 1024)}MB) after compression. Please upload a shorter clip.` }
  }

  if (typeof onProgress === 'function') onProgress({ phase: 'upload', percent: 0 })

  // 1. Mint a signed upload URL (auth + path decided server-side).
  let r
  try {
    r = await fetch('/api/landing-page-settings/media/signed-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, kind: 'video', content_type: toUpload.type }),
    })
  } catch (e) {
    return { success: false, error: `Network error: ${e?.message || e}` }
  }
  let j
  try { j = await r.json() } catch { return { success: false, error: 'Upload failed — invalid server response.' } }
  if (!r.ok || j?.success === false || !j?.token) {
    return { success: false, error: j?.error || `Upload failed (${r.status}).` }
  }

  // 2. PUT the bytes straight to Supabase Storage (no function in the path).
  try {
    const { createBrowserClient } = await import('./supabase')
    const supabase = createBrowserClient()
    const { error } = await supabase.storage
      .from('branding')
      .uploadToSignedUrl(j.path, j.token, toUpload, { contentType: toUpload.type })
    if (error) return { success: false, error: `Video upload failed: ${error.message}` }
  } catch (e) {
    return { success: false, error: `Video upload failed: ${e?.message || e}` }
  }

  return { success: true, url: j.url }
}

/**
 * Capture the first frame of a LOCAL video File as a JPEG poster File.
 * Reads the blob via an object URL (no CORS — the file isn't uploaded
 * yet), seeks just past 0 to avoid an all-black opening frame, draws to
 * a canvas at the video's natural size, and exports a JPEG. Browser-only
 * (uses <video>/<canvas>). Resolves null on a non-video input or any
 * decode/seek/encode failure so the caller can save the clip with no
 * poster and degrade gracefully.
 *
 * @param {File|{type?:string}} file
 * @returns {Promise<File|null>}
 */
export async function captureVideoPoster(file) {
  if (!file || !(file.type || '').startsWith('video/')) return null
  if (typeof document === 'undefined') return null
  return new Promise((resolve) => {
    let url = null
    const video = document.createElement('video')
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { if (url) URL.revokeObjectURL(url) } catch { /* ignore */ }
      resolve(result)
    }
    try {
      url = URL.createObjectURL(file)
      video.muted = true
      video.playsInline = true
      // 'auto' (not 'metadata') so the first frame's pixels are actually
      // decoded — 'metadata' can leave loadeddata/seeked from firing on
      // some engines. It's a local blob, so this costs no network.
      video.preload = 'auto'
      video.onloadeddata = () => {
        try {
          const d = Number.isFinite(video.duration) ? video.duration : 1
          video.currentTime = Math.min(0.1, d / 2)
        } catch { finish(null) }
      }
      video.onseeked = () => {
        try {
          const w = video.videoWidth
          const h = video.videoHeight
          if (!w || !h) return finish(null)
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0, w, h)
          canvas.toBlob((blob) => {
            if (!blob) return finish(null)
            const base = (file.name || 'video').replace(/\.[^.]+$/, '')
            finish(new File([blob], `${base}-poster.jpg`, { type: 'image/jpeg' }))
          }, 'image/jpeg', 0.82)
        } catch { finish(null) }
      }
      video.onerror = () => finish(null)
      video.src = url
    } catch { finish(null) }
  })
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
