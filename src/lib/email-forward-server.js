// EMAIL-FORWARD.1 — server-side IO for the files a forward carries.
//
// Pure rules (which files may go, the ceiling, the sentences) live in
// ./email-forward.js. This module is the half that touches Storage and the
// database, and it is the exact counterpart of
// ./email-outbound-attachments-server.js — same two-phase shape, same
// governing rule, ONE difference that runs through everything below:
//
//   ══ THE BYTES ARE ALREADY OURS, AND WE DO NOT COPY THEM ══
//
// An outbound attachment starts as a draft object the browser uploaded and is
// MOVED to a canonical key on its way onto the thread. A forwarded attachment
// starts life already at a canonical key — the one the inbound webhook (or an
// earlier send) put it at — and it STAYS THERE. The forward's own row points
// at that same key.
//
// Copying instead would be paying twice for a byte-identical file that will
// always be pruned at the same moment as the original, because a forward is a
// message on the SAME ticket as the message it quotes. Sharing costs one
// column (`forwarded_from_id`, mig 501) and buys correctness in the three
// places that previously assumed one row = one object: the quota recalc, the
// prune's object removal, and the prune's decrement. See the migration for the
// full argument.
//
// ══ THE GOVERNING RULE, UNCHANGED ═══════════════════════════════════
// THE THREAD NEVER CLAIMS A FILE WENT OUT THAT DID NOT. The forward route
// sends before it writes, so everything that can refuse a file happens in
// collectForwardAttachments(), BEFORE the send:
//
//   • an object we cannot read      → 400, nothing sent, nothing written
//   • more raw bytes than Postmark takes → 400 naming the total, nothing sent
//
// After the send nothing can decide "this file is not going" — it has gone.
// fileForwardedAttachments() therefore never throws and never fails the
// response; the worst it can do is leave the studio's own copy of the thread
// without chips on a message that genuinely carried files.
//
// ══ QUOTA IS NOT CHARGED, AND THAT IS NOT AN OMISSION ═══════════════
// There is no add_email_storage_bytes() call anywhere in this file. A forward
// puts NO NEW BYTES in the bucket: the object it points at is already stored
// and already metered, against the same mailbox, by the row that owns it.
// Charging again would bill one file twice and could push a mailbox over its
// 5 GB ceiling for a file it already holds. mig 501's recalc excludes these
// rows for exactly the same reason, so the counter and its repair tool agree.

import { Buffer } from 'node:buffer'
import { EMAIL_ATTACHMENT_BUCKET, safeAttachmentFilename, safeMimeType } from './email-attachment-quota'
import { exceedsOutboundTotal } from './email-outbound-attachments'
import { forwardSizeError } from './email-forward'

const UNIQUE_VIOLATION = '23505'

/**
 * Read the chosen attachments back out of Storage and turn them into what
 * Postmark wants.
 *
 * RUNS BEFORE THE SEND. Every refusal it returns is a refusal to send at all.
 *
 * THE DOWNLOADED BUFFER'S LENGTH IS THE ONLY SIZE TRUSTED — not the
 * `size_bytes` on the row, which is what the composer budgets with but is a
 * number we wrote months ago and which a prune-then-restore or a botched
 * rehost could have left stale. Same rule collectOutboundAttachments() and
 * decodeAttachmentContent() apply, for the same reason: the figure decides
 * what Postmark is asked to carry.
 *
 * Never throws.
 *
 * @param {object} db  service-role client
 * @param {object} args
 * @param {object[]} args.rows  email_ticket_attachments rows, already resolved
 *   and order-fixed by selectForwardAttachments(); every one has a storage_path
 * @returns {Promise<{ok: true, postmark: Array|undefined, files: Array}
 *                  |{ok: false, error: string}>}
 *   `postmark` is undefined (not []) when nothing is carried, so a forward with
 *   no files produces a byte-identical sendEmail payload to a plain reply.
 */
export async function collectForwardAttachments(db, { rows } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return { ok: true, postmark: undefined, files: [] }

  const postmark = []
  const files = []
  let totalBytes = 0

  for (const row of list) {
    const path = row?.storage_path
    if (!path) {
      // Unreachable — selectForwardAttachments() refuses these — but a row with
      // no bytes must never reach a download call that would happily sign `null`.
      return {
        ok: false,
        error: `“${safeAttachmentFilename(row?.filename)}” has no stored copy, so it cannot be forwarded. ` +
          'Untick it and try again — nothing was sent.',
      }
    }

    const bytes = await downloadObject(db, path)
    if (!bytes) {
      // The object was pruned between the page load and the send, or a prune
      // removed it and the row was never marked. Either way the honest answer
      // is the same, and NOTHING HAS BEEN SENT at this point.
      return {
        ok: false,
        error: `“${safeAttachmentFilename(row.filename)}” could not be read — its stored copy is no longer ` +
          'there. Untick it and try again. Nothing was sent.',
      }
    }

    totalBytes += bytes.length
    if (exceedsOutboundTotal(totalBytes)) {
      return { ok: false, error: forwardSizeError(totalBytes) }
    }

    postmark.push({
      Name: safeAttachmentFilename(row.filename),
      Content: bytes.toString('base64'),
      ContentType: safeMimeType(row.mime_type),
    })
    files.push({
      // WHICH ROW OWNS THESE BYTES — and it is the OWNER, never the row we
      // happen to be reading.
      //
      // THE REFERENCE GRAPH IS FLATTENED HERE, AND THAT IS LOAD-BEARING.
      // Forwarding a forward is ordinary (the accountant's answer goes on to
      // the member's bank), and the row being forwarded is then itself a
      // reference. Pointing at it would build a chain owner → fwd1 → fwd2, and
      // the prune's cascade — which marks rows whose forwarded_from_id is IN
      // the pruned batch — is a single pass: pruning the owner would mark fwd1
      // and leave fwd2 pointing at bytes that are gone. Making the depth
      // always exactly one keeps that single pass complete BY CONSTRUCTION
      // rather than by a loop that has to be bounded and got right.
      //
      // `forwarded_from_id` is ON DELETE SET NULL, so a row whose owner has
      // gone reports itself as the owner — which is true: it is the only row
      // left addressing those bytes.
      sourceId: row.forwarded_from_id || row.id,
      storagePath: path,
      filename: safeAttachmentFilename(row.filename),
      mime: safeMimeType(row.mime_type),
      // The TRUE length, not row.size_bytes — see the docblock.
      sizeBytes: bytes.length,
    })
  }

  return { ok: true, postmark, files }
}

/**
 * One object's bytes, or null when there is nothing usable there.
 *
 * Never throws. Storage answers a missing key with an error rather than an
 * exception, but the Blob→ArrayBuffer hop can throw on a truncated body, and a
 * throw here would 500 a send route that has a much better answer available.
 * Same shape as the outbound module's own downloader; deliberately not shared,
 * because that one is about DRAFT keys and this one is about canonical ones,
 * and a single helper would invite a single path-building rule for two
 * different security stories.
 */
async function downloadObject(db, path) {
  try {
    const { data, error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).download(path)
    if (error || !data) {
      if (error) console.error('[email-forward] attachment download failed:', error.message)
      return null
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer())
    if (!bytes || bytes.length === 0) return null
    return bytes
  } catch (err) {
    console.error('[email-forward] attachment download threw:', err?.message)
    return null
  }
}

/**
 * Record the files a forward CARRIED, as rows that share the original's bytes.
 *
 * NEVER THROWS, NEVER FAILS THE RESPONSE. The email is already with the
 * recipient; the worst outcome here is the studio's own thread showing a
 * forward without chips.
 *
 * WHAT THESE ROWS ARE:
 *   • storage_path      — the ORIGINAL'S canonical key, unchanged. Nothing is
 *                         copied, moved or re-uploaded.
 *   • forwarded_from_id — the row that owns those bytes (mig 501).
 *   • size_bytes        — the true downloaded length, so the chip states the
 *                         size that actually went on the wire.
 *   • skipped_reason    — NULL. These files DID go out, and mig 482's
 *                         email_attach_stored_xor_skipped CHECK is satisfied by
 *                         storage_path being set.
 *
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO:
 *   • charge the quota — no new bytes exist. See the file header.
 *   • remove an object on failure — the OWNER still needs it. This is the one
 *     line where copying the outbound module verbatim would be a data-loss bug:
 *     fileOne() removes the object when its row insert fails, which is right
 *     when the row is the object's only reference and catastrophic when it is
 *     not.
 *
 * @returns {Promise<{recorded:number, failed:number}>} a summary for logging.
 *   No caller branches on it.
 */
export async function fileForwardedAttachments(db, {
  files, messageId, locationId, mailboxId = null, indexOffset = 0,
} = {}) {
  const summary = { recorded: 0, failed: 0 }
  if (!Array.isArray(files) || files.length === 0) return summary
  if (!messageId || !locationId) {
    console.error('[email-forward] refusing to file without messageId + locationId')
    return summary
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    try {
      const { error } = await db.from('email_ticket_attachments').insert({
        message_id: messageId,
        location_id: locationId,
        mailbox_id: mailboxId ?? null,
        attachment_index: indexOffset + i,
        filename: file.filename,
        mime_type: file.mime,
        size_bytes: Math.max(1, Math.round(file.sizeBytes)),
        // THE SHARED OBJECT. Not a copy, not a new key.
        storage_path: file.storagePath,
        skipped_reason: null,
        forwarded_from_id: file.sourceId || null,
      })
      if (!error) { summary.recorded += 1; continue }
      // UNIQUE (message_id, attachment_index). Unreachable — the message row is
      // freshly inserted and this loop is its only writer — but it is not a
      // reason to remove anything.
      if (error.code === UNIQUE_VIOLATION) {
        console.error('[email-forward] duplicate (message, index) filing a forwarded attachment', { messageId, index: indexOffset + i })
      } else {
        console.error('[email-forward] forwarded attachment insert failed:', error.message)
      }
      summary.failed += 1
    } catch (err) {
      console.error('[email-forward] forwarded attachment insert threw:', err?.message)
      summary.failed += 1
    }
  }

  return summary
}
