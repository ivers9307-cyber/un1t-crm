// EMAIL-ATTACH.1 — pure rules for inbound email attachments and the 5 GB
// per-mailbox storage quota. Mig 496.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// Pure: no DB, no Buffer, no clock, no env. The IO lives in
// src/lib/email-attachments-server.js; this module is imported by the operator
// UI as well, so it must stay runnable in a browser bundle.
//
// TWO THINGS HERE ARE SECURITY DECISIONS, NOT FORMATTING
//
// 1. THE STORAGE PATH IS BUILT FROM IDS AND NEVER FROM THE FILENAME.
//    `Name` arrives in an unauthenticated stranger's Postmark payload. Built
//    naively into an object path it accepts `../` traversal, absolute paths,
//    NUL bytes, and Unicode direction overrides that make `report.exe` render
//    as `report.txt`. attachmentObjectPath() takes location/message ids and an
//    array index — all ours — and refuses anything that is not a bare path
//    segment. The original filename is kept as DATA, for display only.
//
// 2. safeAttachmentFilename IS A DISPLAY SANITISER AND ALSO A DB GUARD.
//    Postgres text cannot hold a NUL byte at all (the insert errors), and a
//    lone UTF-16 surrogate cannot be encoded as valid UTF-8 — both are trivial
//    to put in a MIME filename, and both would turn "we received an email" into
//    a 500 on the webhook. Stripping them is what keeps the message filed.

// Richard, 2026-08-05: 5 GB per MAILBOX, not per location. A studio running
// accounts@, sales@ and studio@ therefore holds 3 × 5 GB, and a noisy sales
// inbox can never starve the accounts one. Rows carry their own quota_bytes
// (mig 496) so a plan tier can raise one later; this is the default.
export const EMAIL_MAILBOX_QUOTA_BYTES = 5 * 1024 * 1024 * 1024 // 5 GiB

// Warning thresholds. 100% is not an error state for the MESSAGE — inbound mail
// is never rejected — it is the point at which new attachments stop being kept.
export const QUOTA_WARNING_RATIO = 0.8
export const QUOTA_CRITICAL_RATIO = 0.95

export const EMAIL_ATTACHMENT_BUCKET = 'email-attachments'

// The bucket's own file_size_limit (mig 482), restated so the app can answer
// `too_large` with a row the operator can see instead of letting Storage answer
// with an opaque upload error and no record that a file ever arrived.
export const MAX_ATTACHMENT_BYTES = 26_214_400 // 25 MiB

// Postmark permits far more than this on paper; a mail carrying more is either
// a mistake or an attempt to make one webhook call do unbounded work. Anything
// past the cap is recorded as skipped rather than silently ignored.
export const MAX_ATTACHMENTS_PER_MESSAGE = 25

// email_ticket_attachments CHECKs (mig 483). Restated so the app trims BEFORE
// the insert — a constraint violation here would fail the whole attachment.
export const ATTACHMENT_FILENAME_MAX = 200 // DB allows 255; leave headroom
export const ATTACHMENT_MIME_MAX = 100

const FALLBACK_FILENAME = 'attachment'
const FALLBACK_MIME = 'application/octet-stream'

// Control characters (incl. NUL) and the bidirectional-override block. The
// second set is the `report<U+202E>gnp.exe` trick: it renders as report.exe.png
// while still being an executable, and it is a filename attack, not a rendering
// quirk.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g
const BIDI_OVERRIDES = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * A filename safe to store and to show. NEVER used to address storage.
 *
 * Returns 'attachment' rather than null for unusable input: the row must be
 * written either way (staff need to know a file arrived), and filename is NOT
 * NULL on the table.
 */
export function safeAttachmentFilename(name, fallback = FALLBACK_FILENAME) {
  if (typeof name !== 'string') return fallback

  let s = name
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_OVERRIDES, '')
    // Path separators are neutralised even though the path never uses this
    // value — defence in depth against a future caller that forgets.
    .replace(/[\\/]+/g, '_')

  // Lone surrogates cannot be encoded as UTF-8, so they would fail the insert
  // (and take the whole attachment with them). Spreading iterates by code
  // point, so a valid pair survives as one element and an orphan does not.
  s = [...s].filter(ch => {
    const cp = ch.codePointAt(0)
    return !(cp >= 0xd800 && cp <= 0xdfff)
  }).join('')

  // Leading dots hide the file on unix-ish viewers and `..` is the traversal
  // token; collapse runs of whitespace so a 300-space name cannot push the
  // real extension out of view.
  s = s.replace(/^\.+/, '').replace(/\s+/g, ' ').trim()
  if (!s) return fallback

  // Slice by code point, not UTF-16 unit, so the cut cannot split a pair back
  // into the orphans just removed. Postgres length() counts characters, so 200
  // code points is comfortably inside the 255 CHECK.
  return [...s].slice(0, ATTACHMENT_FILENAME_MAX).join('')
}

// A MIME type is `type/subtype` in a restricted token alphabet (RFC 2045). Any
// parameters (`; charset=…`, `; name="../x"`) are dropped — we only ever use
// the essence, and the parameter is another place a stranger can put text.
const MIME_SHAPE = /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,60}$/

/** A storable, servable Content-Type, or application/octet-stream. */
export function safeMimeType(value) {
  if (typeof value !== 'string') return FALLBACK_MIME
  const essence = value.split(';')[0].trim().toLowerCase()
  if (!MIME_SHAPE.test(essence)) return FALLBACK_MIME
  return essence.slice(0, ATTACHMENT_MIME_MAX)
}

/**
 * The object's extension, derived from the (already sanitised) MIME essence and
 * never from the filename. Alphanumerics only, so it cannot contribute a dot,
 * a slash or a dot-dot to the path.
 */
export function attachmentExtension(mime) {
  const essence = safeMimeType(mime)
  const sub = essence.slice(essence.indexOf('/') + 1).replace(/[^a-z0-9]/g, '')
  if (!sub) return 'bin'
  // A couple of aliases so the common cases look right when an operator is
  // staring at the bucket; everything else takes its subtype verbatim.
  if (sub === 'jpeg') return 'jpg'
  if (sub === 'plain') return 'txt'
  return sub.slice(0, 8)
}

// A uuid, and nothing that could add a path segment. Deliberately stricter than
// `uuidLike` (which is Postgres-permissive): these values become part of an
// object key, so "looks like an id" is not good enough.
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Where the bytes live inside the private `email-attachments` bucket:
 *
 *   <location_id>/<message_id>/<index>.<ext>
 *
 * Every component is ours. The index makes it DETERMINISTIC — a re-processed
 * delivery (the dedupe claim is released on 5xx, so retries genuinely re-run)
 * uploads to the same key and overwrites byte-identical content rather than
 * leaving a second copy nobody is accounting for.
 *
 * Throws rather than coercing: a caller that reached here with a bad id has a
 * bug, and inventing a path for it would put a member's file somewhere nothing
 * will ever look.
 */
export function attachmentObjectPath({ locationId, messageId, index, mime } = {}) {
  if (!PATH_SEGMENT.test(String(locationId ?? ''))) {
    throw new Error('attachmentObjectPath: locationId is not a safe path segment')
  }
  if (!PATH_SEGMENT.test(String(messageId ?? ''))) {
    throw new Error('attachmentObjectPath: messageId is not a safe path segment')
  }
  if (!Number.isInteger(index) || index < 0 || index > 9999) {
    throw new Error('attachmentObjectPath: index must be a small non-negative integer')
  }
  return `${locationId}/${messageId}/${index}.${attachmentExtension(mime)}`
}

/**
 * Would a mailbox holding `bytesAfter` be over its ceiling?
 *
 * Takes the total AFTER the increment on purpose. The writer reserves its bytes
 * through the atomic RPC, reads the returned total and asks this — so two
 * attachments landing at once cannot both be told there is room. A
 * check-then-reserve would be exactly the race the counter exists to remove.
 */
export function exceedsQuota(bytesAfter, quotaBytes = EMAIL_MAILBOX_QUOTA_BYTES) {
  // `Number(null)` is 0, so a missing total would otherwise read as "empty
  // mailbox, plenty of room" — the exact wrong direction to fail in. Absent is
  // not zero.
  if (bytesAfter === null || bytesAfter === undefined) return true
  const after = Number(bytesAfter)
  const quota = Number(quotaBytes) || EMAIL_MAILBOX_QUOTA_BYTES
  if (!Number.isFinite(after)) return true // unreadable total ⇒ refuse to store
  return after > quota
}

/**
 * How full a mailbox is, and what to say about it.
 *
 * `level` is one of ok / warning (≥80%) / critical (≥95%) / full (≥100%).
 * `percent` is clamped for display only — `ratio` keeps the true value so an
 * over-quota mailbox is still visibly over.
 */
export function quotaStatus(bytesUsed, quotaBytes = EMAIL_MAILBOX_QUOTA_BYTES) {
  const quota = Number(quotaBytes) > 0 ? Number(quotaBytes) : EMAIL_MAILBOX_QUOTA_BYTES
  const used = Math.max(0, Number(bytesUsed) || 0)
  const ratio = used / quota
  const level =
    ratio >= 1 ? 'full'
      : ratio >= QUOTA_CRITICAL_RATIO ? 'critical'
        : ratio >= QUOTA_WARNING_RATIO ? 'warning'
          : 'ok'
  return {
    used,
    quota,
    remaining: Math.max(0, quota - used),
    ratio,
    percent: Math.min(100, Math.round(ratio * 100)),
    level,
    full: level === 'full',
  }
}

/** Operator-facing sentence for a level. Empty string at `ok` — no news. */
export function quotaMessage(status) {
  switch (status?.level) {
    case 'full':
      return 'Full — new attachments are no longer being stored. Messages still arrive in full; free up space to start keeping files again.'
    case 'critical':
      return 'Almost full. Free up space now — at 100% new attachments stop being stored.'
    case 'warning':
      return 'Filling up. Worth clearing old attachments before it reaches the ceiling.'
    default:
      return ''
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human bytes. Base 1024, because the quota is a GiB. */
export function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1 }
  const decimals = i === 0 ? 0 : (v < 10 ? 1 : 0)
  return `${v.toFixed(decimals)} ${UNITS[i]}`
}

/** What staff see next to an attachment that is not in the bucket. */
export const SKIPPED_REASON_LABEL = {
  quota: 'Not stored — mailbox was full',
  too_large: 'Not stored — over the size limit',
  // Its own reason rather than folded into too_large: staff ACT on this text,
  // and "over the size limit" would send them asking a member to compress a
  // file that was never oversized.
  too_many: 'Not stored — too many files on one email',
  rehost_failed: 'Not stored — upload failed',
  pruned: 'Removed to free space',
}

/** Every value the DB CHECK allows (mig 496 adds 'pruned'). */
export const SKIPPED_REASONS = Object.keys(SKIPPED_REASON_LABEL)
