// @ts-check
// INVOICEPREP.2 — read the attachments an inbound email's shim parked in Storage.
//
// The Edge Function in front of the webhook moves big attachment bytes into the
// `inbound-invoices` bucket and leaves a marker behind. This turns the payload
// back into attachments that carry their bytes. The path check lives in
// readStagedMarker; nothing is downloaded that it did not return as 'staged'.

import { readStagedMarker } from '@/lib/email-attachment-staging'
import { logError, logWarn } from '@/lib/log'

export const INVOICE_STAGING_BUCKET = 'inbound-invoices'

// The type checker here has no Node typings; Buffer is a global at runtime.
const NodeBuffer = /** @type {any} */ (globalThis).Buffer

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {any} body the email payload
 * @param {{ skipIndexes?: Set<number> }} [options] original indexes to leave out entirely
 * @returns {Promise<
 *   | { ok: true, attachments: Array<any>, failed: Array<{ index: number, name: string, reason: string }>, stagedPaths: string[] }
 *   | { ok: false, error: 'staged_download_failed' }
 * >}
 */
export async function resolveInboundAttachments(db, body, options = {}) {
  const skip = options.skipIndexes
  const source = Array.isArray(body?.Attachments) ? body.Attachments : []
  const postmarkMessageId = body?.MessageID

  /** @type {Array<any>} */
  const attachments = []
  /** @type {Array<{ index: number, name: string, reason: string }>} */
  const failed = []
  /** @type {string[]} */
  const stagedPaths = []

  for (let index = 0; index < source.length; index += 1) {
    const attachment = source[index]
    // Position is the attachment's identity downstream, so a gap stays a gap.
    attachments.push(null)
    if (!attachment || (skip && skip.has(index))) continue

    const name =
      typeof attachment.Name === 'string' && attachment.Name !== ''
        ? attachment.Name
        : `attachment-${index + 1}`
    const marker = readStagedMarker(attachment, { postmarkMessageId, index })

    if (marker.kind === 'inline') {
      attachments[index] = attachment
      continue
    }
    if (marker.kind === 'skip') {
      failed.push({ index, name, reason: marker.reason })
      continue
    }

    // One at a time: a file can be 25 MB and several in flight would not fit.
    const { data, error } = await db.storage.from(INVOICE_STAGING_BUCKET).download(marker.path)
    if (error || !data) {
      logError('invoice-staged', 'staged download failed', { err: error, path: marker.path })
      return { ok: false, error: 'staged_download_failed' }
    }
    const bytes = NodeBuffer.from(await data.arrayBuffer())
    if (bytes.length !== marker.sizeBytes) {
      logWarn('invoice-staged', 'staged size mismatch', {
        path: marker.path,
        expected: marker.sizeBytes,
        actual: bytes.length,
      })
      failed.push({ index, name, reason: 'rehost_failed' })
      continue
    }

    const { _un1t_staged: _marker, ...rest } = attachment
    attachments[index] = { ...rest, Content: '', bytes }
    stagedPaths.push(marker.path)
  }

  return { ok: true, attachments, failed, stagedPaths }
}

/**
 * Best effort: a leftover file costs storage, a thrown error would fail a
 * delivery that already succeeded.
 *
 * @param {import('@/lib/supabase').Db} db
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
export async function removeStagedAttachments(db, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return
  try {
    const { error } = await db.storage.from(INVOICE_STAGING_BUCKET).remove(paths)
    if (error) logWarn('invoice-staged', 'staged remove failed', { err: error, count: paths.length })
  } catch (err) {
    logWarn('invoice-staged', 'staged remove threw', { err, count: paths.length })
  }
}
