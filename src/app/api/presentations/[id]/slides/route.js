// POST /api/presentations/[id]/slides  (multipart/form-data, field `files` × N)
// Uploads images to the presentation-slides bucket, appends slide rows after
// the current max position (natural-sorted by filename), bumps version.
import { NextResponse } from 'next/server'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { naturalSortByName } from '@/lib/presentations'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
const MAX_BYTES = 15 * 1024 * 1024

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}

// withAuth signs the caller in (signed out is its 401); the presentations
// checks and the deck's studio run below as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'presentations')) return deny()
  const id = params?.id

  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // ROLESWEEP.1a — the permission is judged at the deck's location.
  if (!hasPermissionForLocation(user, deck.location_id, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }

  const form = await request.formData()
  const files = form.getAll('files').filter((f) => f && typeof f !== 'string')
  if (!files.length) return NextResponse.json({ success: false, error: 'No files provided.' }, { status: 400 })
  for (const f of files) {
    if (!ALLOWED.includes(f.type)) return NextResponse.json({ success: false, error: `"${f.name}" must be PNG/JPEG/WebP/GIF/AVIF.` }, { status: 400 })
    if (f.size > MAX_BYTES) return NextResponse.json({ success: false, error: `"${f.name}" is over 15MB.` }, { status: 400 })
  }

  // Append after the current highest position.
  const { data: maxRow } = await db
    .from('presentation_slides').select('position').eq('presentation_id', id)
    .order('position', { ascending: false }).limit(1).maybeSingle()
  let pos = (maxRow?.position ?? -1) + 1

  const ordered = naturalSortByName(files.map((f) => ({ name: f.name || '', file: f })))
  const inserted = []
  for (const { file } of ordered) {
    const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `${deck.location_id}/${id}/${crypto.randomUUID()}.${ext}`
    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: upErr } = await db.storage.from('presentation-slides')
      .upload(path, buffer, { contentType: file.type, cacheControl: '3600', upsert: false })
    if (upErr) {
      // PRESENTSAFE.1 — slides saved before the failure still reach open screens.
      if (inserted.length) await bumpVersion(db, id)
      logError('presentations', 'slide upload failed', { presentationId: id, err: upErr })
      return NextResponse.json({ success: false, error: 'Could not upload the slide.', added: inserted.length }, { status: 400 })
    }
    const { data: row, error: insErr } = await db.from('presentation_slides')
      .insert({ presentation_id: id, location_id: deck.location_id, position: pos, image_path: path })
      .select('id, position, image_path').single()
    if (insErr) {
      if (inserted.length) await bumpVersion(db, id)
      logError('presentations', 'slide row insert failed', { presentationId: id, err: insErr })
      return NextResponse.json({ success: false, error: 'Could not save the slide.', added: inserted.length }, { status: 500 })
    }
    inserted.push(row); pos += 1
  }

  const bumped = await bumpVersion(db, id)
  return NextResponse.json({
    success: true,
    added: inserted.length,
    ...(bumped ? {} : { warning: 'Saved, but open screens did not get the update. Reload them.' }),
  })
})

// PRESENTSAFE.1 — the version is what tells open screens to re-read; a failed
// bump is logged and reported, never ignored.
async function bumpVersion(db, id) {
  const { error } = await db.rpc('bump_presentation_version', { p_presentation_id: id })
  if (error) logError('presentations', 'version bump failed', { presentationId: id, error: error.message })
  return !error
}
