// /api/landing-page-settings/gallery-photo — upload a single photo
// for the landing page gallery (mig 127, Phase 3a). Mirrors hero-image
// but with a UUID-suffixed filename so an operator can upload many
// photos to the same location without one overwriting another.
//
// Returns the public URL — the caller appends an item to the
// gallery JSONB array via PUT /api/landing-page-settings.
//
// Master OR owner at the location.

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
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
const MAX_BYTES = 5 * 1024 * 1024 // 5MB per photo
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
      error: `File is too large (${Math.round(file.size / 1024)}KB). Max is 5MB per photo.`,
    }, { status: 400 })
  }

  const db = createServerClient()
  const ext = EXT_BY_TYPE[file.type]
  // UUID per photo so two uploads never collide. Cleanup of orphaned
  // photos (gallery item removed but file still in storage) is a
  // future job — not blocking here; storage cost is negligible.
  const id = randomUUID()
  const path = `landing-page/${locationId}/gallery/${id}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const { error: uploadErr } = await db.storage
    .from('branding')
    .upload(path, buffer, { contentType: file.type, upsert: false })
  if (uploadErr) {
    return NextResponse.json({ success: false, error: uploadErr.message }, { status: 400 })
  }

  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  return NextResponse.json({ success: true, url: urlData.publicUrl })
}
