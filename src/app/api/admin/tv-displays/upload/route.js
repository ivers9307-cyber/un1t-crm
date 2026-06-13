// TV-TEMPLATE.1 / TV.1 — server-side image upload for TV displays.
//
// WHY THIS ROUTE EXISTS
// ─────────────────────
// The TV admin (TVAdmin.jsx, TemplateEditor.jsx) does its table
// writes straight from the browser Supabase client, which is fine
// for tv_displays / tv_content / tv_templates rows. Storage is the
// exception: the browser client can't satisfy the 'tv-content'
// bucket's INSERT policy, so `db.storage.upload()` fails with
// "new row violates row-level security policy". Every other bucket
// in this app (branding, car-documents, contractor-invoices) is
// written server-side with the service-role client for exactly
// this reason — TV uploads were the odd ones out and never worked.
//
// This route restores the pattern: authenticate with the CRM's own
// session, then upload via the service-role client (bypasses RLS).
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
import { hasPermission, hasMobilePermission } from '@/lib/permissions'

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
const MAX_BYTES = 15 * 1024 * 1024   // 15MB — TV art is full-bleed 1920×1080+

export async function POST(request) {
  const user = await getCurrentUser()
  // Same gate as the /admin/tv-displays page itself, plus the mobile
  // tv_displays permission so the phone's "Push → Photo" can upload here
  // (TV-MOBILE.B).
  if (!user || (!hasPermission(user, 'tv_displays') && !hasMobilePermission(user, 'tv_displays'))) {
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

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ success: false, error: 'File must be a PNG, JPEG, WebP, GIF or AVIF image.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
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
