// POST /api/whatsapp/templates/upload-media
//
// Step 2 of the template-media upload flow. The browser has ALREADY
// uploaded the bytes directly to the public 'whatsapp-templates' bucket
// via the signed URL from ./sign (step 1) — this route receives only a
// small JSON pointer, downloads the object server-side, and pushes the
// bytes through Meta's Resumable Upload API to obtain the
// 'header_handle' required for template approval.
//
// WHY the two-step shape: the previous version received the file as
// multipart through this route, but Vercel hard-caps serverless request
// bodies at ~4.5 MB — every real VIDEO (Meta cap 16 MB) and most
// DOCUMENTs died with a platform-level 413 ("Request Entity Too
// Large"), which the client's res.json() rendered as the cryptic
// `Unexpected token 'R'`. Bytes must never transit Vercel. See
// src/lib/template-media.js for the full flow + shared limits.
//
// Caller (WATemplateEditor) gets back { handle, url, path } and writes
// those into the form state; on save, the handle goes into the
// template payload and the URL gets persisted to whatsapp_templates
// for runtime use. If the Meta push fails we still return the storage
// URL so the operator can retry without re-uploading.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateTemplateMedia, isMintedMediaPath } from '@/lib/template-media'
import { uploadMediaForTemplate } from '@/lib/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A 16 MB video (or larger document) can take a while to round-trip
// through Meta's resumable upload — give the route headroom.
export const maxDuration = 300

const FinaliseSchema = z.object({
  path: z.string().min(1).max(300),
  format: z.string().min(1),
  mime: z.string().min(1),
  file_name: z.string().min(1).max(300),
  location_id: uuidLike.optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Stale-tab guard: the pre-fix client posted the file itself as
  // multipart. Give those tabs a clear instruction instead of a Zod error.
  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    return NextResponse.json({
      success: false,
      error: 'The uploader changed — refresh the page and try the upload again.',
    }, { status: 400 })
  }

  const validation = await validateBody(request, FinaliseSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const locationId = body.location_id || user.activeLocation?.id
  const guard = locationId ? assertLocationAccess(user, locationId) : null
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Only paths minted by ./sign are accepted, and only within this
  // caller's own folder (or 'global') — no pointing at other objects.
  if (!isMintedMediaPath(body.path)) {
    return NextResponse.json({ success: false, error: 'Invalid media path' }, { status: 400 })
  }
  const folder = body.path.split('/')[0]
  if (folder !== 'global' && folder !== String(locationId)) {
    return NextResponse.json({ success: false, error: 'Invalid media path' }, { status: 400 })
  }

  const db = createServerClient()

  // Pull the bytes the browser placed in storage. A missing object means
  // the direct upload didn't complete — tell the operator to retry.
  const { data: blob, error: dlErr } = await db.storage
    .from('whatsapp-templates')
    .download(body.path)
  if (dlErr || !blob) {
    return NextResponse.json({
      success: false,
      error: `Uploaded file not found in storage (${dlErr?.message || 'empty'}) — try the upload again.`,
    }, { status: 404 })
  }
  const bytes = Buffer.from(await blob.arrayBuffer())

  // Re-validate server-side now that we can see the real size — the
  // signed-URL upload bypassed this route, so this is the actual gate.
  const check = validateTemplateMedia({
    format: body.format,
    mime: body.mime,
    size: bytes.length,
    fileName: body.file_name,
  })
  if (!check.ok) {
    // Remove the over-limit/wrong-type object so the public bucket
    // doesn't accumulate unusable files. Best-effort (builders are
    // thenables with no .catch — use the two-arg .then form).
    await db.storage.from('whatsapp-templates').remove([body.path]).then(() => {}, () => {})
    return NextResponse.json({ success: false, error: check.error }, { status: 400 })
  }

  const { data: pub } = db.storage.from('whatsapp-templates').getPublicUrl(body.path)
  const publicUrl = pub?.publicUrl

  // Meta resumable upload → header handle for template approval.
  let handle = null
  let metaError = null
  try {
    handle = await uploadMediaForTemplate(bytes, body.mime)
  } catch (e) {
    metaError = e.message || String(e)
    console.warn(`[wa-template upload] Meta resumable upload failed: ${metaError}`)
  }

  return NextResponse.json({
    success: true,
    handle,
    url: publicUrl,
    path: body.path,
    file_name: body.file_name,
    file_size: bytes.length,
    meta_error: metaError,  // present when handle is null — surface to UI for retry
  })
}
