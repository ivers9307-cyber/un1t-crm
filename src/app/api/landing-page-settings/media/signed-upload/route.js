// /api/landing-page-settings/media/signed-upload — mint a one-shot
// Supabase Storage signed upload URL so the browser can PUT large
// media (hero background + testimonial videos) STRAIGHT to storage,
// bypassing the ~4.5MB Vercel serverless request-body cap that /media
// (which streams the bytes through the function) is bound by.
//
// Flow:
//   1. client POSTs { page_id | location_id, kind, content_type } here
//      (tiny JSON). page_id (PAGES.1) attributes the upload to a landing
//      page: gated on canEditPage, path pages/<page_id>/<uuid>.<ext>.
//      location_id is the studio-level alternative (landing_page permission
//      there, path landing-page/<location_id>/<uuid>.<ext>). Exactly one is
//      needed; page_id wins when both are sent.
//   2. we auth and mint a signed upload
//      URL for a UUID-named path in the 'branding' bucket
//   3. client uploads the bytes directly via
//      supabase.storage.from('branding').uploadToSignedUrl(path, token, file)
//   4. client stores the returned public `url` in the block payload
//
// The bucket's own allowed_mime_types + file_size_limit
// (src/lib/branding-media.js, migs 252 and 675: 200MB) are the real
// ceiling on the direct upload — we can't see the bytes here, so the
// bucket enforces size. The token authorises the upload, not RLS: no
// client session writes this bucket (mig 675, BRANDINGBUCKET.1).
//
// Same gates as /media.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { loadPageById, canViewPage, canEditPage, PageReadError } from '@/lib/landing-pages'
import { logError } from '@/lib/log'

// Exactly one of page_id / location_id is required (checked below so the
// refusal can say so); when both arrive page_id wins and location_id is
// ignored, so it is not validated on the page branch.
const SignedUploadBody = z.object({
  page_id: z.string().optional().nullable(),
  location_id: z.string().optional().nullable(),
  kind: z.string(),
  content_type: z.string(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// video/quicktime (.mov) is accepted as an UNCOMPRESSED fallback: the client
// normally transcodes .mov → mp4 before upload, but when in-browser compression
// can't run (older Safari, low device memory) the original .mov uploads as-is
// rather than hard-rejecting the operator. Stored .mov (H.264/AAC) plays
// natively in Safari and most Chromium builds.
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

export async function POST(request) {
  const user = await getCurrentUser()

  const validation = await validateBody(request, SignedUploadBody)
  if (!validation.ok) return validation.response
  const { page_id: pageId, location_id: locationId, kind, content_type: contentType } = validation.data

  let prefix
  if (pageId) {
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    if (!uuidLike.safeParse(pageId).success) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
    let loaded
    try {
      loaded = await loadPageById(createServerClient(), pageId)
    } catch (err) {
      if (!(err instanceof PageReadError)) throw err
      logError('landing-page-settings', 'page unreadable on signed upload', { pageId, code: err.cause?.code ?? null })
      return NextResponse.json({ success: false, error: 'unavailable' }, { status: 503 })
    }
    // 404, not 403, for a page outside the caller's view (no id enumeration).
    if (!loaded || !canViewPage(user, loaded.page)) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
    if (!canEditPage(user, loaded.page)) {
      return NextResponse.json({ success: false, error: 'You can view this page but not edit it' }, { status: 403 })
    }
    prefix = `pages/${pageId}`
  } else {
    if (!locationId) {
      return NextResponse.json({ success: false, error: 'page_id or location_id is required' }, { status: 400 })
    }
    if (!uuidLike.safeParse(locationId).success) {
      return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
    }
    const guard = assertLocationAccess(user, locationId)
    if (guard) return guard
    if (!hasPermissionForLocation(user, locationId, 'landing_page')) {
      return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
    }
    prefix = `landing-page/${locationId}`
  }

  const isVideo = kind === 'video'
  const ext = (isVideo ? VIDEO_EXT : IMAGE_EXT)[contentType]
  if (!ext) {
    return NextResponse.json({
      success: false,
      error: isVideo ? 'Unsupported video type. Use MP4, WebM, or MOV.' : 'Unsupported file type. Use PNG, JPEG, or WebP.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const path = `${prefix}/${randomUUID()}.${ext}`

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
