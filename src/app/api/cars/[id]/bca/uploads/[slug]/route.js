// POST/DELETE /api/cars/[id]/bca/uploads/[slug]
//
// Staging-only upload for one of the 10 BCA doc slots. Each slot
// holds at most one file at a time — re-upload to the same slot
// overwrites (upsert). DELETE clears the slot.
//
// Path: bca-documents/{location_id}/{car_id}/_staging/{slug}.{ext}
//
// Allowed mime types: PDF + JPEG + PNG + WebP (matches the bucket-
// level allowedlist seeded in mig 163). Max per-file 20 MB (well
// under the bucket's 25 MB cap; gives Phase 2 headroom to add merged-
// PDF compression without bumping up against limits).
//
// Auth: any authenticated user with car_processing permission AT the
// car's location. service-role write goes through createServerClient.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { getBcaConfig, BCA_STORAGE } from '@/lib/bca'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 20 * 1024 * 1024  // 20 MB
const MIME_TO_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

// Helper used by both verbs: resolve car + location + verify the slot
// slug is valid for this location's BCA config.
async function preflight(db, params, user) {
  const { data: car, error: carErr } = await db
    .from('cars')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (carErr || !car) {
    return { error: NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 }) }
  }
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return { error: guard }

  const { data: location } = await db
    .from('locations')
    .select('id, features, bca_config')
    .eq('id', car.location_id)
    .single()
  const config = getBcaConfig(location)
  if (!config) {
    return { error: NextResponse.json({ success: false, error: 'BCA Submit is not enabled at this location' }, { status: 404 }) }
  }

  const validSlugs = new Set(config.documents.map(d => d.slug))
  if (!validSlugs.has(params.slug)) {
    return { error: NextResponse.json({ success: false, error: `Unknown slot "${params.slug}"` }, { status: 400 }) }
  }

  return { car, config }
}

// Remove any existing staged file for this slug, regardless of
// extension. Used by both POST (before upload) and DELETE. Each slot
// has at most one staged file so this is cheap.
async function clearSlot(db, locationId, carId, slug) {
  const prefix = `${locationId}/${carId}/_staging`
  const { data: files } = await db.storage
    .from(BCA_STORAGE.bucket)
    .list(prefix, { limit: 100 })
  const matches = (files || [])
    .map(f => f.name)
    .filter(n => new RegExp(`^${slug}\\.[a-zA-Z0-9]+$`).test(n))
    .map(n => `${prefix}/${n}`)
  if (matches.length > 0) {
    await db.storage.from(BCA_STORAGE.bucket).remove(matches).catch(() => {})
  }
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const pre = await preflight(db, params, user)
  if (pre.error) return pre.error
  const { car } = pre

  let formData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Expected multipart/form-data' }, { status: 400 })
  }
  const file = formData.get('file')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ success: false, error: 'No file in form-data field "file"' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error: `File too large (${Math.round(file.size / 1024 / 1024)} MB). Max ${MAX_BYTES / 1024 / 1024} MB per slot.`,
    }, { status: 400 })
  }
  const ext = MIME_TO_EXT[file.type]
  if (!ext) {
    return NextResponse.json({
      success: false,
      error: `Unsupported file type "${file.type || 'unknown'}". Allowed: PDF, JPEG, PNG, WebP.`,
    }, { status: 400 })
  }

  // Clear any previous file in this slot (possibly a different
  // extension) before writing the new one.
  await clearSlot(db, car.location_id, car.id, params.slug)

  const path = BCA_STORAGE.staging(car.location_id, car.id, params.slug, ext)
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadErr } = await db.storage
    .from(BCA_STORAGE.bucket)
    .upload(path, buffer, {
      contentType: file.type,
      upsert: true,
      // Preserve original filename in metadata for the UI to show.
      metadata: { originalFilename: file.name },
    })
  if (uploadErr) {
    return NextResponse.json({ success: false, error: `Upload failed: ${uploadErr.message}` }, { status: 500 })
  }

  const { data: signed } = await db.storage
    .from(BCA_STORAGE.bucket)
    .createSignedUrl(path, 3600)

  return NextResponse.json({
    success: true,
    data: {
      slug: params.slug,
      filename: file.name,
      size_bytes: file.size,
      content_type: file.type,
      signed_url: signed?.signedUrl || null,
    },
  })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const pre = await preflight(db, params, user)
  if (pre.error) return pre.error
  const { car } = pre

  await clearSlot(db, car.location_id, car.id, params.slug)
  return NextResponse.json({ success: true })
}
