// /api/landing-page-settings/media/signed-upload — mint a one-shot
// Supabase Storage signed upload URL so the browser can PUT large
// media (hero background video) STRAIGHT to storage, bypassing the
// ~4.5MB Vercel serverless request-body cap that /media (which
// streams the bytes through the function) is bound by.
//
// Flow:
//   1. client POSTs { location_id, kind, content_type } here (tiny JSON)
//   2. we auth (master/owner + landing_page) and mint a signed upload
//      URL for a UUID-named path in the 'branding' bucket
//   3. client uploads the bytes directly via
//      supabase.storage.from('branding').uploadToSignedUrl(path, token, file)
//   4. client stores the returned public `url` in the block payload
//
// The bucket's own allowed_mime_types + file_size_limit (mig 248:
// + video/mp4 + video/webm, 26MB) are the real ceiling on the direct
// upload — we can't see the bytes here, so the bucket enforces size.
//
// Master OR owner at the location (same gate as /media).

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm' }
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export async function POST(request) {
  const user = await getCurrentUser()

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ success: false, error: 'Expected a JSON body.' }, { status: 400 })
  }
  const { location_id: locationId, kind, content_type: contentType } = body

  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
  }

  const isVideo = kind === 'video'
  const ext = (isVideo ? VIDEO_EXT : IMAGE_EXT)[contentType]
  if (!ext) {
    return NextResponse.json({
      success: false,
      error: isVideo ? 'Unsupported video type. Use MP4 or WebM.' : 'Unsupported file type. Use PNG, JPEG, or WebP.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const path = `landing-page/${locationId}/${randomUUID()}.${ext}`

  const { data, error } = await db.storage.from('branding').createSignedUploadUrl(path)
  if (error || !data?.token) {
    return NextResponse.json({ success: false, error: error?.message || 'Could not create upload URL.' }, { status: 400 })
  }

  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  return NextResponse.json({
    success: true,
    path: data.path,
    token: data.token,
    url: urlData.publicUrl,
  })
}
