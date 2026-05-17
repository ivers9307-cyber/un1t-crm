// POST /api/cars/[id]/bca/submit
//
// The end-to-end submit: validate staging is complete, freeze the
// source files to a submission_id prefix, merge + compress into one
// PDF, email BCA via Postmark with cc, record the submission row,
// supersede any previous active submission.
//
// Resubmission is allowed and routine: every submit creates a new
// row; the *previous* active row gets `superseded_by` + `superseded_at`
// stamped on success. Failed submits don't supersede anything (the
// previous active claim remains current until a successful resubmit).
//
// Storage layout:
//   bca-documents/{location_id}/{car_id}/_staging/{slug}.{ext}     -- staged
//   bca-documents/{location_id}/{car_id}/{submission_id}/{slug}.{ext}  -- frozen at submit
//   bca-documents/{location_id}/{car_id}/{submission_id}/merged.pdf    -- what got emailed

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import {
  getBcaConfig,
  renderBcaTemplate,
  buildBcaDownloadUrl,
  appendBcaDownloadFooter,
  BCA_STORAGE,
  BCA_DOWNLOAD_WINDOW_DAYS,
} from '@/lib/bca'
import { mergeAndCompressBcaPack } from '@/lib/bca-merge'
import { getBcaBaseUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'
const POSTMARK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024  // 10 MB

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()

  // 1. Resolve car + location + config
  const { data: car, error: carErr } = await db
    .from('cars')
    .select('id, location_id, uk_reg, irish_reg, vin, make, model, vehicle_year, buyer_name, buyer_email, xero_invoice_number')
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
    return NextResponse.json({ success: false, error: 'BCA Submit is not enabled at this location' }, { status: 404 })
  }
  if (!config.send_from || !config.send_to) {
    return NextResponse.json({
      success: false,
      error: 'BCA Submit is enabled but the send-from / send-to addresses are not configured. Go to Settings → Locations → BCA Submit.',
    }, { status: 422 })
  }

  // 2. Validate all configured slots are staged
  const stagingPrefix = `${car.location_id}/${car.id}/_staging`
  const { data: files, error: listErr } = await db.storage
    .from(BCA_STORAGE.bucket)
    .list(stagingPrefix, { limit: 100 })
  if (listErr) {
    return NextResponse.json({ success: false, error: `Storage list failed: ${listErr.message}` }, { status: 500 })
  }
  const byName = new Map((files || []).map(f => [f.name, f]))
  const stagedSources = []
  const missing = []
  for (const doc of config.documents) {
    // Each slot may have any allowed extension; find the file
    // whose filename matches `{slug}.{ext}`.
    const match = [...byName.keys()].find(n => new RegExp(`^${doc.slug}\\.[a-zA-Z0-9]+$`).test(n))
    if (!match) {
      missing.push(doc.slug)
      continue
    }
    stagedSources.push({
      slug: doc.slug,
      label: doc.label,
      stagedName: match,
      stagedPath: `${stagingPrefix}/${match}`,
      stagedMetadata: byName.get(match)?.metadata || {},
    })
  }
  if (missing.length > 0) {
    return NextResponse.json({
      success: false,
      error: `Missing files in slots: ${missing.join(', ')}. Upload all ${config.documents.length} documents before submitting.`,
      missing_slugs: missing,
    }, { status: 422 })
  }

  // 3. Token for this submission attempt — used as the storage prefix
  // BEFORE we insert the submission row, so the merged-PDF path stamped
  // on the row is consistent with what's actually in storage.
  const submissionId = crypto.randomUUID()
  const submissionPrefix = `${car.location_id}/${car.id}/${submissionId}`

  // 4. Copy each staged file to the submission prefix + download into
  // memory for the merge step (one download per file; storage list
  // doesn't return content). Track input sizes for the audit row.
  const sourcesForMerge = []
  const documentsForRow = []
  for (const s of stagedSources) {
    const { data: blob, error: dlErr } = await db.storage
      .from(BCA_STORAGE.bucket)
      .download(s.stagedPath)
    if (dlErr || !blob) {
      return NextResponse.json({ success: false, error: `Download failed for ${s.slug}: ${dlErr?.message || 'unknown'}` }, { status: 500 })
    }
    const buffer = Buffer.from(await blob.arrayBuffer())
    const ext = s.stagedName.split('.').pop()
    const submissionPath = `${submissionPrefix}/${s.slug}.${ext}`
    const contentType = blob.type || s.stagedMetadata.mimetype || 'application/octet-stream'

    const { error: copyErr } = await db.storage
      .from(BCA_STORAGE.bucket)
      .upload(submissionPath, buffer, {
        contentType,
        upsert: false,  // submission prefix is fresh per-submit; should never collide
      })
    if (copyErr) {
      return NextResponse.json({ success: false, error: `Failed to freeze ${s.slug} to submission: ${copyErr.message}` }, { status: 500 })
    }

    sourcesForMerge.push({ slug: s.slug, label: s.label, buffer, contentType })
    documentsForRow.push({
      slug: s.slug,
      label: s.label,
      storage_path: submissionPath,
      filename: s.stagedMetadata.originalFilename || s.stagedName,
      size_bytes: buffer.length,
      content_type: contentType,
    })
  }

  // 5. Merge + compress into a single PDF
  let mergedPdf
  try {
    mergedPdf = await mergeAndCompressBcaPack(sourcesForMerge)
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'PDF merge failed' }, { status: 422 })
  }

  // 6. Size guard — Postmark caps attachments at 10 MB per email
  if (mergedPdf.length > POSTMARK_ATTACHMENT_MAX_BYTES) {
    return NextResponse.json({
      success: false,
      error:
        `Merged PDF is ${(mergedPdf.length / 1024 / 1024).toFixed(2)} MB — over Postmark's 10 MB cap. ` +
        `Reduce the size of the largest source doc(s) and resubmit. Per-slot input sizes: ` +
        documentsForRow.map(d => `${d.slug}=${(d.size_bytes / 1024).toFixed(0)} KB`).join(', '),
    }, { status: 422 })
  }

  // 7. Upload merged PDF to storage
  const mergedPath = BCA_STORAGE.mergedPdf(car.location_id, car.id, submissionId)
  const { error: mergedUploadErr } = await db.storage
    .from(BCA_STORAGE.bucket)
    .upload(mergedPath, mergedPdf, { contentType: 'application/pdf', upsert: false })
  if (mergedUploadErr) {
    return NextResponse.json({ success: false, error: `Failed to save merged PDF: ${mergedUploadErr.message}` }, { status: 500 })
  }

  // 8. Render email subject + body templates, then append the public
  // re-download link (60-day window per BCA.1 Phase 4 spec). Token
  // is URL-safe base64, ~190 bits of entropy — infeasible to guess.
  const downloadToken = crypto.randomBytes(24).toString('base64url')
  const downloadExpiresAt = new Date(Date.now() + BCA_DOWNLOAD_WINDOW_DAYS * 24 * 3600 * 1000).toISOString()
  let downloadUrl = null
  try {
    // getBcaBaseUrl prefers BCA_BASE_URL (e.g. https://ccfautos.com)
    // then DEPOSIT_BASE_URL (already CCFA-branded at pay.ccfautos.com
    // for the existing payment surface) then NEXT_PUBLIC_APP_URL.
    // Throws on no env set at all — submit still succeeds, just
    // without the footer.
    downloadUrl = buildBcaDownloadUrl(downloadToken, getBcaBaseUrl())
  } catch {
    downloadUrl = null
  }
  const subject = renderBcaTemplate(config.subject_template, car)
  const renderedBody = renderBcaTemplate(config.body_template, car)
  const body = downloadUrl ? appendBcaDownloadFooter(renderedBody, downloadUrl) : renderedBody

  // 9. Build the attachment filename — `BCA_<reg-or-vin>_<short>.pdf`,
  // safe for any email client (alphanumeric + dash + underscore).
  const idShort = submissionId.slice(0, 8)
  const regForName = (car.uk_reg || car.vin || 'unknown')
    .toString()
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 20) || 'unknown'
  const attachmentName = `BCA_${regForName}_${idShort}.pdf`

  // 10. INSERT submission row (without postmark_message_id yet — we
  // fill that in after the send succeeds. Failed sends keep the row
  // with postmark_error_code populated; the merged PDF in storage is
  // the audit trail even when the send was rejected).
  const insertPayload = {
    id: submissionId,
    car_id: car.id,
    location_id: car.location_id,
    email_from: config.send_from,
    email_to: config.send_to,
    email_subject: subject,
    email_body: body,
    documents: documentsForRow,
    merged_pdf_path: mergedPath,
    merged_pdf_size: mergedPdf.length,
    submitted_by: user.id,
    download_token: downloadToken,
    download_expires_at: downloadExpiresAt,
  }
  // Stash cc on the row even though the schema doesn't have a column
  // for it — append to email_body as the simplest audit shape v1.
  // (Future: add a dedicated email_cc column if we end up querying it.)
  if (config.cc) {
    insertPayload.email_body = `${body}\n\n---\nCC: ${config.cc}`
  }
  // We don't read this row back here — we re-fetch at the end of the
  // function once postmark_message_id is filled in. Just need the
  // insert side-effect + error check.
  const { error: insertErr } = await db
    .from('car_bca_submissions')
    .insert(insertPayload)
  if (insertErr) {
    return NextResponse.json({ success: false, error: `Failed to record submission: ${insertErr.message}` }, { status: 500 })
  }

  // 11. Call Postmark
  const postmarkToken = process.env.POSTMARK_API_KEY
  if (!postmarkToken) {
    await db.from('car_bca_submissions').update({
      postmark_error_code: 500,
      postmark_error_msg: 'POSTMARK_API_KEY env var not configured',
    }).eq('id', submissionId)
    return NextResponse.json({
      success: false,
      error: 'Email service is not configured (POSTMARK_API_KEY missing). Submission was saved but no email was sent.',
    }, { status: 500 })
  }

  const postmarkBody = {
    From: config.send_from,
    To: config.send_to,
    Subject: subject,
    TextBody: body,
    Attachments: [{
      Name: attachmentName,
      Content: mergedPdf.toString('base64'),
      ContentType: 'application/pdf',
    }],
    MessageStream: 'outbound',
    // Track opens (pixel) + link clicks so the operator sees on the
    // car detail page whether BCA actually engaged. Postmark fires
    // a separate webhook per event; the bca-submit-tagged events
    // get routed by postmark-webhook-processor.js into the
    // car_bca_submissions metric columns + events table.
    TrackOpens: true,
    TrackLinks: 'HtmlAndText',
    Tag: 'bca-submit',
    Metadata: {
      car_id: car.id,
      location_id: car.location_id,
      submission_id: submissionId,
    },
  }
  if (config.cc) postmarkBody.Cc = config.cc

  let postmarkResult
  try {
    const res = await fetch(`${POSTMARK_API_URL}/email`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': postmarkToken,
      },
      body: JSON.stringify(postmarkBody),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      await db.from('car_bca_submissions').update({
        postmark_error_code: json?.ErrorCode || res.status,
        postmark_error_msg: json?.Message || `HTTP ${res.status}`,
      }).eq('id', submissionId)
      return NextResponse.json({
        success: false,
        error: `Postmark rejected the email: ${json?.Message || `HTTP ${res.status}`}`,
        postmark_error_code: json?.ErrorCode || res.status,
        submission_id: submissionId,
      }, { status: 502 })
    }
    postmarkResult = json
  } catch (e) {
    await db.from('car_bca_submissions').update({
      postmark_error_code: 599,
      postmark_error_msg: e.message || 'Network error',
    }).eq('id', submissionId)
    return NextResponse.json({
      success: false,
      error: `Network error sending email: ${e.message || 'unknown'}`,
      submission_id: submissionId,
    }, { status: 502 })
  }

  // 12. Mark success on this row + supersede any previous active row
  const nowIso = new Date().toISOString()
  await db.from('car_bca_submissions').update({
    postmark_message_id: postmarkResult.MessageID,
  }).eq('id', submissionId)

  // Supersede any previous active (non-superseded, non-error) row for
  // this car. There should be at most one; we update by car_id +
  // active filter and skip the row we just inserted.
  await db.from('car_bca_submissions')
    .update({ superseded_by: submissionId, superseded_at: nowIso })
    .eq('car_id', car.id)
    .neq('id', submissionId)
    .is('superseded_at', null)
    .not('postmark_message_id', 'is', null)

  // 13. Return the final submission row (re-fetched to pick up the
  // message_id update + any column defaults).
  const { data: finalRow } = await db
    .from('car_bca_submissions')
    .select('*')
    .eq('id', submissionId)
    .single()

  return NextResponse.json({
    success: true,
    data: {
      submission: finalRow,
      postmark_message_id: postmarkResult.MessageID,
      attachment_name: attachmentName,
      attachment_size_bytes: mergedPdf.length,
    },
  })
}
