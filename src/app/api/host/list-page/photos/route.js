// /api/host/list-page/photos — HOSTPAGE.2
//
// POST (multipart `file`) — a host adds a photo to their public page's grid:
// PNG/JPEG/WebP, ≤5 MB (the browser compresses first), at most 12 photos,
// stored in the public `branding` bucket under host-photos/<host id>/<uuid>.<ext>
// (never upserted: every file is its own object) and appended to
// event_hosts.photos as { url, caption: null }. The caption is set through
// PATCH /api/host/list-page.
// DELETE ?url= — removes a photo the host's own list holds: the URL must be
// in `photos` AND resolve to a path under host-photos/<host id>/ (anything
// else is 404: a URL is not a capability). The object removal is
// best-effort; the list entry always goes.
//
// Host-gated (getCurrentHost): only the session host's row is ever read or
// written. tests/branding-bucket-guard.test.js pins this file as a writer.

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentHost } from '@/lib/host-auth'
import { HOST_PHOTOS_MAX, hostPageExtras } from '@/lib/host-page-extras'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const HOST_PHOTO_MAX_BYTES = 5 * 1024 * 1024

const folderFor = (hostId) => `host-photos/${hostId}/`

/** The bucket path a public URL points at, or null when it is not a branding URL. */
function bucketPathOf(url) {
  try {
    const u = new URL(String(url))
    const i = u.pathname.indexOf('/object/public/branding/')
    if (i < 0) return null
    return decodeURIComponent(u.pathname.slice(i + '/object/public/branding/'.length))
  } catch { return null }
}

async function loadHost(db, hostId) {
  const { data, error } = await db.from('event_hosts').select('id, photos').eq('id', hostId).maybeSingle()
  if (error) {
    logError('host-photos', 'host read failed', { err: error, hostId })
    return { error }
  }
  return { host: data }
}

async function writePhotos(db, hostId, photos) {
  const { error } = await db.from('event_hosts').update({ photos }).eq('id', hostId)
  if (error) logError('host-photos', 'photos write failed', { err: error, hostId })
  return error
}

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let form
  try { form = await request.formData() } catch {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }
  const file = form.get('file')
  if (!file || typeof file === 'string') return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ success: false, error: 'Unsupported file type. Use PNG, JPEG, or WebP.' }, { status: 400 })
  if (file.size > HOST_PHOTO_MAX_BYTES) {
    return NextResponse.json({ success: false, error: `File is too large (${Math.round(file.size / 1024)}KB). Max is 5MB.` }, { status: 400 })
  }

  const db = createServerClient()
  const { host, error: readErr } = await loadHost(db, session.host.id)
  if (readErr) return NextResponse.json({ success: false, error: 'Could not load your page.' }, { status: 500 })
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const photos = hostPageExtras(host).photos
  if (photos.length >= HOST_PHOTOS_MAX) {
    return NextResponse.json({ success: false, error: `You can have up to ${HOST_PHOTOS_MAX} photos. Remove one first.`, code: 'photos_full' }, { status: 400 })
  }

  const path = `${folderFor(host.id)}${crypto.randomUUID()}.${EXT_BY_TYPE[file.type]}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadErr } = await db.storage.from('branding').upload(path, buffer, { contentType: file.type, upsert: false })
  if (uploadErr) return NextResponse.json({ success: false, error: uploadErr.message }, { status: 400 })
  const { data: urlData } = db.storage.from('branding').getPublicUrl(path)
  const url = urlData.publicUrl

  const next = [...photos, { url, caption: null }]
  const writeErr = await writePhotos(db, host.id, next)
  if (writeErr) {
    // The bytes are up but the list did not take them: remove the orphan.
    try { await db.storage.from('branding').remove([path]) } catch { /* best-effort */ }
    return NextResponse.json({ success: false, error: 'Could not save the photo — try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, url, data: { url, photos: next } })
}

export async function DELETE(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const url = new URL(request.url).searchParams.get('url') || ''

  const db = createServerClient()
  const { host, error: readErr } = await loadHost(db, session.host.id)
  if (readErr) return NextResponse.json({ success: false, error: 'Could not load your page.' }, { status: 500 })
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const photos = hostPageExtras(host).photos
  const path = bucketPathOf(url)
  const held = photos.some((p) => p.url === url)
  if (!url || !held || !path || !path.startsWith(folderFor(host.id))) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  try {
    const { error } = await db.storage.from('branding').remove([path])
    if (error) logWarn('host-photos', 'object removal failed; list entry removed anyway', { err: error, path })
  } catch (err) {
    logWarn('host-photos', 'object removal threw; list entry removed anyway', { err, path })
  }
  const next = photos.filter((p) => p.url !== url)
  const writeErr = await writePhotos(db, host.id, next)
  if (writeErr) return NextResponse.json({ success: false, error: 'Could not update your page — try again.' }, { status: 500 })
  return NextResponse.json({ success: true, data: { photos: next } })
}
