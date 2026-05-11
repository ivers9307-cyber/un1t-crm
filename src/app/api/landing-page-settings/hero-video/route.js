// /api/landing-page-settings/hero-video — upload the landing page
// hero background video (mig 127, Phase 3a). Mirrors hero-image:
// multipart form, stores in 'branding' bucket, returns public URL.
// Caller PUTs /api/landing-page-settings with the new hero_video_url.
//
// MP4 + WebM only — those autoplay reliably across modern browsers
// when set to muted+playsinline. MOV/AVI would need server-side
// transcoding which we don't have.
//
// 25MB cap. The /welcome page sends this as a hero background, so
// it has to load fast on first visit; over 25MB and mobile data
// users would see a black hero for several seconds. Operator
// guidance: encode at 720p, 5-15 seconds, ~3-5Mbps.
//
// Master OR owner at the location.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set([
  'video/mp4',
  'video/webm',
])
const MAX_BYTES = 25 * 1024 * 1024 // 25MB
const EXT_BY_TYPE = {
  'video/mp4':  'mp4',
  'video/webm': 'webm',
}

export async function POST(request) {
  const user = await getCurrentUser()

  const form = await request.formData()
  const file = form.get('file')
  const locationId = form.get('location_id')

  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
  }

  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({
      success: false,
      error: 'Unsupported file type. Use MP4 or WebM.',
    }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `Video is too large (${Math.round(file.size / 1024 / 1024)}MB). Max is 25MB. Try compressing to 720p / ~5 seconds.`,
    }, { status: 400 })
  }

  const db = createServerClient()
  const ext = EXT_BY_TYPE[file.type]
  const path = `landing-page/${locationId}/hero-video.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Best-effort cleanup of any existing hero-video file with a
  // different extension — otherwise MP4 → WebM re-upload would
  // leave both on disk and the public URL with the new ext would
  // still work but the cdn would serve stale bytes for the other.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`landing-page/${locationId}`)
    const stale = (existing || [])
      .filter((o) => o.name.startsWith('hero-video.') && o.name !== `hero-video.${ext}`)
      .map((o) => `landing-page/${locationId}/${o.name}`)
    if (stale.length > 0) {
      await db.storage.from('branding').remove(stale)
    }
  } catch {
    /* best-effort */
  }

  const { error: uploadErr } = await db.storage
    .from('branding')
    .upload(path, buffer, { contentType: file.type, upsert: true })
  if (uploadErr) {
    return NextResponse.json({ success: false, error: uploadErr.message }, { status: 400 })
  }

  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  // Cache-bust so a re-upload surfaces immediately on the public
  // page (CDN would otherwise serve previous bytes for hours).
  const url = `${urlData.publicUrl}?t=${Date.now()}`

  return NextResponse.json({ success: true, url })
}
