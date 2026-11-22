// @ts-check
// INVOICEPREP.1 — store a forwarded supplier email's attachments, once.
//
// The provider retries a delivery after any failure, so this must be safe to
// run again on the same email: an attachment already stored is left alone, one
// that never finished is redone, and a retry never adds a duplicate row.
// Each attachment has its own email_message_id (attachmentMessageId), which is
// what makes "already stored?" a lookup.
//
// Order per attachment is insert, upload, path update: the row id is part of
// the storage path. A failed upload deletes its own row so a retry does not
// mistake it for stored.

import {
  classifyInboundAttachments,
  inboundBodyText,
  attachmentMessageId,
  sha256Hex,
  inboundInvoiceStoragePath,
  safeInboundFilename,
} from '@/lib/inbound-invoices'
import { logWarn, logError } from '@/lib/log'

const BUCKET = 'inbound-invoices'

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {{ location: { id: string }, body: any }} input
 * @returns {Promise<
 *   { ok: true, created: string[], alreadyStored: number, skippedInline: number }
 *   | { ok: false, error: 'insert_failed' | 'storage_upload_failed' | 'lookup_failed' }
 * >}
 */
export async function ingestInboundEmail(db, { location, body }) {
  const messageId = body.MessageID
  const attachments = Array.isArray(body.Attachments) ? body.Attachments : []
  const { usable, skippedInline, unsupportedTypes } = classifyInboundAttachments(attachments, body.HtmlBody)
  const emailBodyText = inboundBodyText(body)
  const common = {
    location_id: location.id,
    sender_email: body.FromFull?.Email || body.From || null,
    subject: body.Subject || null,
    status: 'received',
    source_type: 'supplier_email',
    attachment_bucket: BUCKET,
    email_body_text: emailBodyText,
  }

  // What this email has already stored, by per-attachment id.
  /** @type {string[]} */
  const ids = [messageId]
  for (let i = 0; i < attachments.length; i++) ids.push(attachmentMessageId(messageId, i))
  const { data: existing, error: readErr } = await db
    .from('invoices_queue')
    .select('id, email_message_id, attachment_path')
    .eq('location_id', location.id)
    .in('email_message_id', [...new Set(ids)])
  if (readErr) {
    logError('invoice-ingest', 'existing rows lookup failed', { err: readErr })
    return { ok: false, error: 'lookup_failed' }
  }
  const hadRows = (existing || []).length > 0
  const byMessageId = new Map((existing || []).map((r) => [r.email_message_id, r]))

  if (usable.length === 0) {
    // Keep a row so staff can see the email arrived with nothing to ingest.
    if (byMessageId.has(messageId)) return { ok: true, created: [], alreadyStored: 0, skippedInline }
    const reason = unsupportedTypes.length > 0 ? `unsupported_type: ${unsupportedTypes.join(', ')}` : 'no_attachment'
    const { data: row, error } = await db
      .from('invoices_queue')
      .insert({ ...common, email_message_id: messageId, not_invoice_reason: reason, skipped_attachment_count: skippedInline })
      .select('id')
      .single()
    if (error || !row) {
      if (error?.code === '23505') return { ok: true, created: [], alreadyStored: 0, skippedInline }
      logError('invoice-ingest', 'empty-email row insert failed', { err: error })
      return { ok: false, error: 'insert_failed' }
    }
    return { ok: true, created: [row.id], alreadyStored: 0, skippedInline }
  }

  /** @type {string[]} */
  const created = []
  let alreadyStored = 0
  for (const att of usable) {
    const emailMessageId = attachmentMessageId(messageId, att.index)
    const prior = byMessageId.get(emailMessageId)
    if (prior?.attachment_path) {
      alreadyStored++
      continue
    }
    if (prior) {
      // Inserted but never uploaded: clear it so the insert below can reuse the id.
      const { error: delErr } = await db.from('invoices_queue').delete().eq('id', prior.id)
      if (delErr) {
        logError('invoice-ingest', 'unfinished row cleanup failed', { err: delErr, rowId: prior.id })
        return { ok: false, error: 'insert_failed' }
      }
    }

    const filename = safeInboundFilename(att.name) || `attachment-${att.index + 1}`
    const { data: row, error: insErr } = await db
      .from('invoices_queue')
      .insert({
        ...common,
        email_message_id: emailMessageId,
        attachment_filename: filename,
        attachment_size_bytes: att.bytes.length,
        attachment_mime_type: att.mime,
        content_hash: sha256Hex(att.bytes),
        // Once per email: only the first row of the first attempt, so a retry
        // after a partial failure does not count the logos twice.
        ...(created.length === 0 && !hadRows ? { skipped_attachment_count: skippedInline } : {}),
      })
      .select('id')
      .single()
    if (insErr || !row) {
      // Another delivery stored this attachment between our read and now.
      if (insErr?.code === '23505') {
        alreadyStored++
        continue
      }
      logError('invoice-ingest', 'row insert failed', { err: insErr })
      return { ok: false, error: 'insert_failed' }
    }

    const storagePath = inboundInvoiceStoragePath({ locationId: location.id, invoiceId: row.id, safeFilename: filename })
    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(storagePath, att.bytes, { contentType: att.mime, upsert: false })
    if (upErr) {
      logError('invoice-ingest', 'storage upload failed', { err: upErr })
      const { error: rollbackErr } = await db.from('invoices_queue').delete().eq('id', row.id)
      if (rollbackErr) logError('invoice-ingest', 'row rollback failed', { err: rollbackErr, rowId: row.id })
      return { ok: false, error: 'storage_upload_failed' }
    }

    const { error: updErr } = await db.from('invoices_queue').update({ attachment_path: storagePath }).eq('id', row.id)
    if (updErr) {
      // The file is uploaded; keep the row so staff can recover it from the inbox.
      logWarn('invoice-ingest', 'attachment_path update failed', { err: updErr, rowId: row.id })
    }
    created.push(row.id)
  }

  return { ok: true, created, alreadyStored, skippedInline }
}
