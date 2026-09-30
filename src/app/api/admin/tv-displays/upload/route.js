// TV-TEMPLATE.1 / TV.1 — server-side image upload for TV displays.
//
// WHY THIS ROUTE EXISTS
// ─────────────────────
// The TV admin (TVAdmin.jsx, TemplateEditor.jsx) does its table
// writes straight from the browser Supabase client, which is fine
// for tv_displays / tv_content / tv_templates rows. Storage is the
// exception: the 'tv-content' bucket takes NO client session write
// (mig 671, TVBUCKET.1: no storage.objects policy admits it). This
// route is the only way in: authenticate with the CRM's own session,
// check the TV permission at the location, validate the file against
// src/lib/tv-media.js (the same list and cap the bucket enforces),
// then upload via the service-role client (bypasses RLS). The phone's
// TV screen (mobile/lib/tv-api.js uploadTvImage) posts here too.
//
// POST /api/admin/tv-displays/upload   (multipart/form-data)
//   file         — the image
//   kind         — 'content' (push-image) | 'template' (base image)
//   location_id  — the TV's location (defaults to active location)
// → { success: true, path }   — storage path for tv_content.source_ref
//                                or tv_templates.base_image_path

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import {
  hasPermissionAtAnyLocation, hasPermissionForLocation,
  hasMobilePermissionAtAnyLocation, hasMobilePermissionForLocation,
} from '@/lib/permissions'
import { TV_IMAGE_MIME_TYPES, TV_IMAGE_MAX_BYTES } from '@/lib/tv-media'

export async function POST(request) {
  const user = await getCurrentUser()
  // Same gate as the /admin/tv-displays page itself, plus the mobile
  // tv_displays permission so the phone's "Push → Photo" can upload here
  // (TV-MOBILE.B).
  // ROLESWEEP.1c — coarse pre-check; judged at the upload's location below.
  if (!user || (!hasPermissionAtAnyLocation(user, 'tv_displays') && !hasMobilePermissionAtAnyLocation(user, 'tv_displays'))) {
    return NextResponse.json({ success: false, error: 'Not authorised for TV displays' }, { status: 403 })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  const kind = formData.get('kind') || 'content'
  const locationId = formData.get('location_id') || user.activeLocation?.id

  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'No file provided.' }, { status: 400 })
  }
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No location.' }, { status: 400 })
  }
  if (kind !== 'content' && kind !== 'template') {
    return NextResponse.json({ success: false, error: 'Invalid upload kind.' }, { status: 400 })
  }

  // Operators can only upload against a location they belong to.
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1c — web OR mobile tv_displays judged at the TV's location.
  if (!hasPermissionForLocation(user, locationId, 'tv_displays') && !hasMobilePermissionForLocation(user, locationId, 'tv_displays')) {
    return NextResponse.json({ success: false, error: 'Not authorised for TV displays' }, { status: 403 })
  }

  if (!TV_IMAGE_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ success: false, error: 'File must be a PNG, JPEG, WebP, GIF or AVIF image.' }, { status: 400 })
  }
  if (file.size > TV_IMAGE_MAX_BYTES) {
    return NextResponse.json({ success: false, error: 'Image must be under 15MB.' }, { status: 400 })
  }

  // template base images live under <location>/templates/, push
  // images directly under <location>/ — mirrors the old client paths.
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const prefix = kind === 'template' ? `${locationId}/templates` : `${locationId}`
  const path = `${prefix}/${crypto.randomUUID()}.${ext}`

  const db = createServerClient()
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await db.storage
    .from('tv-content')
    .upload(path, buffer, {
      contentType: file.type,
      cacheControl: '3600',
      upsert: false,
    })

  if (uploadError) {
    return NextResponse.json({ success: false, error: uploadError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, path })
}
