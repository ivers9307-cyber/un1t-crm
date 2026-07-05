// RCOV.P2 — attach a manually-obtained receipt to a bank line. The
// document enters the PROVEN intake pipeline (invoices_queue,
// source_type supplier_email, status received → OCR → bookkeeper
// review → Xero push w/ attachment), content-hash deduped against
// every other source; the line flips to 'submitted' and its hunt
// flags are cleared (load-bearing — a queued line would wedge the
// weekly finalizer).
import { NextResponse } from 'next/server'
import { sniffReceiptMime } from '@/lib/card-receipts'
import { prepareManualUpload, findQueueRowByHash } from '@/lib/recon/manual-upload'
import { loadLineForUser } from '../_line'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // mirrors the inbound-invoices cap
const ALLOWED_FROM = ['uncovered', 'not_found', 'needs_attention']
const BUCKET = 'inbound-invoices'

export async function POST(request, { params }) {
  const { id } = await params
  const ctx = await loadLineForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, locationId, line } = ctx

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
    const { existingId } = await findQueueRowByHash(db, contentHash)
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
        return NextResponse.json({ success: false, error: `Upload failed: ${upErr.message}` }, { status: 502 })
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
        return NextResponse.json({ success: false, error: `Queue insert failed: ${insErr.message}` }, { status: 500 })
      }
      queueId = inserted.id
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
      return NextResponse.json({ success: false, error: `Line link failed: ${linkErr.message}` }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { queueId, deduped } })
  } catch (e) {
    console.error('[coverage/upload]', e)
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
