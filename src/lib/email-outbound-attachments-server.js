// EMAIL-OUTBOUND-ATTACH.1 — server-side IO for attachments STAFF send.
//
// Pure rules (the key, the ceiling, the sentences) live in
// ./email-outbound-attachments.js; this module is the part that touches Storage
// and the database. It is the ONLY place the two ticket send routes learn
// anything about attachments — both call collectOutboundAttachments() before
// they send and fileOutboundAttachments() after they write, and neither knows
// what a bucket is. That split is deliberate: a recipients feature (multiple
// To/Cc/Bcc) is landing on the same two handlers, and this file is where the
// merge should NOT have to happen.
//
// ══ THE GOVERNING RULE, WHICH IS THE INVERSE OF INBOUND ═════════════
// Inbound's rule is THE MESSAGE IS FILED NO MATTER WHAT — a file that cannot be
// stored still produces a row, because the alternative is losing evidence a
// member sent something.
//
// Outbound's rule is THE THREAD NEVER CLAIMS A FILE WENT OUT THAT DID NOT.
// Both routes already SEND BEFORE THEY WRITE, so everything that can refuse an
// attachment happens BEFORE the send:
//
//   • a draft we cannot read           → 400, nothing sent, nothing written
//   • more raw bytes than Postmark takes → 400 naming the limit, nothing sent
//   • a duplicate or malformed slot    → 400, nothing sent
//
// After the send there is nothing left that can decide "this file is not going"
// — it has already gone. What remains is bookkeeping (does the studio KEEP a
// copy, and whose quota pays), and that is the only thing fileOutboundAttachments
// can get wrong. It therefore never throws and never fails the response: the
// email genuinely reached the member, and refusing the response over a storage
// counter would tell an operator to resend mail that already went.
//
// ══ WHERE THE BYTES GO, AND WHY THEY MOVE ═══════════════════════════
// A draft sits at `outbound/<profile_id>/<draft_id>/<index>.<ext>` from the
// moment the browser uploads it until the message row exists. Once it does, the
// object is MOVED to the canonical `<location_id>/<message_id>/<index>.<ext>` —
// the same key an inline-path inbound attachment gets — and the row points
// there.
//
// The inbound shim deliberately does NOT copy its staged objects, and the
// reasoning there ("nothing in this system derives an object's address from a
// prefix, so a differently-shaped key escapes no cleanup and no access control")
// is still true. Two things make the move worth it here anyway:
//
//   1. IT CONSUMES THE DRAFT. A draft key is a function of (profile, draft,
//      index) — all client-supplied but for the profile — so without the move
//      the same draft could be attached to two different sends, leaving two
//      rows pointing at one object. Pruning either would then take the other's
//      bytes with it. After the move the second attempt simply cannot read the
//      draft and is refused before anything is sent.
//   2. ITS FAILURE BRANCH HAS A GOOD ANSWER, which the shim's did not: keep the
//      draft key on the row. The bytes are there, the row addresses them, the
//      download route signs whatever storage_path says, and prune removes
//      whatever storage_path says. Nothing is lost — the object simply stays in
//      the drafts half of the bucket.
//
// ══ QUOTA IS CHARGED THROUGH THE ONE EXISTING PATH ══════════════════
// add_email_storage_bytes (mig 496) via addStorageBytes() in
// email-attachments-server.js — reserve, read the post-increment total, judge
// it with exceedsQuota(), release on refusal. There is no second accounting
// path and no second definition of "full". A sent attachment costs the same
// 5 GB-per-mailbox budget a received one does, because it is the same bucket
// and the same bytes.
//
// A refusal here does NOT unsend anything: the file left with the email. The
// row is written with skipped_reason 'quota', so the thread says
// "invoice.pdf — Not stored, mailbox was full" — true in every particular. The
// member has the file; the studio chose not to keep a copy.

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { uuidLike } from './schemas'
import {
  EMAIL_ATTACHMENT_BUCKET,
  attachmentObjectPath,
  exceedsQuota,
  safeAttachmentFilename,
  safeMimeType,
} from './email-attachment-quota'
import { addStorageBytes, getMailboxQuota } from './email-attachments-server'
import {
  MAX_OUTBOUND_ATTACHMENTS,
  draftSetError,
  exceedsOutboundTotal,
  outboundDraftPath,
  outboundSizeError,
} from './email-outbound-attachments'

const UNIQUE_VIOLATION = '23505'

/**
 * What a send route accepts for one attachment.
 *
 * NO PATH. The three fields are the inputs the key is REBUILT from plus the
 * filename, which is display data and never addresses anything. `mime` is
 * caller-supplied and is used for two things only — re-deriving the extension
 * (so a lie produces a key that is not there, and the send is refused) and the
 * Content-Type Postmark is told, which is sanitised by safeMimeType.
 *
 * Exported so both routes and the sign route share ONE definition; a second
 * copy would be a second answer to "what may a client say about a file".
 */
export const OutboundAttachmentSchema = z.object({
  draft_id: uuidLike,
  index: z.number().int().min(0).max(MAX_OUTBOUND_ATTACHMENTS - 1),
  // Staff filenames are less hostile than a stranger's but are still user
  // input: they reach a MIME header, a Postgres text column and an operator's
  // screen. safeAttachmentFilename does the real work below; this only bounds
  // the string before it gets there.
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(255),
})

/** The optional array as it appears on the reply and compose bodies. */
export const outboundAttachmentsField = z
  .array(OutboundAttachmentSchema)
  .max(MAX_OUTBOUND_ATTACHMENTS)
  .optional()

/**
 * Read every draft off Storage and turn it into what Postmark wants.
 *
 * RUNS BEFORE THE SEND, and every refusal it returns is a refusal to send at
 * all. That ordering is what makes "the thread never claims a file went out
 * that did not" true by construction rather than by cleanup.
 *
 * THE DOWNLOADED BUFFER'S LENGTH IS THE ONLY SIZE TRUSTED. Not the `size` the
 * browser reported at sign time, not a Storage metadata field — the same rule
 * decodeAttachmentContent() applies inbound, for the same reason: the number
 * decides both what Postmark is asked to carry and what a mailbox is billed.
 *
 * Never throws.
 *
 * @param {object} db service-role client
 * @param {object} args
 * @param {Array}  args.drafts   validated OutboundAttachmentSchema rows (may be undefined)
 * @param {string} args.profileId the CALLER'S OWN id — the key's security segment
 * @returns {Promise<{ok: true, postmark: Array|undefined, files: Array}
 *                  |{ok: false, error: string}>}
 *   `postmark` is undefined (not []) when there is nothing to attach, so
 *   sendEmail's payload stays byte-identical for every send without files.
 */
export async function collectOutboundAttachments(db, { drafts, profileId } = {}) {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { ok: true, postmark: undefined, files: [] }
  }

  const setError = draftSetError(drafts)
  if (setError) return { ok: false, error: setError }

  if (!profileId) {
    // Unreachable from a route (every caller runs getCurrentUser first), but a
    // missing profile id would build a key under someone else's prefix or throw
    // deep inside the loop. Refuse plainly.
    return { ok: false, error: 'Could not attach those files — please try again.' }
  }

  const postmark = []
  const files = []
  let totalBytes = 0

  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i]
    let path
    try {
      path = outboundDraftPath({
        profileId,
        draftId: draft.draft_id,
        index: draft.index,
        mime: draft.mime,
      })
    } catch (err) {
      console.error('[email-outbound-attach] refusing to build a draft path:', err?.message)
      return { ok: false, error: 'One of the attached files is not valid — remove it and try again.' }
    }

    const bytes = await downloadObject(db, path)
    if (!bytes) {
      // The upload never finished, the object expired, or the draft was already
      // consumed by an earlier send. All three mean the same thing to an
      // operator: this file is not there, and nothing has been sent yet.
      return {
        ok: false,
        error: `“${safeAttachmentFilename(draft.filename)}” could not be read — ` +
          'remove it and attach it again. Nothing was sent.',
      }
    }

    totalBytes += bytes.length
    if (exceedsOutboundTotal(totalBytes)) {
      return { ok: false, error: outboundSizeError(totalBytes) }
    }

    postmark.push({
      Name: safeAttachmentFilename(draft.filename),
      Content: bytes.toString('base64'),
      ContentType: safeMimeType(draft.mime),
    })
    files.push({
      draftPath: path,
      filename: safeAttachmentFilename(draft.filename),
      mime: safeMimeType(draft.mime),
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
 */
async function downloadObject(db, path) {
  try {
    const { data, error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).download(path)
    if (error || !data) {
      if (error) console.error('[email-outbound-attach] draft download failed:', error.message)
      return null
    }
    // supabase-js hands back a Blob in the browser and a Blob-alike in Node 18+.
    // A test double may hand back a Buffer directly; accept both rather than
    // making the shape of the fake part of the contract.
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer())
    if (!bytes || bytes.length === 0) return null
    return bytes
  } catch (err) {
    console.error('[email-outbound-attach] draft download threw:', err?.message)
    return null
  }
}

/** Take bytes back out of the bucket. Never throws; a leak is not a failure. */
async function removeObject(db, path) {
  if (!path) return
  try {
    const { error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove([path])
    if (error) {
      console.error('[email-outbound-attach] could not remove object', path, '—', error.message)
    }
  } catch (err) {
    console.error('[email-outbound-attach] object removal threw for', path, '—', err?.message)
  }
}

/**
 * Throw away one caller's draft object — the "×" on a chip, and the cancelled
 * composer.
 *
 * The path is BUILT from the caller's own profile id, so this is a delete
 * primitive that can only ever reach the caller's own drafts. It is deliberately
 * not a "delete this path" endpoint.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function discardOutboundDraft(db, { profileId, draftId, index, mime }) {
  let path
  try {
    path = outboundDraftPath({ profileId, draftId, index, mime })
  } catch (err) {
    return { ok: false, error: err?.message || 'Not a draft path' }
  }
  await removeObject(db, path)
  return { ok: true }
}

/**
 * File the attachments of a message that HAS ALREADY BEEN SENT.
 *
 * NEVER THROWS, NEVER FAILS THE RESPONSE. Every outcome is a row: stored, or
 * stored-nowhere-with-a-reason. The email is already with the member either
 * way, and the worst thing this function could do is make a route answer 500
 * for mail that went out fine.
 *
 * Order, per file: move → reserve → check → record. Moving first means the
 * row's storage_path is settled before anything is written; reserving before
 * the quota question is the mig 496 dance (two files landing at once must not
 * both be told there is room).
 *
 * @returns {Promise<{stored:number, skipped:number, bytesStored:number, reasons:object}>}
 *   A summary for logging. No caller branches on it.
 */
export async function fileOutboundAttachments(db, {
  files, messageId, locationId, mailboxId = null,
} = {}) {
  const summary = { stored: 0, skipped: 0, bytesStored: 0, reasons: {} }
  if (!Array.isArray(files) || files.length === 0) return summary
  if (!messageId || !locationId) {
    console.error('[email-outbound-attach] refusing to file without messageId + locationId')
    return summary
  }

  const note = (reason) => {
    summary.skipped += 1
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
  }

  const { quotaBytes } = await getMailboxQuota(db, { locationId, mailboxId })

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    try {
      const outcome = await fileOne(db, {
        file, index, messageId, locationId, mailboxId, quotaBytes,
      })
      if (outcome.kind === 'stored') {
        summary.stored += 1
        summary.bytesStored += outcome.sizeBytes
      } else {
        note(outcome.reason)
      }
    } catch (err) {
      // Belt and braces on top of fileOne's own guards. Bookkeeping for a
      // message that is already delivered is never allowed to throw out of
      // here.
      console.error('[email-outbound-attach] filing attachment', index, 'threw:', err?.message)
      note('rehost_failed')
    }
  }

  return summary
}

/**
 * One sent attachment, end to end.
 *
 * @returns {Promise<{kind:'stored', sizeBytes:number}|{kind:'skipped', reason:string}>}
 */
async function fileOne(db, { file, index, messageId, locationId, mailboxId, quotaBytes }) {
  // ── Move to the canonical key ─────────────────────────────────────
  // Falls back to the draft key rather than failing: the bytes exist at one of
  // the two, and the row addresses whichever one they are actually at.
  let path = file.draftPath
  try {
    const canonical = attachmentObjectPath({ locationId, messageId, index, mime: file.mime })
    const { error } = await db.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .move(file.draftPath, canonical)
    if (error) {
      console.error(
        '[email-outbound-attach] could not move a sent attachment to its canonical key; ' +
        'the row will point at the draft key instead —', error.message
      )
    } else {
      path = canonical
    }
  } catch (err) {
    console.error('[email-outbound-attach] move threw; keeping the draft key —', err?.message)
  }

  // ── Reserve ───────────────────────────────────────────────────────
  const sizeBytes = Math.max(1, Math.round(file.sizeBytes))
  const reserved = await addStorageBytes(db, { locationId, mailboxId, delta: sizeBytes })
  if (!reserved.ok) {
    // The counter is what says whether there is room; with it unavailable,
    // keeping the file would be keeping it unmetered.
    await removeObject(db, path)
    await recordSent(db, { messageId, locationId, mailboxId, index, file, sizeBytes, skippedReason: 'rehost_failed' })
    return { kind: 'skipped', reason: 'rehost_failed' }
  }

  const release = () => addStorageBytes(db, { locationId, mailboxId, delta: -sizeBytes })

  if (exceedsQuota(reserved.total, quotaBytes)) {
    await release()
    await removeObject(db, path)
    // The member HAS the file — it went out with the email. What did not happen
    // is the studio keeping a copy, which is exactly what this reason says.
    await recordSent(db, { messageId, locationId, mailboxId, index, file, sizeBytes, skippedReason: 'quota' })
    return { kind: 'skipped', reason: 'quota' }
  }

  // ── Record ────────────────────────────────────────────────────────
  const recorded = await recordSent(db, {
    messageId, locationId, mailboxId, index, file, sizeBytes, storagePath: path,
  })
  if (recorded === 'duplicate') {
    // Another writer already accounted for this (message, index). Give the
    // reservation back — but LEAVE THE OBJECT: the canonical key is a function
    // of (location, message, index), so what is at it is what the winning row
    // points at, and removing it would break their row.
    await release()
    return { kind: 'skipped', reason: 'rehost_failed' }
  }
  if (recorded === 'failed') {
    await release()
    // No row means nothing will ever find these bytes.
    await removeObject(db, path)
    console.error('[email-outbound-attach] row insert failed; object removed', { messageId, index })
    return { kind: 'skipped', reason: 'rehost_failed' }
  }
  return { kind: 'stored', sizeBytes }
}

/**
 * Write the attachment row for a SENT file.
 *
 * Exactly one of storagePath / skippedReason is set — mig 482's
 * email_attach_stored_xor_skipped CHECK enforces it, and a row that set both or
 * neither would 23514 and erase the record of a file that genuinely went out.
 *
 * Identical column set to the inbound writer on purpose: the thread renders one
 * chip component for both directions, and a sent attachment must be
 * indistinguishable from a received one everywhere downstream — the chip, the
 * preview allow-list, the download route, the prune, the counter recalc.
 *
 * @returns {Promise<'ok'|'duplicate'|'failed'>}
 */
async function recordSent(db, {
  messageId, locationId, mailboxId, index, file, sizeBytes,
  storagePath = null, skippedReason = null,
}) {
  try {
    const { error } = await db.from('email_ticket_attachments').insert({
      message_id: messageId,
      location_id: locationId,
      mailbox_id: mailboxId ?? null,
      attachment_index: index,
      filename: file.filename,
      mime_type: file.mime,
      size_bytes: Math.max(1, Math.round(sizeBytes)),
      storage_path: storagePath,
      skipped_reason: skippedReason,
    })
    if (!error) return 'ok'
    // UNIQUE (message_id, attachment_index). Unreachable on this path — the
    // message row is freshly inserted and this loop is the only writer for it —
    // but treated as its own outcome rather than a generic failure so the caller
    // does not release a reservation the winning row is using.
    if (error.code === UNIQUE_VIOLATION) return 'duplicate'
    console.error('[email-outbound-attach] attachment insert failed:', error.message)
    return 'failed'
  } catch (err) {
    console.error('[email-outbound-attach] attachment insert threw:', err?.message)
    return 'failed'
  }
}
