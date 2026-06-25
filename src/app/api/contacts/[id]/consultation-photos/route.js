// POST /api/contacts/[id]/consultation-photos — upload a progress photo for a contact.
//
// CONSULTATIONS SP1 — progress-photo upload API.
//
// Authorization: session auth + consultations permission.
// [id] is the contact the photo belongs to.
// Photos are stored in the private 'consultation-photos' Supabase Storage bucket.

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'

const MAX_BYTES = 10 * 1024 * 1024  // 10 MB

// Derive a file extension from a MIME type or filename.
// Returns 'jpg' as the fallback for unknown image/* types.
function deriveExt(mimeType, filename) {
  const EXT_BY_MIME = {
    'image/jpeg': 'jpg',
    'image/jpg':  'jpg',
    'image/png':  'png',
    'image/gif':  'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/bmp':  'bmp',
  }
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType]
  // Fall back to extracting from the filename
  if (filename && filename.includes('.')) {
    const parts = filename.split('.')
    const ext = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ext) return ext
  }
  return 'jpg'
}

// ============================================================
// POST /api/contacts/[id]/consultation-photos — upload a photo
// ============================================================
export async function POST(request, props) {
  const params = await props.params
  const { id: contactId } = params

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'consultations')) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .single()

  if (contactErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  // Parse multipart form data
  const formData = await request.formData()
  const file = formData.get('file')
  const label           = formData.get('label')   ? String(formData.get('label'))   : null
  const caption         = formData.get('caption') ? String(formData.get('caption')) : null
  const consultation_id = formData.get('consultation_id') ? String(formData.get('consultation_id')) : null
  const taken_at        = formData.get('taken_at')        ? String(formData.get('taken_at'))        : undefined

  // Validate file presence
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'No file uploaded' }, { status: 400 })
  }

  // Validate MIME type — must be an image
  if (!file.type || !file.type.startsWith('image/')) {
    return NextResponse.json({ success: false, error: 'File must be an image' }, { status: 400 })
  }

  // Validate file size
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)`,
    }, { status: 400 })
  }

  // Build the storage path
  const ext  = deriveExt(file.type, file.name)
  const path = `consultations/${contactId}/${randomUUID()}.${ext}`

  // Upload to Supabase Storage
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadErr } = await db.storage
    .from('consultation-photos')
    .upload(path, buffer, { contentType: file.type })

  if (uploadErr) {
    return NextResponse.json(
      { success: false, error: `Upload failed: ${uploadErr.message}` },
      { status: 400 }
    )
  }

  // Insert the DB row
  const insertPayload = {
    contact_id:      contactId,
    location_id:     contact.location_id,
    consultation_id: consultation_id || null,
    storage_path:    path,
    label,
    caption,
    created_by: user.id,
  }
  if (taken_at !== undefined) {
    insertPayload.taken_at = taken_at
  }

  const { data: row, error: insertErr } = await db
    .from('consultation_photos')
    .insert(insertPayload)
    .select()
    .single()

  if (insertErr) {
    // Roll back the storage upload to avoid orphaned files
    try {
      await db.storage.from('consultation-photos').remove([path])
    } catch {
      // swallow — storage cleanup failure must not mask the real error
    }
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  }

  // Attach a short-lived signed URL to the response (600s = 10 min)
  let signedUrl = null
  try {
    const { data: signed } = await db.storage
      .from('consultation-photos')
      .createSignedUrl(path, 600)
    signedUrl = signed?.signedUrl ?? null
  } catch {
    // swallow — missing signed URL is non-fatal
  }

  return NextResponse.json({ success: true, data: { ...row, signed_url: signedUrl } })
}
