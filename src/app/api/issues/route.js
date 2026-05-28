// REPORT-ISSUE.1 — submit an issue + list the caller's own
// submissions.
//
//   POST → submit a new issue at the active location. Multipart
//          body: description + 0..3 photos. Photos go into the
//          issue-photos bucket; row carries the storage paths.
//   GET  → list the caller's own submissions, newest first. Always
//          across all their locations — useful when an operator
//          works at multiple studios and wants to see the full
//          history.
//
// Routing target (owner inbox) lands in PR 2. PR 1 is submit-only +
// own-history read.
//
// Auth: any authenticated profile (no permission gate — anyone with
// a profile at a location can report a problem). withAuth resolves
// the active location, which is what we attach the issue to.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import {
  insertIssueWithAttachments,
  listMyIssues,
  buildAttachmentPath,
  validateSubmission,
} from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Photo uploads can push us past the default 30s — give the route
// some headroom on 4G uploads with 3x 10MB photos.
export const maxDuration = 60

const STORAGE_BUCKET = 'issue-photos'

// ---- POST ----

export const POST = withAuth(
  {},
  async ({ user, db, locationId, request }) => {
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'Active location required.' },
        { status: 400 }
      )
    }

    let form
    try { form = await request.formData() }
    catch {
      return NextResponse.json(
        { success: false, error: 'Expected multipart/form-data.' },
        { status: 400 }
      )
    }

    const description = String(form.get('description') || '')
    // Photos come in as numbered keys: photo_0, photo_1, photo_2.
    // Keeps ordering deterministic across the network and means we
    // don't depend on FormData.getAll() ordering across runtimes.
    const photoFiles = []
    for (let i = 0; i < 3; i++) {
      const f = form.get(`photo_${i}`)
      if (f && typeof f === 'object' && 'size' in f && f.size > 0) {
        photoFiles.push(f)
      }
    }

    // Pure validation — description + file metadata only. The bytes
    // get sniffed by Supabase storage on upload.
    const photoMeta = photoFiles.map((f) => ({
      filename: f.name || 'photo',
      size: f.size,
      type: (f.type || '').toLowerCase(),
    }))
    const v = validateSubmission({ description, photos: photoMeta })
    if (!v.ok) {
      return NextResponse.json(
        { success: false, error: v.error, code: v.code },
        { status: 400 }
      )
    }

    // Mint the issue id upfront so we can namespace the storage
    // path by issue_id without a round-trip. Same trick the FTE
    // expense route uses (it round-trips because that pattern
    // pre-dates this one — we improve here).
    const issueId = crypto.randomUUID()
    const uploadedPaths = []  // for rollback if any upload fails

    const attachmentRows = []
    for (let i = 0; i < photoFiles.length; i++) {
      const file = photoFiles[i]
      const attachmentId = crypto.randomUUID()
      const path = buildAttachmentPath({
        locationId,
        issueId,
        attachmentId,
        filename: file.name || `photo-${i}`,
      })
      const ab = await file.arrayBuffer()
      const { error: upErr } = await db.storage
        .from(STORAGE_BUCKET)
        .upload(path, Buffer.from(ab), {
          contentType: file.type || 'image/jpeg',
          upsert: false,
        })
      if (upErr) {
        // Roll back any prior successful uploads so we don't leave
        // orphan bytes in the bucket. Best-effort; storage delete
        // failures get logged but don't change the response.
        for (const p of uploadedPaths) {
          await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
        }
        return NextResponse.json(
          { success: false, error: `Photo ${i + 1} upload failed: ${upErr.message}`, code: 'photo_upload_failed' },
          { status: 500 }
        )
      }
      uploadedPaths.push(path)
      attachmentRows.push({
        // Note: we don't pass the pre-minted id — the DB will
        // generate one. The path already contains a unique segment
        // (the attachmentId we used) so the bucket browseability
        // story still works.
        storage_path: path,
        bucket:       STORAGE_BUCKET,
        size_bytes:   file.size,
        mime_type:    (file.type || 'image/jpeg').toLowerCase(),
      })
    }

    const out = await insertIssueWithAttachments(db, {
      locationId,
      submitterId: user.id,
      description: v.normalised.description,
      attachments: attachmentRows,
    })

    if (!out.ok) {
      // Roll back uploaded storage objects so we don't leak bytes
      // for a row that no longer exists.
      for (const p of uploadedPaths) {
        await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
      }
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'business',
      action: 'issue.submitted',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        id: out.issue.id,
        label: out.issue.description.slice(0, 80),
        resource: `issue/${out.issue.id}`,
      },
      locationId,
      details: {
        attachment_count: out.attachments.length,
      },
      request,
    })

    return NextResponse.json(
      { success: true, data: { ...out.issue, issue_attachments: out.attachments } },
      { status: 201 }
    )
  }
)

// ---- GET ----

export const GET = withAuth(
  {},
  async ({ user, db }) => {
    const rows = await listMyIssues(db, user.id)
    return NextResponse.json({ success: true, data: rows })
  }
)
