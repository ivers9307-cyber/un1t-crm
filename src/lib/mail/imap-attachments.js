// src/lib/mail/imap-attachments.js
//
// IMAP-CONNECTOR Phase 4 — attachments (design doc §3).
//
// ── What this file is, and what it deliberately is not ────────────────────
// A BYTES-MOVER, and nothing else. It walks one message's BODYSTRUCTURE for
// the parts that are files, downloads each over the already-open read-only
// IMAP connection, puts the bytes in the private `email-attachments` bucket,
// and hands back Postmark-shaped `Attachments` entries carrying the SAME
// `_un1t_staged` marker the Supabase Edge shim writes.
//
// IT FILES NOTHING. No row, no counter, no ticket. The poller POSTs the
// payload this produces to the existing inbound webhook, and that route —
// unchanged — reads these markers through readStagedMarker(), records the
// email_ticket_attachments rows and meters the bytes. This module is the
// SECOND INSTANCE of the shim's pattern, not a second pipeline (design §3).
//
// ── WHY IT MIRRORS supabase/functions/postmark-inbound-shim/index.ts ──────
// Because the consumer cannot tell the two apart, and must not have to.
// src/lib/email-attachments-server.js branches on the marker alone:
// `storeInboundAttachments` believes a `_un1t_staged` path only after
// re-deriving it from Postmark's `MessageID` and the array position, and
// `discardStagedAttachments` deletes only paths that same validation accepts.
// Every constant, every ceiling and every degrade-instead-of-fail branch here
// is therefore the shim's, taken from the shim's own reasoning:
//
//   • the marker is written with the REAL writers — stagedAttachment(),
//     failedAttachment(), strippedAttachment() from
//     src/lib/email-attachment-staging.js. Nothing here hand-builds a marker
//     object, so this module cannot drift from the contract even by accident;
//   • the key is stagedAttachmentPath()'s, so it is a pure function of
//     (MessageID, array index) and a re-poll OVERWRITES rather than
//     accumulating;
//   • ceilings are MAX_ATTACHMENT_BYTES / MAX_ATTACHMENTS_PER_MESSAGE from
//     src/lib/email-attachment-quota.js — the same two values the contract
//     test pins the .ts file against;
//   • an oversized part is screened on the ENCODED size BEFORE it is
//     downloaded, so a 30 MB file never becomes a 30 MB buffer.
//
// ── THE GOVERNING RULE: A FILE MAY NEVER COST AN EMAIL ────────────────────
// Inherited verbatim from the route this feeds. Nothing here throws and
// nothing here returns a failure the poller is expected to act on. Every
// unhappy path — oversized, unreadable part, Storage refusing the upload, a
// bodyStructure shaped in a way nobody anticipated — produces an ENTRY with a
// marker that reaches the route's `skip` branch, so staff see
// "invoice.pdf — not stored, upload failed" and can ask for a resend instead
// of the file (and possibly the message) disappearing in silence.
//
// The one case that deliberately produces NO marker is a part that decodes to
// zero bytes. `email_ticket_attachments.size_bytes > 0` is a CHECK, so there
// is no legal row for it; the route's inline path already answers "nothing
// usable" for an empty `Content` and writes nothing. Identical to the shim.
//
// ── WHY THIS MODULE DOES NOT MOVE THE STORAGE COUNTER ─────────────────────
// `add_email_storage_bytes` is called exactly once per attachment, by
// storeOne() in src/lib/email-attachments-server.js, which reserves the bytes
// BEFORE the object is accounted for and rolls the reservation back on every
// refusal (quota, oversized, a failed insert). That reserve-then-check dance
// runs for a STAGED attachment exactly as it does for an inline one — reading
// `marker.sizeBytes` instead of a decoded buffer's length. A reservation here
// as well would therefore bill every IMAP attachment TWICE and silently halve
// the mailbox's 5 GB, with nothing on any screen to explain it. The shim does
// not meter for the same reason.
//
// What this module DOES owe the accounting is the thing that makes it
// idempotent: `attachment_index`. Mig 496 puts UNIQUE (message_id,
// attachment_index) on the rows, and re-processing is DESIGNED here — the
// cursor only advances on a 2xx (design §3.3), so a 5xx genuinely re-polls the
// same UID. So the array position an attachment occupies must be identical on
// every pass: the walk below is a plain deterministic depth-first traversal of
// a structure the server does not reorder, and the staged object key is built
// from that same position. Second pass ⇒ same index ⇒ same key ⇒ the object is
// overwritten and the route's own pre-check dedupes the row.
//
// ⚠️ PRECONDITION: `messageId` MUST BE A SAFE PATH SEGMENT ⚠️
// It is the value the payload carries as `MessageID`, and it is what the route
// re-derives the staged key from. stagedAttachmentPath() accepts
// /^[A-Za-z0-9_-]{1,64}$/ and nothing else. A MessageID outside that alphabet
// cannot key an object at all, so every attachment on the message degrades to
// `rehost_failed` — visible, never silent, and no bytes are uploaded that
// nothing would ever point at. canStageForMessage() below is exported so a
// caller can assert the precondition at the boundary rather than discover it
// one mailbox at a time.

import {
  EMAIL_ATTACHMENT_BUCKET,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentExtension,
  safeAttachmentFilename,
  safeMimeType,
} from '../email-attachment-quota'
import {
  failedAttachment,
  stagedAttachment,
  stagedAttachmentPath,
  strippedAttachment,
} from '../email-attachment-staging'

/**
 * A lower bound on a base64 part's DECODED size, as a fraction of the encoded
 * octet count BODYSTRUCTURE reports.
 *
 * The shim's number and the shim's reasoning: unwrapped base64 decodes to
 * exactly 3/4 of its length and line wrapping only lowers that ratio (~0.7305
 * at the usual 76-column wrap), so 0.72 is safely below both. If 0.72 × size
 * is already past the ceiling then the decoded file is past the ceiling, and
 * there is no reason to pull it down the wire to find out.
 */
const BASE64_DECODED_FLOOR = 0.72

/** base64 inflates 4/3, so a decoded part is 3/4 of its encoded octet count. */
const BASE64_DECODED_RATIO = 0.75

/**
 * Can a staged object key be built for this `MessageID` at all?
 *
 * Answered by ASKING THE CONTRACT — stagedAttachmentPath() throws on an id it
 * will not put in a path — rather than by copying its regex here. A copy is a
 * thing that drifts; a call is not.
 */
export function canStageForMessage(messageId) {
  try {
    stagedAttachmentPath({ postmarkMessageId: messageId, index: 0, extension: 'bin' })
    return true
  } catch {
    return false
  }
}

/** The `filename`/`name` a MIME part declares, if it declares one. */
function partFilename(node) {
  const name = node?.dispositionParameters?.filename || node?.parameters?.name || ''
  return typeof name === 'string' && name.trim() ? name : ''
}

/**
 * Is this leaf a FILE rather than the message body?
 *
 * Ordered from the strongest signal down. The last line is deliberately
 * permissive: a leaf that is neither text nor an embedded message is a file
 * even when the sender declared no disposition and no filename, which is
 * ordinary for the cid: images Apple Mail and Outlook produce. Erring the
 * other way would drop a member's photo with no row and no log line — the
 * exact silent-loss shape this feature is careful about everywhere else.
 */
function isAttachmentNode(node, type) {
  // No part id means nothing to FETCH — a container, or a structure we cannot
  // address. The walker descends into it instead.
  if (!node.part) return false

  const disposition = String(node.disposition || '').toLowerCase()
  if (disposition === 'attachment') return true
  if (partFilename(node)) return true

  // A cid: image referenced from the HTML body: inline, named by Content-ID
  // rather than by filename.
  if (disposition === 'inline' && node.id) return true

  // text/plain + text/html with no disposition and no name ARE the body; they
  // become TextBody/HtmlBody, not files. message/* is a container — the walk
  // descends into a forwarded message and picks up ITS attachments, which is
  // what an operator expects to see on the ticket.
  if (type.startsWith('text/')) return false
  if (type.startsWith('message/')) return false

  return true
}

/**
 * Every part of one message that should become an `Attachments` entry, in the
 * order the array will carry them.
 *
 * PURE, and the order is load-bearing — see the idempotency note in the header.
 * Depth-first, left to right, over a structure the IMAP server derives from the
 * message itself, so two polls of the same UID produce the same list.
 *
 * @param {object} bodyStructure imapflow's parsed BODYSTRUCTURE
 * @returns {Array<{part:string, contentType:string, filename:string,
 *                  contentId:string, encoding:string, size:number}>}
 */
export function attachmentParts(bodyStructure) {
  const out = []

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || '').toLowerCase()

    // multipart/* holds no bytes of its own, ever.
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) walk(child)
      return
    }

    if (isAttachmentNode(node, type)) {
      out.push({
        part: String(node.part),
        contentType: type,
        filename: partFilename(node),
        // Postmark hands a bare Content-ID; MIME wraps it in angle brackets.
        contentId: String(node.id || '').replace(/^<|>$/g, ''),
        encoding: String(node.encoding || '').toLowerCase(),
        size: Number(node.size) || 0,
      })
      // An attached .eml is ONE file. Descending would stage its innards as
      // separate attachments the recipient never sees as separate files.
      return
    }

    for (const child of node.childNodes || []) walk(child)
  }

  walk(bodyStructure)
  return out
}

/**
 * The decoded size we are willing to claim for a part we have not downloaded.
 *
 * BODYSTRUCTURE reports the ENCODED octet count. It is the server's number
 * rather than the sender's, so it is better than Postmark's `ContentLength` —
 * but it is still only ever used where the alternative is no size at all
 * (`too_many`, and a `too_large` screened before the download). The number that
 * decides the quota is always a real decoded length.
 */
function estimatedDecodedBytes({ size, encoding }) {
  if (!Number.isFinite(size) || size <= 0) return 1 // size_bytes > 0 is a CHECK
  const decoded = encoding === 'base64' ? Math.round(size * BASE64_DECODED_RATIO) : size
  return Math.max(1, decoded)
}

/**
 * Is this part past the ceiling on its encoded size alone?
 *
 * ONLY base64 gets the early screen. quoted-printable can decode to as little
 * as a third of its encoded length, so applying the same floor to it would mark
 * a perfectly ordinary file `too_large` — a wrongly-skipped attachment is a
 * worse outcome than one large buffer, and anything that passes here is still
 * checked exactly, on the decoded length, after the download.
 */
function exceedsCeilingBeforeDownload({ size, encoding }) {
  if (encoding !== 'base64') return false
  if (!Number.isFinite(size) || size <= 0) return false
  return size * BASE64_DECODED_FLOOR > MAX_ATTACHMENT_BYTES
}

/**
 * The Postmark-shaped entry for one part, BEFORE any marker is applied.
 *
 * `Content` is the empty string rather than absent, exactly as the shim leaves
 * it: it is the field whose SIZE is the entire reason staging exists, and an
 * absent one would make a staged payload structurally different from an inline
 * one for no gain. `Name` and `ContentType` are sanitised here as well as at
 * the route — both sanitisers are idempotent, and it keeps a stranger's control
 * characters out of this module's own log lines.
 */
function postmarkEntry(part) {
  const entry = {
    Name: safeAttachmentFilename(part.filename),
    Content: '',
    ContentType: safeMimeType(part.contentType),
    ContentLength: estimatedDecodedBytes(part),
  }
  // Only when the part actually has one — an empty ContentID on every ordinary
  // attachment would be a field Postmark does not send.
  if (part.contentId) entry.ContentID = part.contentId
  return entry
}

/**
 * Pull one part's bytes down the already-open connection.
 *
 * imapflow's downloadMany() DECODES base64/quoted-printable itself and returns
 * a Buffer keyed by part id, so `content.length` is a decoded length — the only
 * size this module trusts. (Its `maxBytes` option is accepted and then ignored
 * on this code path, so it is deliberately not passed: relying on it would look
 * like a cap and enforce nothing.)
 *
 * `ok:false` and `bytes:null` are DIFFERENT ANSWERS. A part that genuinely
 * holds nothing has no legal row and produces none; a fetch that FAILED means a
 * file demonstrably arrived and we do not have it, which must reach the route
 * as `rehost_failed` so it is on the ticket.
 */
async function downloadPart(client, uid, part) {
  try {
    const res = await client.downloadMany(uid, [part], { uid: true })
    const content = res?.[part]?.content
    if (!content || content.length === 0) return { ok: true, bytes: null }
    return { ok: true, bytes: content }
  } catch (err) {
    console.error('[imap-attachments] could not download part', part, '—', err?.message)
    return { ok: false, bytes: null }
  }
}

/**
 * Put one attachment's bytes in the bucket.
 *
 * `upsert: true` because the key is deterministic: a re-poll of the same UID
 * rewrites the identical object rather than erroring on an existing key or
 * leaving a second copy nothing is accounting for.
 *
 * Never throws. A supabase-js builder RESOLVES with `{ error }` rather than
 * rejecting, so the destructure is the real check and the try/catch is only
 * there for the client itself blowing up.
 */
async function uploadStagedBytes(db, path, bytes, mime) {
  try {
    const { error } = await db.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: true })
    if (error) {
      console.error('[imap-attachments] upload failed for', path, '—', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[imap-attachments] upload threw for', path, '—', err?.message)
    return false
  }
}

/**
 * One part, end to end.
 *
 * @returns {Promise<{attachment: object, reason?: string}>} `reason` is absent
 *   when the bytes were staged. Otherwise it is the `skipped_reason` the route
 *   will record — except `empty`, which is the one outcome that produces no row
 *   at all (see the header) and is reported only so a poller log can say so.
 */
async function stageOne(db, client, { part, index, uid, messageId, canStage }) {
  const entry = postmarkEntry(part)

  // Past the per-message cap the route records the file from `ContentLength`
  // under `too_many` without ever consulting a marker, so there is nothing to
  // stage — and nothing to download either, which is the whole point of the cap.
  if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return { attachment: strippedAttachment(entry), reason: 'too_many' }
  }

  // No usable key ⇒ no upload. Marked rather than dropped so the file is on the
  // ticket, and NOT uploaded, so there are no bytes in a metered bucket that
  // nothing will ever name.
  if (!canStage) {
    return { attachment: failedAttachment(entry, { reason: 'upload_failed' }), reason: 'rehost_failed' }
  }

  if (exceedsCeilingBeforeDownload(part)) {
    return { attachment: failedAttachment(entry, { reason: 'too_large' }), reason: 'too_large' }
  }

  const downloaded = await downloadPart(client, uid, part.part)
  if (!downloaded.ok) {
    return { attachment: failedAttachment(entry, { reason: 'upload_failed' }), reason: 'rehost_failed' }
  }
  if (!downloaded.bytes) {
    // No marker, `Content` already empty: the route's inline path answers
    // "nothing usable" and writes nothing, identical to the shim's undecodable
    // branch and to the pre-shim world.
    return { attachment: entry, reason: 'empty' }
  }

  const bytes = downloaded.bytes
  entry.ContentLength = bytes.length // the estimate is now a measurement

  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { attachment: failedAttachment(entry, { reason: 'too_large' }), reason: 'too_large' }
  }

  let path
  try {
    path = stagedAttachmentPath({
      postmarkMessageId: messageId,
      index,
      extension: attachmentExtension(entry.ContentType),
    })
  } catch (err) {
    // canStage already proved the id is usable, so reaching here is a bug in
    // this file rather than bad input — but a bug must still not lose the file.
    console.error('[imap-attachments] refusing to build a staged path:', err?.message)
    return { attachment: failedAttachment(entry, { reason: 'upload_failed' }), reason: 'rehost_failed' }
  }

  if (!await uploadStagedBytes(db, path, bytes, entry.ContentType)) {
    return { attachment: failedAttachment(entry, { reason: 'upload_failed' }), reason: 'rehost_failed' }
  }

  return { attachment: stagedAttachment(entry, { path, sizeBytes: bytes.length }) }
}

/**
 * Stage every attachment on one IMAP message and hand back the payload's
 * `Attachments` array.
 *
 * NEVER THROWS. The poller calls this on the path to POSTing a message that a
 * member is waiting on an answer to; there is no fault here worth failing that
 * for.
 *
 * @param {object} db      service-role Supabase client (Storage only)
 * @param {object} client  a connected, READ-ONLY imapflow client
 * @param {object} msg     an imapflow message: `{ uid, bodyStructure }`
 * @param {object} args
 * @param {string} args.mailboxId  email_mailboxes.id — for log context only
 * @param {string} args.messageId  the payload's `MessageID`. MUST be a safe path
 *   segment; see the precondition in the header.
 * @returns {Promise<{attachments: object[], skipped: Array<{name:string, reason:string}>}>}
 */
export async function stageImapAttachments(db, client, msg, { mailboxId, messageId } = {}) {
  const result = { attachments: [], skipped: [] }

  let parts
  try {
    parts = attachmentParts(msg?.bodyStructure)
  } catch (err) {
    // A bodyStructure shaped in a way the walk did not anticipate must not cost
    // the email. The message files with no attachments, loudly.
    console.error('[imap-attachments] could not walk bodyStructure', { mailboxId }, '—', err?.message)
    return result
  }
  if (parts.length === 0) return result

  const canStage = canStageForMessage(messageId)
  if (!canStage) {
    // Not a per-file fault — the id is wrong for EVERY file on EVERY message
    // from this mailbox, so it is said once, at error level, naming the cause.
    console.error(
      '[imap-attachments] MessageID is not a safe path segment, so no attachment on this ' +
      'message can be staged; all will be recorded rehost_failed.',
      { mailboxId, attachments: parts.length },
    )
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    try {
      const { attachment, reason } = await stageOne(db, client, {
        part, index, uid: msg?.uid, messageId, canStage,
      })
      result.attachments.push(attachment)
      if (reason) result.skipped.push({ name: safeAttachmentFilename(part.filename), reason })
    } catch (err) {
      // Belt and braces on top of stageOne's own guards: one part is never
      // allowed to take the message — or the rest of its attachments — with it.
      console.error('[imap-attachments] part', part.part, 'threw:', err?.message)
      result.attachments.push(
        failedAttachment(postmarkEntry(part), { reason: 'upload_failed' }),
      )
      result.skipped.push({ name: safeAttachmentFilename(part.filename), reason: 'rehost_failed' })
    }
  }

  return result
}
