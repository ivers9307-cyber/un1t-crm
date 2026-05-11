// /api/landing-page-settings/pillar-photo — upload an optional
// photo above one of the 3 "What we do" pillars (mig 127, Phase 3a).
//
// Slot-indexed (slot=0|1|2) rather than UUID-named because there
// are exactly 3 slots and re-uploading slot 0 should replace the
// previous slot-0 photo, not leave both on disk.
//
// Returns the public URL — caller patches pillars[slot].photo_url
// via PUT /api/landing-page-settings.
//
// Master OR owner at the location.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])
const MAX_BYTES = 5 * 1024 * 1024 // 5MB
const EXT_BY_TYPE = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const VALID_SLOTS = new Set(['0', '1', '2'])

function isMasterOrLocationOwner(user, locationId) {
  if (!user) return false
  if (user.role === 'master') return true
  const match = (user.locations || []).find((l) => l.id === locationId)
  return match?.role === 'owner'
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const form = await request.formData()
  const file = form.get('file')
  const locationId = form.get('location_id')
  const slot = form.get('slot')

  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  if (!slot || !VALID_SLOTS.has(String(slot))) {
    return NextResponse.json({ success: false, error: 'slot must be 0, 1, or 2' }, { status: 400 })
  }
  if (!isMasterOrLocationOwner(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Master or owner required' }, { status: 403 })
  }
  if (user.role !== 'master' && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
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
  const path = `landing-page/${locationId}/pillars/${slot}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Best-effort cleanup of stale extensions in this slot — same
  // pattern as the hero-image route. Pillar 0 going PNG → JPG
  // would otherwise leave a stale .png alongside the new .jpg.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`landing-page/${locationId}/pillars`)
    const stale = (existing || [])
      .filter((o) => o.name.startsWith(`${slot}.`) && o.name !== `${slot}.${ext}`)
      .map((o) => `landing-page/${locationId}/pillars/${o.name}`)
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
  const url = `${urlData.publicUrl}?t=${Date.now()}`
  return NextResponse.json({ success: true, url })
}
