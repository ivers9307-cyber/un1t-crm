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
  validatePhotos,
  isIssuePhotoPath,
  MAX_PHOTOS_PER_ISSUE,
} from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'
// REPORT-ISSUE.2 — handler notification on submit. Best-effort.
import { sendPushToRolesAtLocation } from '@/lib/push'
import { logWarn } from '@/lib/log'

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

    // REPORT-ISSUE.3 — two body shapes reach this route:
    //   JSON       the current app. The photos are already in the bucket:
    //              /api/issues/upload-sign minted a slot per photo and the
    //              device uploaded the bytes straight to Storage, so the
    //              body carries paths, not files.
    //   multipart  the bundle shipped before that OTA, which posts the
    //              photo bytes inline. Kept working on purpose — a phone
    //              that has not taken the update must still be able to
    //              report a problem.
    // Photo submits on the multipart path have not reached this route from
    // a device since the SDK 57 upgrade (the request dies on the phone), so
    // treat that branch as legacy: text-only is what still flows through it.
    const isJsonMode = (request.headers.get('content-type') || '').includes('application/json')

    let description = ''
    let photoMeta = []      // { filename, size, type } — what gets validated
    let jsonPhotos = []     // JSON mode: { path, name, size, mime }
    let photoFiles = []     // multipart mode: the inline File objects

    if (isJsonMode) {
      let body
      try { body = await request.json() }
      catch {
        return NextResponse.json(
          { success: false, error: 'Expected a JSON body.' },
          { status: 400 }
        )
      }
      description = String(body?.description || '')
      // One past the cap, so four photos are REFUSED rather than quietly
      // truncated to three.
      const raw = Array.isArray(body?.photos)
        ? body.photos.slice(0, MAX_PHOTOS_PER_ISSUE + 1)
        : []
      jsonPhotos = raw.map((p) => ({
        path: String(p?.path || ''),
        name: String(p?.file_name || 'photo.jpg'),
        size: Number(p?.size),
        mime: String(p?.mime || '').toLowerCase(),
      }))
      photoMeta = jsonPhotos.map((p) => ({ filename: p.name, size: p.size, type: p.mime }))
    } else {
      let form
      try { form = await request.formData() }
      catch {
        return NextResponse.json(
          { success: false, error: 'Expected multipart/form-data.' },
          { status: 400 }
        )
      }

      description = String(form.get('description') || '')
      // Photos come in as numbered keys: photo_0, photo_1, photo_2.
      // Keeps ordering deterministic across the network and means we
      // don't depend on FormData.getAll() ordering across runtimes.
      for (let i = 0; i < 3; i++) {
        const f = form.get(`photo_${i}`)
        if (f && typeof f === 'object' && 'size' in f && f.size > 0) {
          photoFiles.push(f)
        }
      }

      // Pure validation — description + file metadata only. The bytes
      // get sniffed by Supabase storage on upload.
      photoMeta = photoFiles.map((f) => ({
        filename: f.name || 'photo',
        size: f.size,
        type: (f.type || '').toLowerCase(),
      }))
    }

    const v = validateSubmission({ description, photos: photoMeta })
    if (!v.ok) {
      return NextResponse.json(
        { success: false, error: v.error, code: v.code },
        { status: 400 }
      )
    }

    // Storage objects this request is responsible for — uploaded inline
    // (multipart) or uploaded by the device against a slot we minted
    // (JSON). Either way they get removed if the row never lands.
    const uploadedPaths = []
    const attachmentRows = []

    if (isJsonMode) {
      // Every path must be one WE minted, for THIS location. The bucket is
      // private and both id segments are random, so a path can't be
      // guessed — but it could be replayed, hence the claim check below.
      for (let i = 0; i < jsonPhotos.length; i++) {
        if (!isIssuePhotoPath(jsonPhotos[i].path, locationId)) {
          return NextResponse.json(
            { success: false, error: `Photo ${i + 1} is not an upload slot for this studio.`, code: 'photo_bad_path' },
            { status: 400 }
          )
        }
      }

      // One object, two attachment rows is not a submission we can make
      // sense of — refuse it here rather than letting the insert decide.
      if (new Set(jsonPhotos.map((p) => p.path)).size !== jsonPhotos.length) {
        return NextResponse.json(
          { success: false, error: 'The same photo was attached twice.', code: 'photo_duplicate' },
          { status: 400 }
        )
      }

      if (jsonPhotos.length > 0) {
        const { data: claimed, error: claimErr } = await db
          .from('issue_attachments')
          .select('id')
          .in('storage_path', jsonPhotos.map((p) => p.path))
          .limit(1)
        if (claimErr) {
          return NextResponse.json(
            { success: false, error: `Could not verify the photos: ${claimErr.message}` },
            { status: 500 }
          )
        }
        if (claimed && claimed.length > 0) {
          return NextResponse.json(
            { success: false, error: 'Those photos already belong to a report — attach them again.', code: 'photo_already_used' },
            { status: 400 }
          )
        }
      }

      for (let i = 0; i < jsonPhotos.length; i++) {
        const photo = jsonPhotos[i]
        const parts = photo.path.split('/')
        const name = parts.pop()
        const { data: listed, error: listErr } = await db.storage
          .from(STORAGE_BUCKET)
          .list(parts.join('/'), { search: name })
        if (listErr) {
          return NextResponse.json(
            { success: false, error: `Could not verify photo ${i + 1}: ${listErr.message}` },
            { status: 500 }
          )
        }
        const hit = (listed || []).find((o) => o.name === name)
        if (!hit) {
          return NextResponse.json(
            { success: false, error: `Photo ${i + 1} did not finish uploading — attach it again.`, code: 'photo_missing' },
            { status: 400 }
          )
        }

        // Size and type come from what Storage actually holds. The
        // client's numbers were only ever a hint for the sign step —
        // anyone can post any JSON they like at this route.
        const storedSize = Number(hit.metadata?.size)
        const storedMime = String(hit.metadata?.mimetype || photo.mime || '').toLowerCase()
        const stored = validatePhotos([{ filename: name, size: storedSize, type: storedMime }])
        if (!stored.ok) {
          await db.storage.from(STORAGE_BUCKET).remove([photo.path]).then(() => {}, () => {})
          return NextResponse.json(
            { success: false, error: stored.error, code: stored.code },
            { status: 400 }
          )
        }

        uploadedPaths.push(photo.path)
        attachmentRows.push({
          storage_path: photo.path,
          bucket:       STORAGE_BUCKET,
          size_bytes:   storedSize,
          mime_type:    storedMime,
        })
      }
    } else {
      // Mint the issue id upfront so we can namespace the storage
      // path by issue_id without a round-trip. Same trick the FTE
      // expense route uses (it round-trips because that pattern
      // pre-dates this one — we improve here).
      const issueId = crypto.randomUUID()
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
        label: out.issue.description.slice(0, 80),
        resource: `issue/${out.issue.id}`,
      },
      locationId,
      details: {
        attachment_count: out.attachments.length,
      },
      request,
    })

    // REPORT-ISSUE.2 — fan out a push to handlers at the location
    // (owner + master). push.js honours per-user
    // notify_issue_submitted opt-out automatically. Fire-and-
    // forget; push delivery failure must never block the submitter.
    const preview = (v.normalised.description || '').slice(0, 180)
    sendPushToRolesAtLocation(
      locationId,
      ['owner', 'master'],
      {
        title: 'Issue reported',
        body: `${user.full_name || 'Someone'}: ${preview}`,
        category: 'issue_submitted',
        data: { type: 'issue_submitted', issue_id: out.issue.id, location_id: locationId },
      }
    ).catch((e) => logWarn('issues-submit', 'push failed', { err: e?.message }))

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
