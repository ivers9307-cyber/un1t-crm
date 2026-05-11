// /api/landing-page-settings/hero-image — upload the landing page
// hero background image. Mirrors the race TV-logo upload route
// (mig 092) — multipart form, stores in the existing 'branding'
// bucket, returns the public URL. Caller is then expected to PUT
// /api/landing-page-settings with the new hero_image_url so the
// upload route owns the bytes, not the row.
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
  'image/png',
  'image/jpeg',
  'image/webp',
])
const MAX_BYTES = 5 * 1024 * 1024 // 5MB — hero images are larger than logos
const EXT_BY_TYPE = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
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
      error: 'Unsupported file type. Use PNG, JPEG, or WebP.',
    }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `File is too large (${Math.round(file.size / 1024)}KB). Max is 5MB.`,
    }, { status: 400 })
  }

  const db = createServerClient()
  const ext = EXT_BY_TYPE[file.type]
  const path = `landing-page/${locationId}/hero.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Best-effort cleanup of any existing hero file with a different
  // extension — otherwise PNG → JPG re-upload would leave both on
  // disk and the public URL with the new ext would still be served.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`landing-page/${locationId}`)
    const stale = (existing || [])
      .filter((o) => o.name.startsWith('hero.') && o.name !== `hero.${ext}`)
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
  // page (CDN would otherwise serve the previous bytes for hours).
  const url = `${urlData.publicUrl}?t=${Date.now()}`

  return NextResponse.json({ success: true, url })
}
