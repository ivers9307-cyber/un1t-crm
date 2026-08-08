// EMAIL-INBOUND-SHIM.1 — the wire contract between the Supabase Edge Function
// that fronts the Postmark inbound webhook and the Vercel route behind it.
//
// Pure: no DB, no Buffer, no clock, no env, no fetch. The IO lives in
// src/lib/email-attachments-server.js (Vercel side) and
// supabase/functions/postmark-inbound-shim/index.ts (Deno side).
//
// ══ WHY THERE IS A SHIM AT ALL ══════════════════════════════════════
// A Vercel function rejects a request body over ~4.5 MB with a 413 BEFORE the
// handler runs. Postmark base64-inlines inbound attachments (~4/3 expansion),
// so anything past ~3.3 MB of attachment bytes never reached the webhook at
// all: Postmark saw a 413, retried, gave up, and the email was never filed.
// Gmail and Outlook both allow 25 MB, so this rejected ordinary mail.
//
// The Edge Function moves the bytes to the private `email-attachments` bucket
// itself, replaces each `Content` with a REFERENCE, and forwards the now-small
// JSON to the same Vercel route. Filing — threading, mailbox routing, dedupe,
// ticket identity — is untouched and stays in exactly one place.
//
// ══ THIS FILE IS THE CONTRACT, AND IT IS MIRRORED IN TYPESCRIPT ═════
// The Deno function cannot import src/lib (different runtime, and the Supabase
// CLI bundles only the function directory), so the WRITER side of this contract
// is re-implemented there by hand. That duplication is guarded two ways:
//   • the round-trip tests below run this module's writer into this module's
//     reader, so the pair can never disagree with itself;
//   • email-attachment-staging.contract.test.js reads the .ts file off disk and
//     asserts it still declares the same prefix, marker key and limits — so a
//     change here fails a test that names the file that must change with it.
//
// ══ THE MARKER IS DELIBERATELY NOT POSTMARK-SHAPED ══════════════════
// Postmark's own attachment fields are PascalCase (`Name`, `Content`,
// `ContentType`, `ContentLength`). The marker key is `_un1t_staged` so it can
// never collide with a field Postmark adds later, and so anyone reading a
// dead-lettered payload can see at a glance which parts are ours.
//
// ══ THE PATH IS VALIDATED, NEVER TRUSTED ════════════════════════════
// The forwarding hop is authenticated, but `storage_path` is written into a row
// that later addresses the bucket, so the reader re-derives the shape it
// expects from ids IT holds (Postmark's MessageID off the payload, the index
// off the array position) and refuses anything else. A marker cannot therefore
// point at another message's object, at the canonically-keyed
// `<location_id>/…` half of the bucket, or anywhere up a `../`.

/**
 * The bucket prefix every shim-written object lives under.
 *
 * SEGREGATED ON PURPOSE. Canonically-keyed objects (the inline-base64 path,
 * which still runs whenever the shim is bypassed) are `<location_id>/…`. A
 * location id is a uuid, so it can never be the literal `inbound`, and the two
 * halves of the bucket can therefore never overlap — which is what lets a
 * future orphan sweep bound its search space exactly.
 */
export const STAGED_PREFIX = 'inbound'

/** The attachment field the shim adds. Non-Postmark-shaped on purpose. */
export const STAGED_MARKER_KEY = '_un1t_staged'

/**
 * Marker schema version. Present so a future change can be additive rather
 * than a flag day: the shim and the route deploy independently and there is
 * always a window where one is newer than the other.
 */
export const STAGED_MARKER_VERSION = 1

/**
 * Why the shim did not move an attachment's bytes, mapped to the
 * `skipped_reason` the route records. Both values already exist in mig 496's
 * CHECK — the shim introduces no new vocabulary, it just reaches the same
 * outcomes one hop earlier.
 */
export const STAGED_ERROR_REASONS = {
  // Past MAX_ATTACHMENT_BYTES. Screened on the base64 LENGTH before decoding,
  // so a 30 MB file never becomes a 30 MB buffer inside a 150 MB function.
  too_large: 'too_large',
  // Storage refused the upload, or the decode produced nothing usable.
  upload_failed: 'rehost_failed',
}

// Deliberately stricter than `uuidLike`: this value becomes a path segment.
// Postmark's MessageID is a uuid, but nothing about the payload is ours.
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

// The extension the shim chose. Alphanumeric only, so it cannot contribute a
// dot, a slash or a dot-dot. Deliberately NOT re-derived from the mime here —
// see stagedPathMatches.
const EXTENSION = /^[a-z0-9]{1,8}$/

const MAX_INDEX = 9999

/** Is this a value we are willing to put in an object key? */
function safeSegment(value) {
  return PATH_SEGMENT.test(String(value ?? ''))
}

function safeIndex(index) {
  return Number.isInteger(index) && index >= 0 && index <= MAX_INDEX
}

/**
 * Where the shim puts one attachment's bytes:
 *
 *   inbound/<postmark_message_id>/<index>.<ext>
 *
 * THE SHIM KNOWS NEITHER OF THE IDS THE CANONICAL KEY USES. `location_id`
 * comes from resolving the recipient against email_mailboxes and `message_id`
 * is our own row id — both decided AFTER forwarding. So the key is built from
 * the only stable identity available before the hop: Postmark's `MessageID`,
 * which is the same on every retry, and the attachment's position in Postmark's
 * own `Attachments` array, which is the same value mig 496's
 * UNIQUE (message_id, attachment_index) is keyed on.
 *
 * DETERMINISTIC IS THE WHOLE POINT. The webhook releases its dedupe claim on
 * any 5xx so Postmark's retry genuinely re-processes the message
 * (EMAIL-DEDUPE-RELEASE.1). A retry therefore re-uploads — and because the key
 * is a function of the payload alone it OVERWRITES the identical object rather
 * than leaving a second copy nothing is accounting for.
 *
 * Throws rather than coercing, exactly like attachmentObjectPath: a caller that
 * reached here with a bad id has a bug, and inventing a key for it would put a
 * member's file somewhere nothing will ever look.
 *
 * @param {object} args
 * @param {string} args.postmarkMessageId Postmark's `MessageID`
 * @param {number} args.index             position in `Attachments`
 * @param {string} args.extension         already-safe extension (see attachmentExtension)
 */
export function stagedAttachmentPath({ postmarkMessageId, index, extension } = {}) {
  if (!safeSegment(postmarkMessageId)) {
    throw new Error('stagedAttachmentPath: postmarkMessageId is not a safe path segment')
  }
  if (!safeIndex(index)) {
    throw new Error('stagedAttachmentPath: index must be a small non-negative integer')
  }
  const ext = EXTENSION.test(String(extension ?? '')) ? extension : 'bin'
  return `${STAGED_PREFIX}/${postmarkMessageId}/${index}.${ext}`
}

/**
 * Does `path` address the object the shim should have written for THIS
 * (message, index)?
 *
 * The extension is checked for SHAPE but not for VALUE, on purpose. It is
 * cosmetic — the mime is stored in its own column and the extension addresses
 * nothing else — while the mime→extension mapping is duplicated across two
 * runtimes. Pinning the exact character would turn a harmless drift in that
 * mapping into `rehost_failed` for a file that is sitting correctly in the
 * bucket. The prefix, the message id and the index ARE pinned, and those are
 * the three that carry the security weight: together they make it impossible
 * for a marker to name another message's object, a canonically-keyed object,
 * or anything outside the bucket's staged half.
 */
export function stagedPathMatches(path, { postmarkMessageId, index } = {}) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (!safeSegment(postmarkMessageId) || !safeIndex(index)) return false

  const parts = path.split('/')
  if (parts.length !== 3) return false
  const [prefix, messageSegment, leaf] = parts
  if (prefix !== STAGED_PREFIX) return false
  if (messageSegment !== String(postmarkMessageId)) return false

  const dot = leaf.lastIndexOf('.')
  if (dot <= 0) return false
  if (leaf.slice(0, dot) !== String(index)) return false
  return EXTENSION.test(leaf.slice(dot + 1))
}

// ── Writer (mirrored in the Deno function) ──────────────────────────

/**
 * The attachment as it goes on the wire once its bytes are in the bucket.
 *
 * `Content` is emptied rather than deleted: it is the field whose SIZE is the
 * entire problem, and an absent one would make a payload that has been through
 * the shim structurally different from one that has not, for no gain. Every
 * other Postmark field survives untouched — `Name`, `ContentType` and
 * `ContentLength` are what a dead-lettered payload is triaged on.
 */
export function stagedAttachment(attachment, { path, sizeBytes }) {
  return {
    ...attachment,
    Content: '',
    [STAGED_MARKER_KEY]: {
      v: STAGED_MARKER_VERSION,
      path,
      // The DECODED length, measured by the shim. Not `ContentLength` (sender
      // supplied) and not the base64 length (~4/3 too big — metering that
      // would over-count every mailbox by a third).
      bytes: sizeBytes,
    },
  }
}

/**
 * The attachment as it goes on the wire when the shim could NOT move its bytes.
 *
 * THE MESSAGE IS FORWARDED ANYWAY. That is the governing rule of the route the
 * shim now sits in front of, and it extends to the shim unchanged: a file that
 * could not be moved must never be able to stop an email being filed. The
 * marker carries the reason so the route records a row an operator can act on
 * ("invoice.pdf — not stored, upload failed") instead of the file vanishing.
 */
export function failedAttachment(attachment, { reason }) {
  return {
    ...attachment,
    Content: '',
    [STAGED_MARKER_KEY]: {
      v: STAGED_MARKER_VERSION,
      error: STAGED_ERROR_REASONS[reason] ? reason : 'upload_failed',
    },
  }
}

/**
 * The attachment as it goes on the wire when the shim deliberately did not
 * look at it — past MAX_ATTACHMENTS_PER_MESSAGE.
 *
 * No marker: the route's own `too_many` branch fires on the array position
 * before it ever consults one, and it records the row from `ContentLength`,
 * which is preserved here. Emptying `Content` is still required or the payload
 * stays fat for exactly the messages most likely to be fat.
 */
export function strippedAttachment(attachment) {
  return { ...attachment, Content: '' }
}

// ── Reader (Vercel side) ────────────────────────────────────────────

/**
 * What does this attachment's marker say, and may we believe it?
 *
 * @returns {{kind:'inline'}
 *          |{kind:'staged', path:string, sizeBytes:number}
 *          |{kind:'skip', reason:string}}
 *
 *   inline  no marker — the original base64 shape. STILL FULLY SUPPORTED: it
 *           is what runs if the shim is ever bypassed, mis-deployed or rolled
 *           back, and every attachment test written before the shim covers it.
 *   staged  the bytes are already in the bucket at `path`.
 *   skip    record a row with this skipped_reason and store nothing. Covers
 *           both "the shim told us it could not move this" and "the marker is
 *           not one we are willing to act on".
 *
 * A MALFORMED MARKER IS NEVER TREATED AS INLINE. Falling back to decoding
 * would be decoding the empty string the shim left behind — which produces no
 * row at all, so the file would disappear with no record. `rehost_failed` is
 * the honest answer: something arrived, we do not have it, and staff can ask
 * for a resend.
 */
export function readStagedMarker(attachment, { postmarkMessageId, index } = {}) {
  const marker = attachment?.[STAGED_MARKER_KEY]
  if (marker === undefined || marker === null) return { kind: 'inline' }
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    return { kind: 'skip', reason: 'rehost_failed' }
  }

  if (marker.error !== undefined) {
    const reason = STAGED_ERROR_REASONS[marker.error]
    return { kind: 'skip', reason: reason || 'rehost_failed' }
  }

  if (!stagedPathMatches(marker.path, { postmarkMessageId, index })) {
    return { kind: 'skip', reason: 'rehost_failed' }
  }

  // The size decides the quota and moves a counter that costs real money, so
  // it has to be a plain positive integer. `Number(null)` is 0 and
  // `Number('12')` is 12 — neither is something to accept silently here.
  const bytes = marker.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
    return { kind: 'skip', reason: 'rehost_failed' }
  }

  return { kind: 'staged', path: marker.path, sizeBytes: bytes }
}

/**
 * Every object the shim claims to have written for this payload — the input to
 * "throw these away, nothing is ever going to point at them".
 *
 * Validated exactly as readStagedMarker validates it, so a path this returns
 * can only ever be one the shim itself could have produced for this message.
 * A remove() driven by an unvalidated string would be a delete-anything
 * primitive reachable from a webhook payload.
 */
export function stagedPathsIn(attachments, { postmarkMessageId } = {}) {
  if (!Array.isArray(attachments)) return []
  const paths = []
  for (let index = 0; index < attachments.length; index += 1) {
    const marker = readStagedMarker(attachments[index], { postmarkMessageId, index })
    if (marker.kind === 'staged') paths.push(marker.path)
  }
  return paths
}
