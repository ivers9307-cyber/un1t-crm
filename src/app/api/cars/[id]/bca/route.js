// GET /api/cars/[id]/bca
//
// Returns the state needed to render the BCA Submit tab for one car:
//   - config: the merged BCA config for the car's location (or null
//             when the feature is off — UI hides the tab)
//   - staged: { [slug]: { filename, size_bytes, content_type,
//                         updated_at, signed_url } | null }
//             the per-slot staged uploads. Signed URLs expire in 1h.
//   - submissions: chronological history (most recent first). Phase 1
//             always returns []. Phase 2 will populate.
//
// Staging files live in storage at
//   bca-documents/{location_id}/{car_id}/_staging/{slug}.{ext}
// We list the prefix and bucket the results by slug. Extension is
// derived from the filename stored in metadata; we don't need it for
// the listing path itself because each slot has at most one staged
// file at a time (a re-upload to the same slot upserts to the same
// path with the same extension).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { getBcaConfig, BCA_STORAGE } from '@/lib/bca'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car, error: carErr } = await db
    .from('cars')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (carErr || !car) return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return guard

  const { data: location } = await db
    .from('locations')
    .select('id, features, bca_config')
    .eq('id', car.location_id)
    .single()
  const config = getBcaConfig(location)
  if (!config) {
    // Feature off at this location — short-circuit. The UI uses this
    // to know not to render the tab at all.
    return NextResponse.json({ success: true, data: { config: null, staged: {}, submissions: [] } })
  }

  // List staged files for this car.
  const stagingPrefix = `${car.location_id}/${car.id}/_staging`
  const { data: files, error: listErr } = await db.storage
    .from(BCA_STORAGE.bucket)
    .list(stagingPrefix, { limit: 100 })
  if (listErr) {
    return NextResponse.json({ success: false, error: `Storage list failed: ${listErr.message}` }, { status: 500 })
  }

  // Bucket by slug. Filename in storage is `{slug}.{ext}`; we accept
  // any of the bucket's allowed mime types so the extension varies.
  const staged = {}
  const validSlugs = new Set(config.documents.map(d => d.slug))
  for (const f of files || []) {
    const m = f.name.match(/^(doc_\d{2})\.([a-zA-Z0-9]+)$/)
    if (!m) continue
    const slug = m[1]
    if (!validSlugs.has(slug)) continue
    const path = `${stagingPrefix}/${f.name}`
    // Sign a short-lived URL for preview / download from the UI.
    const { data: signed } = await db.storage
      .from(BCA_STORAGE.bucket)
      .createSignedUrl(path, 3600)
    staged[slug] = {
      filename: f.metadata?.originalFilename || f.name,
      size_bytes: f.metadata?.size ?? null,
      content_type: f.metadata?.mimetype || null,
      updated_at: f.updated_at || f.created_at || null,
      signed_url: signed?.signedUrl || null,
    }
  }

  // Pull every submission row for this car (active + superseded +
  // failed), newest first. Each row gets a short-lived signed URL
  // for its merged PDF so the operator can re-download what was sent.
  const { data: rows, error: subErr } = await db
    .from('car_bca_submissions')
    .select('id, email_from, email_to, email_subject, documents, merged_pdf_path, merged_pdf_size, submitted_by, submitted_at, postmark_message_id, postmark_error_code, postmark_error_msg, superseded_at, superseded_by')
    .eq('car_id', car.id)
    .order('submitted_at', { ascending: false })
  if (subErr) {
    return NextResponse.json({ success: false, error: `Submissions read failed: ${subErr.message}` }, { status: 500 })
  }
  const submissions = []
  for (const row of rows || []) {
    let mergedSignedUrl = null
    if (row.merged_pdf_path) {
      const { data: signed } = await db.storage
        .from(BCA_STORAGE.bucket)
        .createSignedUrl(row.merged_pdf_path, 3600)
      mergedSignedUrl = signed?.signedUrl || null
    }
    submissions.push({ ...row, merged_pdf_signed_url: mergedSignedUrl })
  }

  return NextResponse.json({ success: true, data: { config, staged, submissions } })
}
