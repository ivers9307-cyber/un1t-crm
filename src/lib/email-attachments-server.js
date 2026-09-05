// EMAIL-ATTACH.1 — server-side IO for inbound email attachments and the
// per-mailbox storage quota. Mig 496.
//
// Pure rules (paths, filename sanitising, thresholds) live in
// ./email-attachment-quota.js; this module is the part that touches Storage and
// the database.
//
// ══ THE GOVERNING RULE ══════════════════════════════════════════════
// THE MESSAGE IS FILED NO MATTER WHAT. The inbound webhook's whole hardening
// history is about mail that vanished silently, so nothing here may fail an
// email. An attachment that cannot be stored — oversized, over quota, upload
// error, insert error — produces a ROW with a skipped_reason, so staff see
// "invoice.pdf — not stored, mailbox was full" and can ask for a resend.
// storeInboundAttachments() never throws and never returns a failure the
// webhook is expected to act on.
//
// ══ WHY THE COUNTER IS RESERVED BEFORE THE UPLOAD ═══════════════════
// Reserve → check → (roll back on refusal). The alternative, read-then-check-
// then-write, is the lost-update race mig 314 exists to remove: two 3 GB
// attachments arriving together would both read 0 bytes used, both conclude
// there is room, and land 6 GB in a 5 GB mailbox. Reserving first means each
// writer judges the quota from a total that already includes its own bytes, so
// exactly one of the two is refused.
//
// The reservation is given back on every path that does not end in a stored
// row, including the "someone else already recorded this" path — see below.
//
// ══ WHY THE ACCOUNTING IS IDEMPOTENT ════════════════════════════════
// The webhook releases its dedupe claim on any 5xx so Postmark's retry genuinely
// re-processes the message (EMAIL-DEDUPE-RELEASE.1). Re-processing is therefore
// designed behaviour, and bytes counted twice would silently shrink a mailbox's
// quota with nothing on any screen to explain it.
//
// Two layers stop that:
//   • attachment_index — the file's position in Postmark's own Attachments
//     array — is identical on every retry, and mig 496 puts a UNIQUE index on
//     (message_id, attachment_index). A pre-check skips the work; a 23505 is
//     the race-safe backstop, and it releases the reservation.
//   • the object path is derived from those same ids, so a retry that does get
//     as far as uploading overwrites the identical key rather than leaving a
//     second copy nothing is accounting for. That is why the 23505 path leaves
//     the object alone: it is the FIRST run's object, at the same key.
//
// ══ TWO PAYLOAD SHAPES, ONE FILING PATH (EMAIL-INBOUND-SHIM.1) ══════
// storeInboundAttachments accepts BOTH:
//
//   inline  Postmark's original base64 `Content`. Decoded and uploaded here.
//           STILL FULLY SUPPORTED — it is what runs if the Edge Function is
//           bypassed, mis-deployed or rolled back, and it is the shape every
//           attachment test written before the shim exercises.
//   staged  a `_un1t_staged` marker saying the bytes are ALREADY in the bucket,
//           put there by supabase/functions/postmark-inbound-shim. The row is
//           recorded against the object the shim wrote; nothing is decoded and
//           nothing is uploaded.
//
// THE SHIM'S KEY IS RECORDED, NOT COPIED TO THE CANONICAL ONE. The shim knows
// neither id the canonical key uses (`location_id` comes from resolving the
// recipient, `message_id` is our own row id — both decided after forwarding),
// so it keys on Postmark's MessageID under an `inbound/` prefix. That key is
// then written to storage_path verbatim, because NOTHING IN THIS SYSTEM
// DERIVES AN OBJECT'S ADDRESS FROM A PREFIX:
//   • pruneMailboxAttachments reads storage_path off the ROW and removes
//     exactly those keys (below);
//   • recalc_email_storage_usage sums size_bytes from ROWS and never lists the
//     bucket (mig 496);
//   • the download route signs storage_path off the ROW (mig 482's bucket is
//     private with no path-prefix storage policy — access is service-role only).
// So a differently-shaped key escapes no cleanup and no access control. A copy
// would buy uniformity at the price of two more Storage calls per attachment
// on the one path whose governing rule is that mail is never lost, and its
// failure branch has no good answer.
//
// ORPHANS — bytes in the bucket with no row pointing at them — are bounded
// deliberately, not hoped away:
//   1. the shim's key is a function of the payload alone, so N retries of one
//      message overwrite one object set rather than leaving N;
//   2. every branch below that REFUSES a staged attachment (too_large, quota,
//      too_many, a failed insert) removes the object the shim left;
//   3. every path in the webhook that decides the message will not be filed at
//      all (no sender, unmatched recipient → dead letter, and every 5xx that
//      returns before this module runs) calls discardStagedAttachments().
// What is left is the residue named in that function's comment.

import {
  EMAIL_ATTACHMENT_BUCKET,
  EMAIL_MAILBOX_QUOTA_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentObjectPath,
  exceedsQuota,
  safeAttachmentFilename,
  safeMimeType,
} from './email-attachment-quota'
import { isPreviewableAttachment } from './email-attachment-preview'
import { readStagedMarker, stagedPathsIn } from './email-attachment-staging'

const UNIQUE_VIOLATION = '23505'

/**
 * Postmark's base64 `Content` → bytes, or null when there is nothing usable.
 *
 * BASE64 LENGTH IS NOT BYTE LENGTH, and neither is the payload's own
 * `ContentLength` — both come from the sender. Only the decoded buffer's length
 * is trusted anywhere in this module.
 *
 * Buffer.from(…, 'base64') never throws; it silently ignores characters outside
 * the alphabet, so an empty result is the only signal that the input was junk.
 */
export function decodeAttachmentContent(content) {
  if (typeof content !== 'string' || content.length === 0) return null
  let bytes
  try {
    bytes = Buffer.from(content, 'base64')
  } catch {
    return null
  }
  if (!bytes || bytes.length === 0) return null
  return bytes
}

/**
 * Move a mailbox's counter by `delta` bytes, atomically, and hand back the new
 * total. `mailboxId` null addresses the location's unfiled bucket.
 *
 * Never throws: supabase-js builders are thenables with no `.catch`, so this is
 * a real try/catch, and a counter failure must not take an email with it.
 *
 * @returns {Promise<{ok: boolean, total: number|null}>}
 */
export async function addStorageBytes(db, { locationId, mailboxId = null, delta }) {
  try {
    const { data, error } = await db.rpc('add_email_storage_bytes', {
      p_location_id: locationId,
      p_mailbox_id: mailboxId ?? null,
      p_delta: delta,
    })
    if (error) {
      console.error('[email-attachments] storage counter rpc failed:', error.message)
      return { ok: false, total: null }
    }
    // PostgREST returns a scalar-returning function as the bare value; be
    // tolerant of the single-row-array shape too.
    const raw = Array.isArray(data) ? data[0] : data
    const total = Number(raw?.add_email_storage_bytes ?? raw)
    return { ok: true, total: Number.isFinite(total) ? total : null }
  } catch (err) {
    console.error('[email-attachments] storage counter rpc threw:', err?.message)
    return { ok: false, total: null }
  }
}

/**
 * The mailbox's ceiling and current fill, for the callers that need to decide
 * before they write. Returns the default quota when no counter row exists yet —
 * the row is created by the first reservation, not ahead of it.
 */
export async function getMailboxQuota(db, { locationId, mailboxId = null }) {
  try {
    let q = db.from('email_storage_usage')
      .select('bytes_used, quota_bytes')
      .eq('location_id', locationId)
    q = mailboxId ? q.eq('mailbox_id', mailboxId) : q.is('mailbox_id', null)
    const { data, error } = await q.maybeSingle()
    if (error || !data) return { bytesUsed: 0, quotaBytes: EMAIL_MAILBOX_QUOTA_BYTES }
    return {
      bytesUsed: Number(data.bytes_used) || 0,
      quotaBytes: Number(data.quota_bytes) || EMAIL_MAILBOX_QUOTA_BYTES,
    }
  } catch {
    return { bytesUsed: 0, quotaBytes: EMAIL_MAILBOX_QUOTA_BYTES }
  }
}

/** Has this (message, index) already been accounted for by an earlier run? */
async function alreadyRecorded(db, messageId, index) {
  try {
    const { data, error } = await db.from('email_ticket_attachments')
      .select('id')
      .eq('message_id', messageId)
      .eq('attachment_index', index)
      .maybeSingle()
    if (error) return false
    return !!data
  } catch {
    return false
  }
}

/**
 * Store one message's inbound attachments and meter the bytes.
 *
 * NEVER THROWS. NEVER FAILS THE MESSAGE. Every outcome — stored, skipped,
 * already-recorded — is a row or an explicit no-op, and the return value is a
 * summary for logging, not something the webhook branches on.
 *
 * @param {object} db service-role client
 * @param {object} args
 * @param {Array}  args.attachments Postmark's `Attachments` array (may be anything)
 * @param {string} args.messageId   email_inbox_messages.id (NOT Postmark's MessageID)
 * @param {string} args.locationId
 * @param {string|null} args.mailboxId
 * @param {string|null} args.postmarkMessageId Postmark's own MessageID. Required
 *   to believe a `_un1t_staged` marker: the staged key is re-derived from it, so
 *   a marker can only ever name the object the shim wrote for THIS message. Its
 *   absence is fail-safe — every marker then reads as `rehost_failed` and
 *   nothing is deleted — never fail-open.
 * @returns {Promise<{stored: number, skipped: number, deduped: number, bytesStored: number, reasons: object}>}
 */
export async function storeInboundAttachments(db, {
  attachments, messageId, locationId, mailboxId = null, postmarkMessageId = null,
} = {}) {
  const summary = { stored: 0, skipped: 0, deduped: 0, bytesStored: 0, reasons: {} }
  const note = (reason) => {
    summary.skipped += 1
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
  }

  if (!Array.isArray(attachments) || attachments.length === 0) return summary
  if (!messageId || !locationId) {
    console.error('[email-attachments] refusing to store without messageId + locationId')
    return summary
  }

  const { quotaBytes } = await getMailboxQuota(db, { locationId, mailboxId })

  for (let index = 0; index < attachments.length; index += 1) {
    try {
      // Past the cap the file is still RECORDED, just not stored. An operator
      // seeing "12 files not stored" can go and ask for them; a silently
      // truncated list looks like the member never sent them.
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
        // The shim does not stage past the cap either, so there is normally
        // nothing here — but a marker at this index would be bytes no row will
        // ever name, so it is thrown away rather than left to bill.
        await discardOne(db, attachments[index], { postmarkMessageId, index })
        const recorded = await recordAttachment(db, {
          messageId, locationId, mailboxId, index,
          attachment: attachments[index],
          sizeBytes: attachmentSizeHint(attachments[index]),
          skippedReason: 'too_many',
        })
        if (recorded === 'duplicate') summary.deduped += 1
        else note('too_many')
        continue
      }

      const outcome = await storeOne(db, {
        attachment: attachments[index],
        index, messageId, locationId, mailboxId, quotaBytes, postmarkMessageId,
      })
      if (outcome.kind === 'stored') {
        summary.stored += 1
        summary.bytesStored += outcome.sizeBytes
      } else if (outcome.kind === 'duplicate') {
        summary.deduped += 1
      } else if (outcome.kind === 'skipped') {
        note(outcome.reason)
      }
      // kind === 'empty' — nothing to record: size_bytes > 0 is a CHECK, so a
      // zero-byte attachment has no legal row. Logged inside storeOne.
    } catch (err) {
      // Belt and braces on top of storeOne's own guards. An attachment loop is
      // never allowed to take the email with it.
      console.error('[email-attachments] attachment', index, 'threw:', err?.message)
    }
  }

  return summary
}

/**
 * A last-resort size for an attachment we are not going to decode (the
 * over-the-count case). `ContentLength` is sender-supplied and therefore
 * untrusted — it is used ONLY here, where the alternative is no row at all, and
 * never to decide whether something fits the quota.
 */
function attachmentSizeHint(attachment) {
  const n = Number(attachment?.ContentLength)
  if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), MAX_ATTACHMENT_BYTES)
  return 1 // size_bytes > 0 is a CHECK; "unknown" still has to be a legal row
}

/** Take bytes back out of the bucket. Never throws; a leak is not a failure. */
async function removeObject(db, path) {
  if (!path) return
  try {
    const { error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove([path])
    if (error) {
      console.error('[email-attachments] could not remove unreferenced object', path, '—', error.message)
    }
  } catch (err) {
    console.error('[email-attachments] object removal threw for', path, '—', err?.message)
  }
}

/**
 * Throw away the bytes the shim staged for ONE attachment, if it staged any.
 *
 * The path is re-derived and validated by readStagedMarker before it is used,
 * so this can only ever delete the object the shim would have written for this
 * (message, index) — never an arbitrary string off a webhook payload.
 */
async function discardOne(db, attachment, { postmarkMessageId, index }) {
  const marker = readStagedMarker(attachment, { postmarkMessageId, index })
  if (marker.kind !== 'staged') return
  await removeObject(db, marker.path)
}

/**
 * One attachment, end to end — in EITHER payload shape.
 *
 * @returns {Promise<{kind: 'stored'|'skipped'|'duplicate'|'empty', reason?: string, sizeBytes?: number}>}
 */
async function storeOne(db, {
  attachment, index, messageId, locationId, mailboxId, quotaBytes, postmarkMessageId,
}) {
  const marker = readStagedMarker(attachment, { postmarkMessageId, index })

  // The shim looked at this file and could not move it (too big to be worth
  // decoding, or Storage refused). There are no bytes anywhere; record the row
  // so staff can ask for a resend and move on.
  if (marker.kind === 'skip') {
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment,
      sizeBytes: attachmentSizeHint(attachment),
      skippedReason: marker.reason,
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: marker.reason }
  }

  const staged = marker.kind === 'staged'

  // The decoded buffer, and the size. INLINE decodes here as it always has;
  // STAGED takes the length the shim measured off ITS decoded buffer. In both
  // shapes the number is a decoded length — never base64 length and never the
  // sender's `ContentLength`.
  let bytes = null
  let sizeBytes
  if (staged) {
    sizeBytes = marker.sizeBytes
  } else {
    bytes = decodeAttachmentContent(attachment?.Content)
    if (!bytes) {
      console.warn('[email-attachments] undecodable or empty attachment', { messageId, index })
      return { kind: 'empty' }
    }
    sizeBytes = bytes.length // the ONLY size this module trusts
  }

  // Anything that ends without a row must take the staged bytes with it — the
  // inline path simply has not uploaded anything yet at these points.
  const discard = () => (staged ? removeObject(db, marker.path) : Promise.resolve())

  // Fast path for a re-processed delivery: don't upload bytes we are about to
  // discard. The 23505 handling below is what makes it correct under a race;
  // this only makes it cheap.
  //
  // NOTHING IS DELETED HERE, in either shape. The winning row points at the
  // same deterministic key this run would have written, so the object is the
  // one that row needs.
  if (await alreadyRecorded(db, messageId, index)) return { kind: 'duplicate' }

  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    await discard()
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes: MAX_ATTACHMENT_BYTES,
      skippedReason: 'too_large',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'too_large' }
  }

  // ── Reserve ───────────────────────────────────────────────────────
  const reserved = await addStorageBytes(db, { locationId, mailboxId, delta: sizeBytes })
  if (!reserved.ok) {
    // The counter is the thing that says whether there is room. With it
    // unavailable, storing would be storing unmetered — record and move on.
    await discard()
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'rehost_failed',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'rehost_failed' }
  }

  const release = () => addStorageBytes(db, { locationId, mailboxId, delta: -sizeBytes })

  if (exceedsQuota(reserved.total, quotaBytes)) {
    await release()
    await discard()
    const recorded = await recordAttachment(db, {
      messageId, locationId, mailboxId, index, attachment, sizeBytes,
      skippedReason: 'quota',
    })
    return recorded === 'duplicate'
      ? { kind: 'duplicate' }
      : { kind: 'skipped', reason: 'quota' }
  }

  // ── Upload ────────────────────────────────────────────────────────
  // Skipped entirely in the staged shape: the bytes are already in the bucket
  // at a key this module validated, and re-uploading would mean the shim had
  // moved them for nothing.
  const mime = safeMimeType(attachment?.ContentType)
  let path = staged ? marker.path : null

  if (!staged) {
    try {
      path = attachmentObjectPath({ locationId, messageId, index, mime })
    } catch (err) {
      await release()
      console.error('[email-attachments] refusing to build a storage path:', err?.message)
      const recorded = await recordAttachment(db, {
        messageId, locationId, mailboxId, index, attachment, sizeBytes,
        skippedReason: 'rehost_failed',
      })
      return recorded === 'duplicate'
        ? { kind: 'duplicate' }
        : { kind: 'skipped', reason: 'rehost_failed' }
    }

    // upsert:true because the key is deterministic — a retry rewrites the same
    // object with the same bytes rather than erroring on an existing key.
    const { error: upErr } = await db.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: true })
    if (upErr) {
      await release()
      console.error('[email-attachments] upload failed:', upErr.message)
      const recorded = await recordAttachment(db, {
        messageId, locationId, mailboxId, index, attachment, sizeBytes,
        skippedReason: 'rehost_failed',
      })
      return recorded === 'duplicate'
        ? { kind: 'duplicate' }
        : { kind: 'skipped', reason: 'rehost_failed' }
    }
  }

  // ── Record ────────────────────────────────────────────────────────
  const recorded = await recordAttachment(db, {
    messageId, locationId, mailboxId, index, attachment, sizeBytes, storagePath: path,
  })
  if (recorded === 'duplicate') {
    // Another run already accounted for this (message, index). Give the
    // reservation back — but LEAVE THE OBJECT: the path is deterministic in
    // BOTH shapes, so what is at that key is byte-identical to what the winning
    // row points at. Deleting it here would break their row.
    await release()
    return { kind: 'duplicate' }
  }
  if (recorded === 'failed') {
    await release()
    // No row means nothing will ever find these bytes, so take them back out —
    // whether this run uploaded them or the shim did.
    await removeObject(db, path)
    console.error('[email-attachments] row insert failed; object removed', { messageId, index })
    return { kind: 'skipped', reason: 'rehost_failed' }
  }
  return { kind: 'stored', sizeBytes }
}

/**
 * Throw away every object the shim staged for a message THAT IS NOT GOING TO BE
 * FILED — an unmatched recipient heading for the dead-letter table, a payload
 * with no parseable sender, or any 5xx the webhook answers before this module
 * ever runs.
 *
 * WITHOUT THIS THE BUCKET LEAKS. With inbound-domain forwarding, every address
 * at a configured domain reaches the webhook, so `anything@` that is not a
 * mailbox dead-letters — and spam with attachments is exactly the traffic that
 * produces. Those bytes would otherwise sit in a metered bucket forever with
 * no row, no counter entry and nothing on any screen to say they exist.
 *
 * NEVER THROWS, NEVER BLOCKS A RESPONSE. Losing the cleanup costs money;
 * failing the request would cost mail, and mail wins every time.
 *
 * Called only where the webhook KNOWS nothing will reference the bytes. It is
 * deliberately NOT called from the `deduped` paths — an earlier run's rows
 * point at these same deterministic keys — nor from the unhandled-error catch,
 * where the state is by definition unknown.
 *
 * THE RESIDUE, STATED: bytes staged for a message whose forward never produced
 * a decision here — a shim→Vercel network failure, or a 5xx the webhook throws
 * out of its catch-all — are not swept. Each is an incident in its own right
 * (the retry chain is running, or an email is failing), the key is
 * deterministic so retries overwrite rather than accumulate, and the objects
 * are confined to the `inbound/` prefix so a sweep can be added later with an
 * exact search space. That is the accepted cost, not an oversight.
 */
export async function discardStagedAttachments(db, attachments, { postmarkMessageId } = {}) {
  try {
    const paths = stagedPathsIn(attachments, { postmarkMessageId })
    if (paths.length === 0) return 0
    const { error } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove(paths)
    if (error) {
      console.error(
        '[email-attachments] STAGED BYTES LEFT BEHIND — the message is not being filed, so ' +
        `nothing will ever point at these and they are still billable: ${paths.join(', ')} —`,
        error.message,
      )
      return 0
    }
    return paths.length
  } catch (err) {
    console.error('[email-attachments] discarding staged attachments threw:', err?.message)
    return 0
  }
}

/**
 * Write the attachment row.
 *
 * Exactly one of storagePath / skippedReason must be set — mig 482's
 * email_attach_stored_xor_skipped CHECK enforces it, and a row that set both or
 * neither would 23514 and lose the record of the file entirely.
 *
 * @returns {Promise<'ok'|'duplicate'|'failed'>}
 */
async function recordAttachment(db, {
  messageId, locationId, mailboxId, index, attachment, sizeBytes,
  storagePath = null, skippedReason = null,
}) {
  try {
    const { error } = await db.from('email_ticket_attachments').insert({
      message_id: messageId,
      location_id: locationId,
      mailbox_id: mailboxId ?? null,
      attachment_index: index,
      // The stranger's filename, kept as DATA. It never addressed the object.
      filename: safeAttachmentFilename(attachment?.Name),
      mime_type: safeMimeType(attachment?.ContentType),
      size_bytes: Math.max(1, Math.round(sizeBytes)),
      storage_path: storagePath,
      skipped_reason: skippedReason,
    })
    if (!error) return 'ok'
    if (error.code === UNIQUE_VIOLATION) return 'duplicate'
    console.error('[email-attachments] attachment insert failed:', error.message)
    return 'failed'
  } catch (err) {
    console.error('[email-attachments] attachment insert threw:', err?.message)
    return 'failed'
  }
}

/**
 * The one place a Storage options object is constructed for a signed URL.
 *
 * NOT EXPORTED, AND THAT IS THE POINT. The two public signers below each pass a
 * fixed value; no caller anywhere — and therefore no HTTP request — can choose
 * what goes in here. The difference between a preview URL and a download URL is
 * this single field and nothing else.
 */
async function sign(db, storagePath, ttlSeconds, options) {
  if (!storagePath) return null
  try {
    const { data, error } = await db.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .createSignedUrl(storagePath, ttlSeconds, options)
    if (error || !data?.signedUrl) {
      if (error) console.error('[email-attachments] signed url failed:', error.message)
      return null
    }
    return data.signedUrl
  } catch (err) {
    console.error('[email-attachments] signed url threw:', err?.message)
    return null
  }
}

/**
 * A short-lived signed URL that DOWNLOADS one stored attachment. The bucket is
 * private, so this is the only way any browser sees the bytes, and it expires.
 *
 * `{ download: filename }` is what makes Storage answer with
 * `Content-Disposition: attachment`, so the browser saves the file instead of
 * trying to render it. That is the correct — and the safe — outcome for every
 * type that is not on the preview allow-list: a downloaded SVG is inert, a
 * downloaded HEIC opens in Photos, a downloaded .pptx opens in PowerPoint.
 *
 * `filename` becomes the saved name — it is the sanitised value off the row,
 * never the raw MIME header.
 */
export async function signedAttachmentUrl(db, storagePath, { filename, ttlSeconds = 300 } = {}) {
  return sign(db, storagePath, ttlSeconds, filename ? { download: filename } : undefined)
}

/**
 * A short-lived signed URL that DISPLAYS one stored attachment inline — no
 * download flag, so Storage serves it with the object's own content type and
 * the browser renders it.
 *
 * REFUSES ANY TYPE THAT IS NOT ON THE ALLOW-LIST, and that refusal is here
 * rather than only at the route because this function is what turns bytes into
 * a renderable handle. A route that forgot the check would otherwise mint an
 * inline URL for `image/svg+xml` — the exact thing the allow-list exists to
 * prevent — and nothing below this line would notice. See
 * src/lib/email-attachment-preview.js for why each type is in or out.
 *
 * Returns null for a non-previewable type, which every caller must render as
 * "download only", never as a failure.
 */
export async function signedAttachmentPreviewUrl(db, storagePath, { mimeType, ttlSeconds = 300 } = {}) {
  if (!isPreviewableAttachment(mimeType)) return null
  // `undefined`, deliberately spelled out: no download name, no transform, no
  // caller-supplied bag. An inline URL differs from a download URL by exactly
  // the absence of this option.
  return sign(db, storagePath, ttlSeconds, undefined)
}

// A prune is a destructive operator action, so it is bounded: one call clears at
// most this many attachments and reports what is left, rather than doing an
// unbounded amount of work inside one request.
export const PRUNE_BATCH_LIMIT = 200

// Tickets someone is still working are never pruned, whatever age is chosen.
// The spec's rule ("attachments on closed tickets older than a chosen age")
// with `solved` included — a solved ticket is finished correspondence.
const PRUNABLE_TICKET_STATUSES = ['solved', 'closed']

/**
 * Reclaim space: drop the bytes, keep the record, and MOVE THE COUNTER.
 *
 * The counter half is the whole point. A delete path that removes rows and
 * objects but leaves bytes_used high converts a full mailbox into a permanently
 * full one — every future attachment is refused for space that was freed months
 * ago, and nothing on any screen explains it.
 *
 * ORDER: mark the rows first, then remove the objects, then decrement.
 *   • marking first means nothing ever points at bytes that are already gone
 *   • the UPDATE filters on `storage_path IS NOT NULL` and returns what it
 *     actually changed, so two operators pruning at once cannot both count the
 *     same rows and double-decrement
 *   • a failed object removal is logged loudly and still decremented: rows and
 *     counter agree (which is what recalc would conclude anyway), and the leak
 *     is a cost line, not a correctness one
 *
 * ══ SHARED OBJECTS (EMAIL-FORWARD.1, mig 501) ═══════════════════════
 * Since forwarding landed, ONE OBJECT CAN HAVE TWO ROWS: a forward's
 * attachment row points at the ORIGINAL'S canonical key rather than a copy, and
 * carries `forwarded_from_id` to say so. That breaks the one-row-one-object
 * assumption this function was written under, in two places, so both are
 * handled explicitly rather than left to luck:
 *
 *   • CANDIDATES ARE OWNERS ONLY (`forwarded_from_id IS NULL`). A reference row
 *     owns no bytes: pruning it would remove an object the owner still points
 *     at, and decrement the mailbox for space it was never charged.
 *   • THE MARK CASCADES. After the batch is marked, every row pointing INTO
 *     that batch is marked too — WITHOUT a second decrement, because those rows
 *     were never charged. Without this, a forward whose original happened to
 *     fall in the batch would be left as a chip that downloads a 404: the
 *     failure would be silent, months later, and unattributable. The forward's
 *     chip instead reads "Removed to free space", which is exactly true.
 *
 * The cascade is not merely a batch-boundary guard. A forward lives on the same
 * ticket as the message it quotes, so the two are ALWAYS eligible together —
 * they simply may not land in the same 200-row batch.
 *
 * @returns {Promise<{ok: boolean, error?: string, pruned: number, bytesFreed: number, remaining: number}>}
 *   `pruned` counts OWNER rows — the rows whose bytes were actually reclaimed.
 *   Cascaded reference rows are logged, not counted: reporting them would tell
 *   an operator more files were freed than bytes recovered.
 */
export async function pruneMailboxAttachments(db, {
  locationId, mailboxId = null, olderThanDays = 365, limit = PRUNE_BATCH_LIMIT,
}) {
  const empty = { ok: true, pruned: 0, bytesFreed: 0, remaining: 0 }
  if (!locationId) return { ...empty, ok: false, error: 'locationId is required' }

  const days = Math.max(0, Math.floor(Number(olderThanDays) || 0))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const batch = Math.min(Math.max(1, Math.floor(Number(limit) || PRUNE_BATCH_LIMIT)), PRUNE_BATCH_LIMIT)

  // Candidates: stored, in this bucket, old enough — and OWNERS of their bytes.
  // A row with forwarded_from_id set shares another row's object (mig 501): it
  // has nothing of its own to free, and removing that object would break the
  // owner. It is dealt with by the cascade below instead.
  //
  // Over-fetch by one so the caller can be told there is more without a second
  // count query.
  let q = db.from('email_ticket_attachments')
    .select('id, message_id, size_bytes, storage_path')
    .eq('location_id', locationId)
    .not('storage_path', 'is', null)
    .is('forwarded_from_id', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(batch + 1)
  q = mailboxId ? q.eq('mailbox_id', mailboxId) : q.is('mailbox_id', null)

  const { data: candidates, error: candErr } = await q
  if (candErr) return { ...empty, ok: false, error: candErr.message }
  if (!candidates || candidates.length === 0) return empty

  const eligible = await filterToFinishedTickets(db, candidates)
  if (eligible.error) return { ...empty, ok: false, error: eligible.error }

  const rows = eligible.rows.slice(0, batch)
  const remaining = Math.max(0, eligible.rows.length - rows.length)
  if (rows.length === 0) return { ...empty, remaining }

  // Snapshot the object keys BEFORE the UPDATE nulls storage_path. Reading
  // them afterwards would be reading the column we are about to blank, which
  // silently leaves every pruned object in the bucket.
  const pathById = new Map(rows.map(r => [r.id, r.storage_path]))

  // ── Mark ──────────────────────────────────────────────────────────
  const { data: updated, error: updErr } = await db.from('email_ticket_attachments')
    .update({ storage_path: null, skipped_reason: 'pruned' })
    .in('id', rows.map(r => r.id))
    .not('storage_path', 'is', null)
    .select('id, size_bytes')
  if (updErr) return { ...empty, ok: false, error: updErr.message, remaining }

  const changed = updated || []
  if (changed.length === 0) return { ...empty, remaining }

  const bytesFreed = changed.reduce((sum, r) => sum + (Number(r.size_bytes) || 0), 0)

  // ── Cascade to anything FORWARDING these bytes (mig 501) ──────────
  // BEFORE the objects go, for the same reason the owners are marked first:
  // nothing may be left pointing at bytes that are already gone. No decrement
  // — a forwarded row was never charged.
  await markForwardsOfPruned(db, changed.map(r => r.id))

  // ── Remove the bytes ──────────────────────────────────────────────
  const paths = changed.map(r => pathById.get(r.id)).filter(Boolean)
  try {
    const { error: rmErr } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove(paths)
    if (rmErr) {
      console.error(
        '[email-attachments] PRUNE LEFT OBJECTS BEHIND — the rows are marked pruned and the ' +
        'counter is being decremented, so the quota is correct, but these objects are still ' +
        `billable and now unreferenced: ${paths.join(', ')} —`, rmErr.message,
      )
    }
  } catch (err) {
    console.error('[email-attachments] prune object removal threw:', err?.message)
  }

  // ── Decrement ─────────────────────────────────────────────────────
  const released = await addStorageBytes(db, { locationId, mailboxId, delta: -bytesFreed })
  if (!released.ok) {
    console.error(
      '[email-attachments] PRUNE DID NOT DECREMENT THE COUNTER — the mailbox will read as ' +
      `full for ${bytesFreed} bytes it no longer holds. Run the Recalculate action.`,
    )
  }

  return { ok: true, pruned: changed.length, bytesFreed, remaining }
}

/**
 * MAIL-SPAM.1 — free the bytes behind a set of messages that are about to be
 * HARD-DELETED (the spam purge). Objects out of the bucket, the mailbox
 * counter decremented by what was freed, and any forward elsewhere that
 * shared one of these objects marked pruned so its chip reads "Removed to
 * free space" instead of downloading a 404.
 *
 * Unlike pruneMailboxAttachments this does NOT mark the owner rows — they are
 * CASCADE-deleted with their ticket moments later, and marking rows that are
 * about to vanish is a write for nothing. The caller deletes the rows AFTER
 * this returns; the rows are the only thing that names the objects, so the
 * order is load-bearing.
 *
 * OWNERS ONLY free bytes (`forwarded_from_id IS NULL`, mig 501): a forward row
 * inside the purged set shares another row's object and was never charged,
 * so it neither removes an object nor decrements anything. If its OWNER is
 * outside the purged set the object stays — that owner still points at it.
 *
 * Paged with .range() (a page of spam tickets can carry more attachment rows
 * than one select cap). Never throws; a failed object removal is logged
 * loudly and the counter is STILL decremented (rows and counter agree, which
 * is what recalc would conclude; the leak is a cost line, not a correctness
 * one).
 *
 * @param {object} db  service-role client
 * @param {string[]} messageIds
 * @returns {Promise<{ok: boolean, error?: string, removed: number, bytesFreed: number}>}
 *   `removed` counts owner rows whose object was addressed.
 */
export async function purgeAttachmentsForMessages(db, messageIds) {
  const ids = [...new Set((messageIds || []).filter(Boolean))]
  const result = { ok: true, removed: 0, bytesFreed: 0 }
  if (ids.length === 0) return result

  const IN_CHUNK = 200
  const PAGE = 1000
  const owners = []
  try {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK)
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db.from('email_ticket_attachments')
          .select('id, storage_path, size_bytes, location_id, mailbox_id, forwarded_from_id')
          .in('message_id', chunk)
          .not('storage_path', 'is', null)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) return { ...result, ok: false, error: error.message }
        const page = data || []
        for (const r of page) if (!r.forwarded_from_id) owners.push(r)
        if (page.length < PAGE) break
      }
    }
  } catch (err) {
    return { ...result, ok: false, error: err?.message || 'attachment scan threw' }
  }
  if (owners.length === 0) return result

  // Forwards ELSEWHERE that share these objects — marked before the bytes go,
  // for the same reason pruneMailboxAttachments marks them: nothing may be
  // left pointing at bytes that are already gone. No decrement (never charged).
  await markForwardsOfPruned(db, owners.map(r => r.id))

  // ── Remove the bytes ──────────────────────────────────────────────
  const REMOVE_CHUNK = 100
  const paths = owners.map(r => r.storage_path).filter(Boolean)
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK)
    try {
      const { error: rmErr } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove(chunk)
      if (rmErr) {
        console.error(
          '[email-attachments] SPAM PURGE LEFT OBJECTS BEHIND — their rows are about to be deleted, ' +
          `so these objects are now unreferenced and still billable: ${chunk.join(', ')} —`, rmErr.message,
        )
      }
    } catch (err) {
      console.error('[email-attachments] spam purge object removal threw:', err?.message)
    }
  }
  result.removed = owners.length

  // ── Decrement, per (location, mailbox) bucket ─────────────────────
  const byBucket = new Map()
  for (const r of owners) {
    const key = `${r.location_id}|${r.mailbox_id ?? ''}`
    const cur = byBucket.get(key) || { locationId: r.location_id, mailboxId: r.mailbox_id ?? null, bytes: 0 }
    cur.bytes += Number(r.size_bytes) || 0
    byBucket.set(key, cur)
  }
  for (const b of byBucket.values()) {
    if (b.bytes <= 0) continue
    result.bytesFreed += b.bytes
    const released = await addStorageBytes(db, { locationId: b.locationId, mailboxId: b.mailboxId, delta: -b.bytes })
    if (!released.ok) {
      console.error(
        '[email-attachments] SPAM PURGE DID NOT DECREMENT THE COUNTER — the mailbox will read as ' +
        `full for ${b.bytes} bytes it no longer holds (location ${b.locationId}, mailbox ${b.mailboxId}). Run Recalculate.`,
      )
    }
  }
  return result
}

/**
 * Mark every FORWARD of a just-pruned attachment as pruned too (EMAIL-FORWARD.1).
 *
 * A forwarded row shares the owner's object, so once those bytes are removed
 * its storage_path addresses nothing. Left alone it is a chip in the thread
 * that downloads a 404 — silently, and long after anyone could connect it to a
 * prune. Marked, it reads "Removed to free space", which is the truth for both
 * rows.
 *
 * NO DECREMENT, deliberately: these rows never added to bytes_used (nothing was
 * uploaded for them) and mig 501's recalc excludes them, so giving space back
 * for one would make the counter under-report and the repair tool disagree
 * with the write path.
 *
 * Never throws and never fails the prune. The owners' bytes are genuinely
 * reclaimed either way; a missed cascade leaves a dead chip, which is a smaller
 * wrong than a prune that reports failure after it has already deleted objects.
 */
async function markForwardsOfPruned(db, ownerIds) {
  const ids = (ownerIds || []).filter(Boolean)
  if (ids.length === 0) return
  try {
    const { error } = await db.from('email_ticket_attachments')
      .update({ storage_path: null, skipped_reason: 'pruned' })
      .in('forwarded_from_id', ids)
      // Idempotent: a row already marked by an earlier pass is skipped rather
      // than rewritten, exactly like the owners' own UPDATE.
      .not('storage_path', 'is', null)
    if (error) {
      console.error(
        '[email-attachments] PRUNE COULD NOT MARK FORWARDED COPIES — their bytes are about to be ' +
        'removed and their rows still claim a storage_path, so those chips will fail to download:',
        error.message,
      )
    }
  } catch (err) {
    console.error('[email-attachments] prune cascade to forwarded copies threw:', err?.message)
  }
}

/**
 * Keep only the attachments whose ticket is finished.
 *
 * Two hops (attachment → message → ticket) rather than a nested PostgREST
 * embed filter, which this repo has been bitten by (embedded-resource filters
 * silently return the wrong thing under some select shapes). The candidate set
 * is already bounded by the prune batch, so two `.in()` queries is cheap.
 */
async function filterToFinishedTickets(db, candidates) {
  const messageIds = [...new Set(candidates.map(c => c.message_id).filter(Boolean))]
  if (messageIds.length === 0) return { rows: [] }

  const { data: messages, error: msgErr } = await db.from('email_inbox_messages')
    .select('id, ticket_id')
    .in('id', messageIds)
    .limit(messageIds.length)
  if (msgErr) return { error: msgErr.message, rows: [] }

  const ticketByMessage = new Map((messages || []).map(m => [m.id, m.ticket_id]))
  const ticketIds = [...new Set([...ticketByMessage.values()].filter(Boolean))]
  if (ticketIds.length === 0) return { rows: [] }

  const { data: tickets, error: tErr } = await db.from('email_tickets')
    .select('id, status')
    .in('id', ticketIds)
    .limit(ticketIds.length)
  if (tErr) return { error: tErr.message, rows: [] }

  const finished = new Set(
    (tickets || []).filter(t => PRUNABLE_TICKET_STATUSES.includes(t.status)).map(t => t.id)
  )
  return {
    rows: candidates.filter(c => finished.has(ticketByMessage.get(c.message_id))),
  }
}

/**
 * Re-derive every counter at a location from the attachment rows. The repair
 * for the drift the reservation dance can leave behind (a process killed
 * between reserve and insert, a prune whose decrement failed) and for a mailbox
 * hard-deleted in SQL, which CASCADEs its counter away while its attachments
 * survive with mailbox_id NULL.
 */
export async function recalcStorageUsage(db, locationId) {
  try {
    const { error } = await db.rpc('recalc_email_storage_usage', { p_location_id: locationId })
    if (error) {
      console.error('[email-attachments] recalc failed:', error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    console.error('[email-attachments] recalc threw:', err?.message)
    return { ok: false, error: err?.message || 'recalc failed' }
  }
}
