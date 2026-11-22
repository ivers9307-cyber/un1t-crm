// RCOV.P2 — attach a manually-obtained receipt to a bank line. The
// document enters the PROVEN intake pipeline (invoices_queue,
// source_type supplier_email, status received → OCR → bookkeeper
// review → Xero push w/ attachment), content-hash deduped against
// every other source; the line flips to 'submitted' and its hunt
// flags are cleared (load-bearing — a queued line would wedge the
// weekly finalizer).
//
// INVOICEPREP.3 — a newly inserted row is handed to queueInvoicePreparation
// so it is read and checked on arrival, like every other arrival path. That
// call never fails the upload: the row is stored and a person can still read
// it. A deduped upload links to a row that was queued when it was created.
import { NextResponse } from 'next/server'
import { sniffReceiptMime } from '@/lib/card-receipts'
import { prepareManualUpload, findQueueRowByHash } from '@/lib/recon/manual-upload'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { queueInvoicePreparation } from '@/lib/invoices-queue/queue-preparation'
import { loadLineForCaller } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // mirrors the inbound-invoices cap
const ALLOWED_FROM = ['uncovered', 'not_found', 'needs_attention']
const BUCKET = 'inbound-invoices'

const MODULE = 'recon-coverage-upload'

// withAuth only signs the caller in; loadLineForCaller keeps the hand-written
// gate (accounting_hub 'Forbidden' 403, active-location 400, line scoped to the
// active studio, 404) exactly as the sibling line routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  const ctx = await loadLineForCaller(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, locationId, line } = ctx

  if (!ALLOWED_FROM.includes(line.status)) {
    return NextResponse.json(
      { success: false, error: `Cannot upload for a line in '${line.status}' state.` },
      { status: 409 }
    )
  }

  let form
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ success: false, error: 'Expected multipart form data.' }, { status: 400 })
  }
  const file = form.get('file')
  if (!file || typeof file.arrayBuffer !== 'function') {
    return NextResponse.json({ success: false, error: 'No file provided.' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ success: false, error: 'File too large (max 25 MB).' }, { status: 413 })
  }
  const bytes = Buffer.from(await file.arrayBuffer())
  const sniffed = sniffReceiptMime(bytes)
  if (!sniffed) {
    return NextResponse.json(
      { success: false, error: 'Only a PDF or photo (JPG, PNG, WebP, HEIC) is accepted.' },
      { status: 400 }
    )
  }

  const { contentHash, safeName } = prepareManualUpload({ bytes, filename: file.name })
  const nowIso = new Date().toISOString()

  let queueId
  let deduped = false
  try {
    const { existingId } = await findQueueRowByHash(db, contentHash, locationId)
    if (existingId) {
      // Same document already in the queue via ANY source — link the
      // line to it rather than creating a duplicate.
      queueId = existingId
      deduped = true
    } else {
      const path = `${locationId}/manual-${line.id}/${Date.now()}-${safeName}`
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, {
        contentType: sniffed,
        upsert: false,
      })
      if (upErr) {
        logError(MODULE, 'storage upload failed', { lineId: line.id, err: upErr.message })
        return NextResponse.json({ success: false, error: 'Upload failed.' }, { status: 502 })
      }
      const { data: inserted, error: insErr } = await db
        .from('invoices_queue')
        .insert({
          location_id: locationId,
          source_type: 'supplier_email',
          attachment_bucket: BUCKET,
          attachment_path: path,
          attachment_filename: safeName,
          attachment_size_bytes: bytes.length,
          attachment_mime_type: sniffed,
          sender_email: user.email || null,
          subject: `Manual upload — ${line.description || `bank line ${line.id}`}`.slice(0, 200),
          status: 'received',
          content_hash: contentHash,
        })
        .select('id')
        .single()
      if (insErr) {
        logError(MODULE, 'queue insert failed', { lineId: line.id, code: insErr.code || null, err: insErr.message })
        return NextResponse.json({ success: false, error: 'Queue insert failed.' }, { status: 500 })
      }
      queueId = inserted.id
      try {
        await queueInvoicePreparation(db, [queueId])
      } catch (err) {
        logError(MODULE, 'could not queue the upload for preparation', { lineId: line.id, queueId, err: err?.message || String(err) })
      }
    }

    const { error: linkErr } = await db
      .from('recon_bank_lines')
      .update({
        status: 'submitted',
        invoices_queue_id: queueId,
        hunt_queued_at: null,
        hunt_claimed_at: null,
        updated_at: nowIso,
      })
      .eq('id', line.id)
    if (linkErr) {
      logError(MODULE, 'line link failed', { lineId: line.id, code: linkErr.code || null, err: linkErr.message })
      return NextResponse.json({ success: false, error: 'Line link failed.' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { queueId, deduped } })
  } catch (e) {
    logError(MODULE, 'upload failed', { lineId: line.id, err: e?.message || String(e) })
    return NextResponse.json({ success: false, error: 'Upload failed.' }, { status: 500 })
  }
})
