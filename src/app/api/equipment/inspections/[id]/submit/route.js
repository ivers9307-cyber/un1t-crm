// EQUIP-MAINT.2 — submit a completed inspection.
//
// ORDERING IS LOAD-BEARING. Create the issue (with its photos) FIRST,
// then mark the inspection submitted and roll the asset forward. If
// the issue insert fails the inspection stays 'draft' and nothing
// advances, so the inspector retries with their ticks intact.
// unique (equipment_id, due_on) stops a retry double-advancing.
//
// Photos upload only here, never on the draft: the bucket path is
// {location_id}/{issue_id}/… so no valid path exists until the issue
// does. That means no temp storage and no orphan-byte cleanup job.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getInspection, updateInspection, updateEquipment } from '@/lib/equipment-db'
import {
  validateResults, buildIssueDescription, rollForward, EQUIPMENT_STATUS,
} from '@/lib/equipment'
import {
  insertIssueWithAttachments, buildAttachmentPath, validateSubmission,
  MAX_PHOTOS_PER_ISSUE,
} from '@/lib/issues'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 3 x 10MB over 4G blows the 30s default — same headroom as the
// issues POST route.
export const maxDuration = 60

const STORAGE_BUCKET = 'issue-photos'

export const POST = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, user, locationId, params, request }) => {
    const inspection = await getInspection(db, params?.id)
    if (!inspection || inspection.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (inspection.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: 'This inspection has already been submitted.' },
        { status: 409 }
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

    const takeOutOfService = String(form.get('takeOutOfService') || '') === 'true'
    const extraNote = String(form.get('note') || '')

    // Results come from the client as JSON so the whole run submits
    // atomically even if individual ticks were lost to a flaky
    // connection.
    let results
    try { results = JSON.parse(String(form.get('results') || '{}')) }
    catch {
      return NextResponse.json({ success: false, error: 'Malformed results.' }, { status: 400 })
    }

    const check = validateResults({ items: inspection.items, results })
    if (!check.ok) {
      return NextResponse.json(
        { success: false, error: check.error, ...(check.missing ? { missing: check.missing } : {}) },
        { status: 400 }
      )
    }

    const asset = inspection.equipment
    const type = inspection.equipment_types

    // Compute the next due date BEFORE any write, so an invalid
    // interval fails the request cleanly instead of half-way through.
    let nextDueOn
    try {
      nextDueOn = rollForward({
        dueOn: inspection.due_on,
        intervalWeeks: type?.interval_weeks,
        today: dublinTodayStr(),
      })
    } catch (err) {
      if (err instanceof RangeError) {
        return NextResponse.json(
          {
            success: false,
            error: 'This equipment type has an invalid inspection interval — fix it in Equipment setup.',
          },
          { status: 400 }
        )
      }
      throw err
    }

    // ---- faults: photos, then the issue --------------------------
    let issueId = null
    if (check.failed.length > 0) {
      const photoFiles = []
      for (let i = 0; i < MAX_PHOTOS_PER_ISSUE; i++) {
        const f = form.get(`photo_${i}`)
        if (f && typeof f === 'object' && 'size' in f && f.size > 0) photoFiles.push(f)
      }

      const description = buildIssueDescription({
        equipmentName: asset?.name || 'Equipment',
        typeName: type?.name || 'Unknown type',
        dueOn: inspection.due_on,
        failed: check.failed,
        extraNote,
      })

      const v = validateSubmission({
        description,
        photos: photoFiles.map((f) => ({
          filename: f.name || 'photo', size: f.size, type: (f.type || '').toLowerCase(),
        })),
      })
      if (!v.ok) {
        return NextResponse.json({ success: false, error: v.error, code: v.code }, { status: 400 })
      }

      const newIssueId = crypto.randomUUID()
      const uploadedPaths = []
      const attachments = []
      for (let i = 0; i < photoFiles.length; i++) {
        const file = photoFiles[i]
        const path = buildAttachmentPath({
          locationId,
          issueId: newIssueId,
          attachmentId: crypto.randomUUID(),
          filename: file.name || `photo-${i}`,
        })
        const ab = await file.arrayBuffer()
        const { error: upErr } = await db.storage
          .from(STORAGE_BUCKET)
          .upload(path, Buffer.from(ab), { contentType: file.type || 'image/jpeg', upsert: false })
        if (upErr) {
          for (const p of uploadedPaths) {
            await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
          }
          return NextResponse.json(
            { success: false, error: `Photo ${i + 1} upload failed.`, code: 'photo_upload_failed' },
            { status: 500 }
          )
        }
        uploadedPaths.push(path)
        attachments.push({
          storage_path: path, bucket: STORAGE_BUCKET,
          size_bytes: file.size, mime_type: (file.type || 'image/jpeg').toLowerCase(),
        })
      }

      const out = await insertIssueWithAttachments(db, {
        locationId,
        submitterId: user.id,
        description: v.normalised.description,
        attachments,
        equipmentId: asset?.id,
      })
      if (!out.ok) {
        for (const p of uploadedPaths) {
          await db.storage.from(STORAGE_BUCKET).remove([p]).catch(() => {})
        }
        // Inspection stays 'draft' — the inspector keeps their ticks
        // and can retry.
        return NextResponse.json({ success: false, error: out.error }, { status: out.status || 500 })
      }
      issueId = out.issue.id

      // The owner notification rides the EXISTING issues push — no new
      // category. Best-effort: never block the response.
      try {
        await sendPushToRolesAtLocation(locationId, ['owner', 'master'], {
          title: 'Equipment fault reported',
          body: `${asset?.name || 'Equipment'} failed inspection.`,
          data: { type: 'issue', issueId },
          category: 'notify_issue_submitted',
        })
      } catch (err) {
        logWarn('equipment', 'fault push failed', { issueId, error: err.message })
      }
    }

    // ---- now commit the inspection + the asset --------------------
    const submitted = await updateInspection(db, inspection.id, {
      results,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      inspector_id: user.id,
      issue_id: issueId,
    })

    const assetPatch = {
      last_inspected_on: dublinTodayStr(),
      next_due_on: nextDueOn,
    }
    if (takeOutOfService && issueId) {
      assetPatch.status = EQUIPMENT_STATUS.OUT_OF_SERVICE
      assetPatch.out_of_service_issue_id = issueId
    }
    await updateEquipment(db, asset.id, assetPatch)

    await logAuditEvent({
      category: 'business',
      action: 'equipment.inspection_submitted',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset?.name, resource: `equipment/${asset?.id}` },
      locationId,
      details: {
        inspection_id: submitted.id,
        due_on: inspection.due_on,
        failed_count: check.failed.length,
        issue_id: issueId,
        out_of_service: Boolean(assetPatch.status),
        next_due_on: nextDueOn,
      },
    })

    return NextResponse.json({
      success: true,
      data: { inspection: submitted, issueId, nextDueOn, outOfService: Boolean(assetPatch.status) },
    })
  }
)
