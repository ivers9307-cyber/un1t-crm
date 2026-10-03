// WhatsApp template header-media validation (shared by the sign +
// upload-media routes and the WATemplateEditor client pre-check).
//
// Why this exists: template media must BYPASS Vercel — serverless
// request bodies are hard-capped at ~4.5 MB, so a 16 MB video posted
// as multipart dies with a platform-level 413 ("Request Entity Too
// Large") before any route code runs. The flow is therefore:
//
//   1. POST /api/whatsapp/templates/upload-media/sign  (tiny JSON)
//      → validates against LIMITS, mints a storage path + signed
//        upload token for the public 'whatsapp-templates' bucket.
//   2. Browser uploads the bytes DIRECTLY to Supabase Storage via
//      uploadToSignedUrl (no Vercel in the path).
//   3. POST /api/whatsapp/templates/upload-media (tiny JSON {path})
//      → downloads from storage, pushes through Meta's Resumable
//        Upload API for the approval header_handle.
//
// Limits match Meta's published caps (May 2026). Meta limits per file
// type, not per template category.

export const TEMPLATE_MEDIA_LIMITS = {
  IMAGE:    { mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024,   exts: ['.jpg', '.jpeg', '.png'] },
  VIDEO:    { mimes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * 1024 * 1024,  exts: ['.mp4', '.3gp'] },
  DOCUMENT: { mimes: ['application/pdf'],         maxBytes: 100 * 1024 * 1024, exts: ['.pdf'] },
}

/** Lowercased extension (with dot) from a file name, or '.bin'. */
export function mediaExt(fileName) {
  const m = String(fileName || '').match(/\.[a-z0-9]+$/i)
  return m ? m[0].toLowerCase() : '.bin'
}

/**
 * Validate a prospective template-media upload. Pure — runs identically
 * client-side (instant feedback) and server-side (the gate).
 *
 * @param {{ format?: string, mime?: string, size?: number, fileName?: string }} input
 * @returns {{ ok: true, format: string, ext: string } | { ok: false, error: string }}
 */
export function validateTemplateMedia({ format, mime, size, fileName } = {}) {
  const fmt = String(format || '').toUpperCase()
  const limits = TEMPLATE_MEDIA_LIMITS[fmt]
  if (!limits) {
    return { ok: false, error: 'format must be IMAGE, VIDEO, or DOCUMENT' }
  }
  if (!limits.mimes.includes(mime)) {
    return { ok: false, error: `${fmt} requires one of: ${limits.mimes.join(', ')}. Got: ${mime || 'unknown'}.` }
  }
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'File size missing or invalid.' }
  }
  if (n > limits.maxBytes) {
    const mb = (limits.maxBytes / 1024 / 1024).toFixed(0)
    return { ok: false, error: `${fmt} files must be ≤ ${mb} MB. This file is ${(n / 1024 / 1024).toFixed(1)} MB.` }
  }
  const ext = mediaExt(fileName)
  if (!limits.exts.includes(ext)) {
    return { ok: false, error: `${fmt} requires a ${limits.exts.join(' / ')} file. Got: ${ext}` }
  }
  return { ok: true, format: fmt, ext }
}

/**
 * A storage object path minted by the sign route:
 * `<location-uuid|global>/<uuid><ext>`. The upload-media route refuses
 * anything else so a caller can't point it at arbitrary bucket objects.
 */
export function isMintedMediaPath(path) {
  return /^[0-9a-fA-F-]{32,36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(String(path || '')) ||
    /^global\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(String(path || ''))
}

/**
 * WATPLRESUBMEDIA.1 — the header-media fields "Edit & resubmit" sends: all
 * three when the header is media and the uploaded file differs from what the
 * row stores, otherwise none (the route then leaves the stored media alone).
 *
 * @param {{ header_media_handle?: string|null, header_media_url?: string|null, header_media_path?: string|null } | null} saved
 * @param {{ handle?: string|null, url?: string|null, path?: string|null }} current
 * @param {string} headerFormat  'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'TEXT' | 'NONE' | …
 */
export function resubmitMediaFields(saved, current, headerFormat) {
  if (!TEMPLATE_MEDIA_LIMITS[String(headerFormat || '').toUpperCase()]) return {}
  const handle = current?.handle || null
  const url = current?.url || null
  const path = current?.path || null
  const same = handle === (saved?.header_media_handle || null) &&
    url === (saved?.header_media_url || null) &&
    path === (saved?.header_media_path || null)
  if (same) return {}
  return { header_media_handle: handle, header_media_url: url, header_media_path: path }
}

/**
 * WATPLRESUBMEDIA.1 — judge header media a resubmit wants to store, the way
 * the upload route judges an upload: a path the sign route minted, in the
 * template's own studio folder, a file of the header's type, and the URL the
 * 'whatsapp-templates' bucket serves for that path (`publicUrl`, from
 * getPublicUrl). null = acceptable, otherwise the operator-facing reason.
 * Plain words, no em-dashes.
 */
export function templateHeaderMediaError({ path, url, publicUrl, format, locationId } = {}) {
  const fmt = String(format || '').toUpperCase()
  const limits = TEMPLATE_MEDIA_LIMITS[fmt]
  if (!limits) return 'This template has no image, video or document header, so it takes no header media.'
  if (!isMintedMediaPath(path) || String(path).split('/')[0] !== String(locationId || '')) {
    return 'Invalid media path. Upload the header file again.'
  }
  if (!limits.exts.includes(mediaExt(path))) {
    return `${fmt} headers need a ${limits.exts.join(' / ')} file. Upload the header file again.`
  }
  if (!url || !publicUrl || url !== publicUrl) {
    return 'The header media link does not match its uploaded file. Upload the header file again.'
  }
  return null
}
