// /api/landing-page-settings/media — generic single-file upload for
// the block-based landing page (mig 128, Phase 3b).
//
// Phase 3a had three separate upload routes (hero-image, hero-video,
// gallery-photo, pillar-photo) because the storage path was tied to
// the page section the file landed in — hero.{ext} for the hero,
// pillars/{0|1|2}.{ext} for pillars, etc. In the block-based world
// every upload is just "an image/video that some block holds the
// URL to" — no longer tied to a section slot. So we collapse to one
// route with a UUID-named filename.
//
// Old routes still exist (Phase 3a code referenced them); they're
// dead code from the form's perspective once Phase 3b ships, and
// can be removed in a follow-up cleanup migration.
//
// Form passes:
//   - file        (multipart) — the file
//   - page_id     (multipart) — the landing page the file belongs to
//                   (PAGES.1): stored under pages/<page_id>/, gated on
//                   canEditPage. A page can belong to the whole
//                   organisation, so the upload is attributed to the page.
//   - location_id (multipart) — the studio-level alternative (the legacy
//                   landing-page/<location_id>/ path, gated on the
//                   landing_page permission there). Exactly one of the two
//                   is needed; page_id wins when both are sent.
//   - kind        (multipart) — 'image' | 'video'
//
// Returns: { success: true, url } — the operator's block payload
// then references the URL.
//
// Master OR owner at the location.

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { loadPageById, canViewPage, canEditPage, PageReadError } from '@/lib/landing-pages'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])
const EXT_BY_TYPE = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4':  'mp4',
  'video/webm': 'webm',
}
const MAX_BYTES = {
  image: 5  * 1024 * 1024,  // 5MB
  video: 25 * 1024 * 1024,  // 25MB
}

export async function POST(request) {
  const user = await getCurrentUser()

  const form = await request.formData()
  const file       = form.get('file')
  const pageIdRaw  = form.get('page_id')
  const locationId = form.get('location_id')
  const kindRaw    = form.get('kind')

  // Which half of the upload namespace: a page (PAGES.1) or a studio.
  const pageId = typeof pageIdRaw === 'string' && pageIdRaw !== '' ? pageIdRaw : null
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
      logError('landing-page-settings', 'page unreadable on media upload', { pageId, code: err.cause?.code ?? null })
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
    if (!locationId || typeof locationId !== 'string') {
      return NextResponse.json({ success: false, error: 'page_id or location_id is required' }, { status: 400 })
    }
    if (!uuidLike.safeParse(locationId).success) {
      return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
    }
    // Membership gate (also returns 401 when !user) → permission gate
    // (3-tier: location feature → user override → role default).
    const guard = assertLocationAccess(user, locationId)
    if (guard) return guard
    if (!hasPermissionForLocation(user, locationId, 'landing_page')) {
      return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
    }
    prefix = `landing-page/${locationId}`
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 })
  }

  const kind = kindRaw === 'video' ? 'video' : 'image'
  const allowed = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES
  if (!allowed.has(file.type)) {
    return NextResponse.json({
      success: false,
      error: kind === 'video'
        ? 'Unsupported file type. Use MP4 or WebM.'
        : 'Unsupported file type. Use PNG, JPEG, or WebP.',
    }, { status: 400 })
  }
  const cap = MAX_BYTES[kind]
  if (file.size > cap) {
    const mb = Math.round(file.size / 1024 / 1024)
    return NextResponse.json({
      success: false,
      error: `${kind === 'video' ? 'Video' : 'File'} is too large (${mb}MB). Max is ${cap / 1024 / 1024}MB.`,
    }, { status: 400 })
  }

  const db = createServerClient()
  const ext = EXT_BY_TYPE[file.type]
  const id = randomUUID()
  const path = `${prefix}/${id}.${ext}`
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
