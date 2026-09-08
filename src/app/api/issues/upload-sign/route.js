// POST /api/issues/upload-sign
//
// REPORT-ISSUE.3 — step 1 of the issue-photo upload.
//
// Why this route exists: the phone used to POST the photos as multipart
// form-data straight at /api/issues. That stopped working on the mobile
// app — the request never left the device (2026-09-08: the app's GETs are
// all over the production logs in the same session, and there is not one
// POST /api/issues among them), and the submit screen sat on its spinner
// forever. The multipart body was also physically capped: Vercel rejects
// serverless request bodies over ~4.5 MB, so the advertised 3 x 10 MB was
// never actually postable — the same bug class already fixed for
// contractor invoices, company-card receipts and WhatsApp template media.
//
// The bytes now bypass the API entirely:
//   1. This route validates the declared photo metadata, mints one storage
//      path per photo and returns a Supabase signed-upload token for each,
//      for the PRIVATE issue-photos bucket.
//   2. The device uploads each photo straight to Storage with its token.
//   3. POST /api/issues (JSON mode) verifies the stored objects and inserts.
//
// Auth: the same gate as POST /api/issues — any authenticated profile with
// an active location. Reporting a broken thing in the gym is universal;
// the location scope is what the photos get namespaced by.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { buildAttachmentPath, validatePhotos, MAX_PHOTOS_PER_ISSUE } from '@/lib/issues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'issue-photos'

export const POST = withAuth(
  {},
  async ({ db, locationId, request }) => {
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'Active location required.' },
        { status: 400 }
      )
    }

    let body
    try { body = await request.json() }
    catch {
      return NextResponse.json(
        { success: false, error: 'Expected a JSON body.' },
        { status: 400 }
      )
    }

    const photos = Array.isArray(body?.photos) ? body.photos : []
    if (photos.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No photos to upload.', code: 'no_photos' },
        { status: 400 }
      )
    }

    // Same rules the finalise route re-applies to what Storage actually
    // holds — this pass just saves the device a pointless upload.
    const v = validatePhotos(photos.map((p) => ({
      filename: p?.file_name || 'photo',
      size: Number(p?.size),
      type: String(p?.mime || '').toLowerCase(),
    })))
    if (!v.ok) {
      return NextResponse.json({ success: false, error: v.error, code: v.code }, { status: 400 })
    }

    // One draft id groups this submission's photos under the location
    // prefix, exactly as the multipart path did — the issue row's own id
    // is minted by the database at insert time and was never the segment
    // here, so nothing downstream reads it as a foreign key.
    const draftId = crypto.randomUUID()

    const slots = []
    for (const p of photos.slice(0, MAX_PHOTOS_PER_ISSUE)) {
      const path = buildAttachmentPath({
        locationId,
        issueId: draftId,
        attachmentId: crypto.randomUUID(),
        filename: p?.file_name || 'photo.jpg',
      })
      const { data, error } = await db.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(path)
      if (error || !data?.token) {
        return NextResponse.json(
          { success: false, error: `Could not create upload URL: ${error?.message || 'no token returned'}` },
          { status: 500 }
        )
      }
      slots.push({ path, token: data.token })
    }

    return NextResponse.json({ success: true, draft_id: draftId, slots })
  }
)
