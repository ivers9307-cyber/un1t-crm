// POST /api/me/signature-photo — the caller's OWN signature headshot.
//
// MAIL-SIG.1 — the one write path a signature photo has. Lands in the public
// 'branding' bucket (the SAAS-7 decision holds: everything here is public by
// nature, and a signature photo is destined for outbound email where the
// recipient's client fetches it anonymously) under signatures/{profile.id}/,
// so a caller can only ever write their OWN slot — no id parameter exists.
// The returned public URL is what /api/me/preferences accepts as photo_url
// (it validates the prefix, so a URL from anywhere else is refused at save).
//
// JPEG/PNG/WebP only and 2MB max: this is a headshot, not a media library.
// Upsert on a fixed name per person, so re-uploading replaces rather than
// accumulating billed objects; the cache-bust query keeps old sent emails
// pointing at the version that existed when they were sent... it does NOT —
// upsert changes the bytes behind historical URLs too. Accepted: it is the
// sender's own face, and replacing it everywhere is what updating a headshot
// means.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_BYTES = 2 * 1024 * 1024

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const formData = await request.formData()
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }
  const ext = ALLOWED[file.type]
  if (!ext) {
    return NextResponse.json({ success: false, error: 'Photo must be JPEG, PNG or WebP' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ success: false, error: 'Photo must be under 2MB' }, { status: 400 })
  }

  const db = createServerClient()
  const filePath = `signatures/${user.id}/photo.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  // Audit MAIL-SIG.1 #2 — file.type is client-asserted: sniff the magic
  // bytes so arbitrary payloads can't be parked on our public host wearing
  // an image content-type.
  const sniffOk =
    (file.type === 'image/jpeg' && buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) ||
    (file.type === 'image/png' && buffer.length > 8 && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) ||
    (file.type === 'image/webp' && buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
  if (!sniffOk) {
    return NextResponse.json({ success: false, error: 'That file does not look like a JPEG, PNG or WebP image' }, { status: 400 })
  }
  const { error: uploadError } = await db.storage
    .from('branding')
    .upload(filePath, buffer, { contentType: file.type, upsert: true })
  if (uploadError) {
    console.error('[me/signature-photo] upload failed:', uploadError.message)
    return NextResponse.json({ success: false, error: 'Upload failed — try again' }, { status: 500 })
  }

  const { data: urlData } = db.storage.from('branding').getPublicUrl(filePath)
  return NextResponse.json({ success: true, url: `${urlData.publicUrl}?t=${Date.now()}` })
}
