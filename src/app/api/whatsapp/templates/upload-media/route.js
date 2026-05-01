// POST /api/whatsapp/templates/upload-media
//
// Uploads a media asset destined for a WhatsApp template's IMAGE /
// VIDEO / DOCUMENT header. Two things happen in one round trip:
//
//   1. The file is stored in the public 'whatsapp-templates' bucket.
//      The returned URL is what we'll feed Meta at SEND time (the
//      messaging API fetches the asset from this URL).
//   2. The bytes are also pushed through Meta's Resumable Upload API
//      to obtain a 'header_handle'. This handle is what gets put into
//      components.example.header_handle when the template is submitted
//      for approval. Without it, Meta rejects media-header templates.
//
// Caller (WATemplateEditor) gets back { handle, url, path } and writes
// those into the form state; on save, the handle goes into the
// template payload and the URL gets persisted to whatsapp_templates
// for runtime use.
//
// Validation: type allowlist + size cap per format. Limits match
// Meta's published caps (May 2026):
//   IMAGE:    5 MB  — image/jpeg, image/png
//   VIDEO:   16 MB  — video/mp4, video/3gpp
//   DOCUMENT: 100 MB — application/pdf

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uploadMediaForTemplate } from '@/lib/whatsapp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LIMITS = {
  IMAGE:    { mimes: ['image/jpeg', 'image/png'],            maxBytes: 5  * 1024 * 1024,  exts: ['.jpg', '.jpeg', '.png'] },
  VIDEO:    { mimes: ['video/mp4', 'video/3gpp'],            maxBytes: 16 * 1024 * 1024,  exts: ['.mp4', '.3gp']           },
  DOCUMENT: { mimes: ['application/pdf'],                    maxBytes: 100 * 1024 * 1024, exts: ['.pdf']                    },
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ success: false, error: 'Expected multipart/form-data' }, { status: 400 })

  const file = form.get('file')
  const format = String(form.get('format') || '').toUpperCase()
  const locationId = form.get('location_id') || user.activeLocation?.id

  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 })
  }
  const limits = LIMITS[format]
  if (!limits) {
    return NextResponse.json({ success: false, error: 'format must be IMAGE, VIDEO, or DOCUMENT' }, { status: 400 })
  }
  if (!limits.mimes.includes(file.type)) {
    return NextResponse.json({
      success: false,
      error: `${format} requires one of: ${limits.mimes.join(', ')}. Got: ${file.type || 'unknown'}.`,
    }, { status: 400 })
  }
  if (file.size > limits.maxBytes) {
    const mb = (limits.maxBytes / 1024 / 1024).toFixed(0)
    return NextResponse.json({
      success: false,
      error: `${format} files must be ≤ ${mb} MB. This file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
    }, { status: 400 })
  }

  const guard = locationId ? assertLocationAccess(user, locationId) : null
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Read bytes once, use for both Storage upload and Meta upload.
  const bytes = Buffer.from(await file.arrayBuffer())

  // 1. Storage upload — UUID-based path so the public URL is
  //    effectively unguessable. Folder per location for cleanup.
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase()
  const storagePath = `${locationId || 'global'}/${randomUUID()}${ext}`
  const db = createServerClient()
  const { error: storageErr } = await db.storage
    .from('whatsapp-templates')
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    })
  if (storageErr) {
    return NextResponse.json({ success: false, error: `Storage upload failed: ${storageErr.message}` }, { status: 500 })
  }
  const { data: pub } = db.storage.from('whatsapp-templates').getPublicUrl(storagePath)
  const publicUrl = pub?.publicUrl

  // 2. Meta resumable upload → header handle for template approval.
  //    If this fails, we still return the storage URL so the operator
  //    isn't blocked from re-trying without re-uploading.
  let handle = null
  let metaError = null
  try {
    handle = await uploadMediaForTemplate(bytes, file.type)
  } catch (e) {
    metaError = e.message || String(e)
    console.warn(`[wa-template upload] Meta resumable upload failed: ${metaError}`)
  }

  return NextResponse.json({
    success: true,
    handle,
    url: publicUrl,
    path: storagePath,
    file_name: file.name,
    file_size: file.size,
    meta_error: metaError,  // present when handle is null — surface to UI for retry
  })
}
