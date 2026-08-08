// EMAIL-OUTBOUND-ATTACH.1 — pure rules for attachments STAFF send: the size
// ceiling, the draft object key, and the sentences an operator reads when a
// file will not go.
//
// Pure: no DB, no Buffer, no clock, no env, no fetch. Imported by the composer
// UI as well as the routes, so it must stay runnable in a browser bundle — the
// same constraint email-attachment-quota.js works under, and the reason the
// filename/mime/path primitives are reused from there rather than re-derived.
// The IO lives in src/lib/email-outbound-attachments-server.js.
//
// ══ WHY THE BYTES DO NOT TRAVEL THROUGH THE ROUTE ═══════════════════
// A Vercel function rejects a request body over ~4.5 MB with a 413 BEFORE the
// handler runs — the same platform limit that forced the inbound Edge shim
// (EMAIL-INBOUND-SHIM.1). A multipart POST carrying a 6 MB attachment to
// /api/email/tickets/[id]/reply would therefore fail with none of this code
// running, and the operator would see a bare 413 with no explanation.
//
// So the browser uploads each file DIRECTLY to the private `email-attachments`
// bucket and the send request carries only a REFERENCE. Vercel's own guidance
// points at exactly this shape, and the repo already runs it four times over
// (card receipts, contractor invoices, WhatsApp template media, landing-page
// media): a server route mints a short-lived signed upload token for a path IT
// chose, and the browser's uploadToSignedUrl is authorised by that token alone.
//
// ══ THE CLIENT NEVER NAMES A PATH ═══════════════════════════════════
// Not "the path is validated" — the path is never accepted in the first place.
// The sign route BUILDS the key from ids it holds (the caller's own profile id)
// plus two small caller-supplied integers/uuids it shape-checks, and the send
// route RE-BUILDS the identical key from the same inputs. A client that lies
// about the mime re-derives a different extension, the object is not there, and
// the send is refused before anything leaves — it cannot reach another key.
//
// Because the caller's profile id is a path segment, the worst a staff account
// can address is its own drafts. It can never name:
//   • another person's draft (different profile segment),
//   • the canonically-keyed `<location_id>/…` half of the bucket (a location id
//     is a uuid, so it can never be the literal `outbound`),
//   • the shim's `inbound/…` half, for the same reason,
//   • anything up a `../` (every segment is regex-pinned).

import { attachmentExtension, formatBytes } from './email-attachment-quota'

/**
 * The bucket prefix every staff-uploaded draft object lives under.
 *
 * A THIRD segregated half of the bucket, alongside `inbound/` (the shim) and
 * `<location_id>/…` (canonical). Segregation is what lets a future orphan sweep
 * bound its search space exactly — and drafts are the one population that CAN
 * be orphaned by an operator simply closing a tab.
 */
export const OUTBOUND_DRAFT_PREFIX = 'outbound'

/**
 * Postmark's hard ceiling for one message, in bytes, MEASURED AFTER BASE64.
 *
 * Verified against Postmark's own support article (postmarkapp.com/support/
 * article/1056, read 2026-08-07) rather than taken on trust: "Total message
 * size, including attachments, can be 10 MB" and "We calculate the size of the
 * email after it has been base64 encoded, so please keep in mind your final
 * email size may be larger after being encoded."
 *
 * 10_000_000 rather than 10_485_760 on purpose. Postmark writes "10 MB" and
 * does not say which MB it means; the decimal reading is the smaller of the
 * two, so choosing it can only ever refuse a message Postmark would have
 * accepted — never the reverse, which is a 422 the operator eats after typing
 * a reply.
 */
export const POSTMARK_MAX_MESSAGE_BYTES = 10_000_000

/**
 * How large a base64 encoding of `byteLength` raw bytes is.
 *
 * Exact, not a 4/3 approximation: base64 pads to a multiple of 4 characters,
 * so the real figure is ceil(n/3)*4. At the ceiling below the difference is
 * three bytes — irrelevant to the budget, but this function is what the
 * headroom argument is checked against, and an approximation there would make
 * the argument approximate too.
 */
export function base64Bytes(byteLength) {
  const n = Number(byteLength)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.ceil(n / 3) * 4
}

/**
 * The most RAW file bytes one email may carry, across all its attachments.
 *
 * 7 MiB, chosen from the Postmark ceiling rather than picked:
 *   base64Bytes(7_340_032) = 9_786_712, which leaves 213_288 bytes of the
 *   10_000_000 for everything else in the message — the body (capped at 10,000
 *   characters, so ~10 KB of text plus its HTML twin), the signature, the
 *   subject, the threading headers and the MIME scaffolding. That is an order
 *   of magnitude more headroom than those need.
 *
 * Enforced SERVER-SIDE on the true downloaded byte lengths (see the server
 * module) — the figure the browser reports is a courtesy so the operator finds
 * out before they type, never the thing that decides.
 */
export const MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024

/**
 * How many files one email may carry.
 *
 * Well under the inbound MAX_ATTACHMENTS_PER_MESSAGE of 25: a staff member
 * attaching eleven files to a support reply has made a mistake, and each one
 * costs a Storage round-trip inside the send request.
 */
export const MAX_OUTBOUND_ATTACHMENTS = 10

// A value we are willing to put in an object key: no dot, no slash, no dot-dot,
// nothing that could add or climb a segment. Byte-identical to the rule
// attachmentObjectPath and stagedAttachmentPath already apply, restated here so
// this module has no hidden dependency on a private constant next door.
//
// Deliberately NOT "must be a uuid", even though both values are one in
// practice. The security property this regex carries is "cannot steer the key",
// and it carries it completely; UUID-SHAPED is a separate, narrower claim that
// belongs at the request boundary, where the routes already pin `draft_id` with
// `uuidLike`. Pinning it twice, in different vocabularies, is how the two drift.
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

// The extension the key ends in. Alphanumeric only, so it cannot contribute a
// dot, a slash or a dot-dot.
const EXTENSION = /^[a-z0-9]{1,8}$/

/** Is `index` one of the small non-negative integers a draft slot may use? */
export function isDraftIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < MAX_OUTBOUND_ATTACHMENTS
}

/**
 * Where ONE staff-uploaded file waits between the browser upload and the send:
 *
 *   outbound/<profile_id>/<draft_id>/<index>.<ext>
 *
 * THE PROFILE ID IS THE SECURITY BOUNDARY. It is the caller's own, read from
 * the session on the server and never from the request, so every key a person
 * can mint or re-derive sits under their own prefix.
 *
 * `draft_id` is one composer session — a uuid the browser makes when the
 * composer opens. It is caller-supplied and therefore shape-checked, but it
 * carries no authority: colliding with your own other draft overwrites your own
 * object and nobody else's.
 *
 * `index` is the file's slot in that composer. Together the two make the key
 * DETERMINISTIC, which is what lets the send route re-derive it from the same
 * inputs instead of being handed a string to trust, and what makes re-uploading
 * a retried file overwrite rather than accumulate.
 *
 * Throws rather than coercing, exactly like attachmentObjectPath: a caller that
 * reached here with a bad id has a bug, and inventing a key for it would put a
 * file somewhere nothing will ever look.
 */
export function outboundDraftPath({ profileId, draftId, index, mime } = {}) {
  if (!PATH_SEGMENT.test(String(profileId ?? ''))) {
    throw new Error('outboundDraftPath: profileId is not a safe path segment')
  }
  if (!PATH_SEGMENT.test(String(draftId ?? ''))) {
    throw new Error('outboundDraftPath: draftId is not a safe path segment')
  }
  if (!isDraftIndex(index)) {
    throw new Error('outboundDraftPath: index must be a small non-negative integer')
  }
  const ext = attachmentExtension(mime)
  // attachmentExtension already guarantees this, but the key is the one value
  // in this module that must never be wrong, so it is asserted rather than
  // assumed across a module boundary.
  if (!EXTENSION.test(ext)) {
    throw new Error('outboundDraftPath: refusing an unsafe extension')
  }
  return `${OUTBOUND_DRAFT_PREFIX}/${profileId}/${draftId}/${index}.${ext}`
}

/**
 * Do these drafts describe a set we are willing to look at, before any IO?
 *
 * Two rules, both about the KEY rather than the file: a draft slot may appear
 * once (two entries at one index address one object, so the same bytes would be
 * attached twice and then filed as two rows pointing at one key), and there is
 * a ceiling on how many there are.
 *
 * @returns {null|string} an operator-facing sentence, or null when the set is fine
 */
export function draftSetError(drafts) {
  if (!Array.isArray(drafts) || drafts.length === 0) return null
  if (drafts.length > MAX_OUTBOUND_ATTACHMENTS) {
    return `You can attach up to ${MAX_OUTBOUND_ATTACHMENTS} files to one email.`
  }
  const seen = new Set()
  for (const draft of drafts) {
    if (!isDraftIndex(draft?.index)) return 'One of the attached files is not valid — remove it and try again.'
    const key = `${draft?.draft_id}:${draft.index}`
    if (seen.has(key)) return 'The same file was attached twice — remove the duplicate and try again.'
    seen.add(key)
  }
  return null
}

/** Would this many raw file bytes push the message past what Postmark takes? */
export function exceedsOutboundTotal(totalBytes, limit = MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
  const n = Number(totalBytes)
  // Unreadable total ⇒ refuse, the same direction exceedsQuota fails in.
  if (!Number.isFinite(n)) return true
  return n > limit
}

/**
 * What an operator reads when the files are too big. NAMES THE LIMIT and says
 * what they actually have, because "attachment too large" with no number is a
 * message people retry unchanged.
 *
 * Deliberately not a 500 and deliberately not a silent truncation: an email
 * that quietly left one file behind is the failure this whole feature exists to
 * make impossible in the other direction.
 */
export function outboundSizeError(totalBytes) {
  return `Those files come to ${formatBytes(totalBytes)}. One email can carry ` +
    `${formatBytes(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES)} of attachments in total ` +
    '(the mail provider\'s ceiling). Nothing was sent — remove one and try again, ' +
    'or send them across two emails.'
}

/** The same sentence for a SINGLE file the composer can reject before uploading. */
export function outboundFileTooLargeError(filename, sizeBytes) {
  return `${filename} is ${formatBytes(sizeBytes)} — one email can carry ` +
    `${formatBytes(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES)} of attachments in total.`
}

/** How much of the budget a set of already-chosen files has spent. */
export function draftBudget(files) {
  const used = (files || []).reduce((sum, f) => sum + (Number(f?.size) || 0), 0)
  return {
    used,
    limit: MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
    remaining: Math.max(0, MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES - used),
    over: used > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  }
}
