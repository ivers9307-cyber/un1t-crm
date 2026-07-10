// /api/host/events/[id]/hero — host-scoped hero image upload. (HOST-PORTAL.11)
//
// Mirrors the staff route (src/app/api/events/[id]/hero/route.js) exactly on
// multipart parsing, validation, storage path, and response shape — ONLY the
// gate is swapped: getCurrentHost() (401) + host_id ownership (404, never 403,
// so event ids can't be enumerated — same loadOwn pattern as
// /api/host/events/[id]).
//
// POST a multipart/form-data body with:
//   file:  the image (PNG/JPEG/WebP, ≤5MB)
//
// Stores the file in the existing 'branding' Supabase Storage bucket at
// race-hero/<race_id>/hero.<ext> (upserted so re-uploads overwrite) — the
// SAME path the staff route writes, so staff and host manage one file per
// event. The extension comes from the whitelisted MIME type, never from the
// client filename, and <race_id> is the DB row's own id (not raw client
// input), so there's no path-traversal surface. Returns the public URL. The
// caller is expected to then PUT /api/host/events/[id] with an updated
// hero_image_url — the upload route only owns the bytes, not the race_events
// row, so a failed PUT doesn't leave a dangling URL on the race.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentHost } from '@/lib/host-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])
const MAX_BYTES = 5 * 1024 * 1024 // 5MB — heroes are larger than logos
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

async function loadOwn(db, session, id) {
  const { data } = await db
    .from('race_events')
    .select('id, host_id')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.host_id !== session.host.id) return null
  return data
}

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const race = await loadOwn(db, session, params.id)
  if (!race) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const form = await request.formData()
  const file = form.get('file')
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

  const ext = EXT_BY_TYPE[file.type]
  const path = `race-hero/${race.id}/hero.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  // Best-effort cleanup of any existing hero file with a different
  // extension — otherwise a PNG → WebP re-upload would leave both on
  // disk, and the public URL with the new ext would still be served.
  // We list the hero dir and delete anything that doesn't match the
  // new path. Failure here is non-fatal.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`race-hero/${race.id}`)
    const stale = (existing || [])
      .filter((o) => o.name.startsWith('hero.') && o.name !== `hero.${ext}`)
      .map((o) => `race-hero/${race.id}/${o.name}`)
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
  // Cache-bust so a re-upload surfaces immediately rather than hitting
  // a stale CDN cache on the same public URL.
  const url = `${urlData.publicUrl}?t=${Date.now()}`
  return NextResponse.json({ success: true, url, path })
}

// DELETE /api/host/events/[id]/hero — remove the hero's bytes. Caller is
// still expected to PUT the event with hero_image_url = null.
export async function DELETE(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const race = await loadOwn(db, session, params.id)
  if (!race) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // List + delete every file in race-hero/<id>/ that begins with
  // hero. so we sweep any stale extensions too.
  try {
    const { data: existing } = await db.storage
      .from('branding')
      .list(`race-hero/${race.id}`)
    const toDelete = (existing || [])
      .filter((o) => o.name.startsWith('hero.'))
      .map((o) => `race-hero/${race.id}/${o.name}`)
    if (toDelete.length > 0) {
      await db.storage.from('branding').remove(toDelete)
    }
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ success: true })
}
