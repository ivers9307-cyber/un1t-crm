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
// the storage path. Only a row with attachment_path counts as stored. Any
// failure on the way returns ok: false (the webhook answers 500 and is
// retried), and the retry deletes a path-less row still in 'received' and
// redoes it.
//
// INVOICEPREP.2 — the shim in front of the webhook may have parked an
// attachment's bytes in Storage (staged-attachments.js). Those are read back
// here, except for attachments already stored: an earlier delivery may have
// removed their staged copy. Staged copies are removed only once the whole
// email is stored, so a retry always finds the ones it still needs. An
// attachment the shim could not move gets its own row ('-missing-<index>',
// never treated as a half-written row) so staff can ask for a resend.

import {
  classifyInboundAttachments,
  inboundBodyText,
  attachmentMessageId,
  sha256Hex,
  inboundInvoiceStoragePath,
  safeInboundFilename,
} from '@/lib/inbound-invoices'
import {
  INVOICE_STAGING_BUCKET,
  resolveInboundAttachments,
  removeStagedAttachments,
} from '@/lib/invoices-queue/staged-attachments'
import { stagedPathsIn } from '@/lib/email-attachment-staging'
import { logError } from '@/lib/log'

// Stored files and staged copies share the bucket, under different prefixes.
const BUCKET = INVOICE_STAGING_BUCKET

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {{ location: { id: string }, body: any }} input
 * @returns {Promise<
 *   { ok: true, created: string[], alreadyStored: number, skippedInline: number, notReceived: number }
 *   | { ok: false, error: 'insert_failed' | 'storage_upload_failed' | 'lookup_failed' | 'path_update_failed' | 'staged_download_failed' }
 * >}
 */
export async function ingestInboundEmail(db, { location, body }) {
  const messageId = body.MessageID
  /** @type {any[]} */
  const attachments = Array.isArray(body.Attachments) ? body.Attachments : []
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
  /** @param {number} index */
  const missingMessageId = (index) => `${messageId}-missing-${index}`

  // What this email has already stored, by per-attachment id.
  /** @type {string[]} */
  const ids = [messageId]
  for (let i = 0; i < attachments.length; i++) ids.push(attachmentMessageId(messageId, i), missingMessageId(i))
  const { data: existing, error: readErr } = await db
    .from('invoices_queue')
    .select('id, email_message_id, attachment_path, attachment_mime_type, attachment_size_bytes')
    .eq('location_id', location.id)
    .in('email_message_id', [...new Set(ids)])
  if (readErr) {
    logError('invoice-ingest', 'existing rows lookup failed', { err: readErr })
    return { ok: false, error: 'lookup_failed' }
  }
  const hadRows = (existing || []).length > 0
  const byMessageId = new Map((existing || []).map((r) => [r.email_message_id, r]))

  // Already stored: not read back again, and described to the classifier so
  // the logo rule judges the rest as the first delivery did.
  /** @type {Set<number>} */
  const storedIndexes = new Set()
  /** @type {Array<{ mime: string | null, sizeBytes: number | null, contentId: string | null }>} */
  const storedInfo = []
  for (let i = 0; i < attachments.length; i++) {
    const prior = byMessageId.get(attachmentMessageId(messageId, i))
    if (!prior?.attachment_path) continue
    storedIndexes.add(i)
    storedInfo.push({
      mime: prior.attachment_mime_type ?? null,
      sizeBytes: prior.attachment_size_bytes ?? null,
      contentId: attachments[i]?.ContentID ?? null,
    })
  }

  const resolved = await resolveInboundAttachments(db, body, { skipIndexes: storedIndexes })
  if (!resolved.ok) return { ok: false, error: 'staged_download_failed' }
  const { usable, skippedInline, unsupportedTypes } = classifyInboundAttachments(
    resolved.attachments, body.HtmlBody, { alreadyStored: storedInfo },
  )
  // The staged copies of already-stored attachments are spent too.
  const stagedPaths = [
    ...resolved.stagedPaths,
    ...stagedPathsIn(attachments.map((a, i) => (storedIndexes.has(i) ? a : null)), { postmarkMessageId: messageId }),
  ]

  /**
   * Every ok: true exit: the email is fully recorded, so its staged copies can go.
   * @param {string[]} created
   * @param {number} alreadyStored
   * @param {number} notReceived
   * @returns {Promise<{ ok: true, created: string[], alreadyStored: number, skippedInline: number, notReceived: number }>}
   */
  const succeed = async (created, alreadyStored, notReceived) => {
    await removeStagedAttachments(db, stagedPaths)
    return { ok: true, created, alreadyStored, skippedInline, notReceived }
  }

  if (usable.length === 0 && storedIndexes.size === 0 && resolved.failed.length === 0) {
    // Keep a row so staff can see the email arrived with nothing to ingest.
    if (byMessageId.has(messageId)) return succeed([], 0, 0)
    const reason = unsupportedTypes.length > 0 ? `unsupported_type: ${unsupportedTypes.join(', ')}` : 'no_attachment'
    const { data: row, error } = await db
      .from('invoices_queue')
      .insert({ ...common, email_message_id: messageId, not_invoice_reason: reason, skipped_attachment_count: skippedInline })
      .select('id')
      .single()
    if (error || !row) {
      if (error?.code === '23505') return succeed([], 0, 0)
      logError('invoice-ingest', 'empty-email row insert failed', { err: error })
      return { ok: false, error: 'insert_failed' }
    }
    return succeed([row.id], 0, 0)
  }

  /** @type {string[]} */
  const created = []
  let alreadyStored = storedIndexes.size
  for (const att of usable) {
    const emailMessageId = attachmentMessageId(messageId, att.index)
    const prior = byMessageId.get(emailMessageId)
    if (prior?.attachment_path) {
      alreadyStored++
      continue
    }
    if (prior) {
      // Inserted but never finished: clear it so the insert below can reuse the id.
      // Only while untouched: a row staff have already acted on is theirs, and
      // one a concurrent delivery finished since our read now has a path.
      const { data: removed, error: delErr } = await db
        .from('invoices_queue')
        .delete()
        .eq('id', prior.id)
        .eq('status', 'received')
        .is('attachment_path', null)
        .select('id')
      if (delErr) {
        logError('invoice-ingest', 'unfinished row cleanup failed', { err: delErr, rowId: prior.id })
        return { ok: false, error: 'insert_failed' }
      }
      if (!removed || removed.length === 0) {
        alreadyStored++
        continue
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

    const { data: updated, error: updErr } = await db
      .from('invoices_queue')
      .update({ attachment_path: storagePath })
      .eq('id', row.id)
      .select('id')
    // Zero rows is no error in supabase-js: another delivery removed the row.
    if (updErr || !updated || updated.length === 0) {
      // Without a path nobody can open the file, so fail and let the retry redo
      // this attachment. The row stays: the retry deletes and replaces it.
      logError('invoice-ingest', 'attachment_path update failed', { err: updErr, rowId: row.id })
      return { ok: false, error: 'path_update_failed' }
    }
    created.push(row.id)
  }

  // Attachments that arrived without their bytes. Their ids are a separate
  // family from attachmentMessageId, so the half-written-row cleanup above
  // never deletes one.
  let notReceived = 0
  for (const miss of resolved.failed) {
    const emailMessageId = missingMessageId(miss.index)
    if (byMessageId.has(emailMessageId)) continue
    const { error: missErr } = await db.from('invoices_queue').insert({
      ...common,
      email_message_id: emailMessageId,
      attachment_filename: safeInboundFilename(miss.name) || `attachment-${miss.index + 1}`,
      not_invoice_reason: `attachment_not_received: ${miss.reason}`,
    })
    if (missErr) {
      if (missErr.code === '23505') continue
      logError('invoice-ingest', 'not-received row insert failed', { err: missErr })
      return { ok: false, error: 'insert_failed' }
    }
    notReceived++
  }

  return succeed(created, alreadyStored, notReceived)
}
