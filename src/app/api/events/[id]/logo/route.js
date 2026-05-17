// /api/events/[id]/logo — upload a single TV-display logo.
//
// POST a multipart/form-data body with:
//   file:  the image (PNG/JPEG/SVG/WebP, ≤2MB)
//   slot:  '0' | '1' | '2' — which logo slot to write
//
// Stores the file in the existing 'branding' Supabase Storage bucket
// at race-logos/<race_id>/<slot>.<ext> (upserted so re-uploads
// overwrite). Returns the public URL. The caller is expected to
// then PUT /api/events/[id] with an updated tv_logos array including
// the new URL — the upload route only owns the bytes, not the
// race_events row, so a failed PUT doesn't leave a dangling URL on
// the race.
//
// Manager+ at the race's location.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
])
const MAX_BYTES = 2 * 1024 * 1024 // 2MB
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (raceErr || !race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) return guard

  const form = await request.formData()
  const file = form.get('file')
  const slotRaw = form.get('slot')
  const slot = parseInt(slotRaw)
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) {
    return NextResponse.json({ success: false, error: 'slot must be 0, 1, or 2' }, { status: 400 })
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({
      success: false,
      error: 'Unsupported file type. Use PNG, JPEG, WebP, or SVG.',
    }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `File is too large (${Math.round(file.size / 1024)}KB). Max is 2MB.`,
    }, { status: 400 })
  }

  const ext = EXT_BY_TYPE[file.type]
  const path = `race-logos/${race.id}/${slot}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Best-effort cleanup of any existing slot file with a different
  // extension — otherwise a PNG → SVG re-upload would leave both on
  // disk, and the public URL with the new ext would still be served.
  // We list the slot dir and delete anything that doesn't match the
  // new path. Failure here is non-fatal.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`race-logos/${race.id}`)
    const stale = (existing || [])
      .filter((o) => o.name.startsWith(`${slot}.`) && o.name !== `${slot}.${ext}`)
      .map((o) => `race-logos/${race.id}/${o.name}`)
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
  // Cache-bust so a re-upload to the same slot surfaces immediately
  // on the TV (which polls every 2s but the image URL itself would
  // hit a CDN cache otherwise).
  const url = `${urlData.publicUrl}?t=${Date.now()}`
  return NextResponse.json({ success: true, url, slot, path })
}

// DELETE /api/events/[id]/logo?slot=N — remove a single slot's bytes.
// Caller is still expected to PUT the race with an updated
// tv_logos array (slot positions get re-packed client-side).
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }
  const slot = parseInt(new URL(request.url).searchParams.get('slot'))
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) {
    return NextResponse.json({ success: false, error: 'slot must be 0, 1, or 2' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!race) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccess(user, race.location_id)
  if (guard) return guard

  // List + delete every file in race-logos/<id>/ that begins with
  // <slot>. so we sweep any stale extensions too.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`race-logos/${race.id}`)
    const toDelete = (existing || [])
      .filter((o) => o.name.startsWith(`${slot}.`))
      .map((o) => `race-logos/${race.id}/${o.name}`)
    if (toDelete.length > 0) {
      await db.storage.from('branding').remove(toDelete)
    }
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ success: true })
}
