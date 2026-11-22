// INVOICES.1 — helpers for the Dext-style inbound_invoices flow.
//
// Owns:
//   • parseInboundAddress(toAddress)  — extract slug from
//     <slug>-invoices@mail.un1tdublin.com (case insensitive, robust
//     to "Display Name <addr>" and "+tag" variants). mail. subdomain
//     is the dedicated inbound MX host so the marketing apex
//     (un1tdublin.com) is free to keep its own MX records.
//   • status transition validation — the inbox UI and the API
//     routes both reach for this to enforce the legal state moves
//   • storage path helper — keeps per-location partitioning
//     consistent across the webhook + UI uploaders
//   • SUPPORTED_MIME re-export for early rejection in the webhook
//
// Also owns the pure helpers for storing a forwarded email
// (classifyInboundAttachments, inboundBodyText, attachmentMessageId,
// sha256Hex). They lean on sniffMimeFromBytes, htmlToPlainText and
// sanitizeDbText, so this file is for server routes only. The classifier
// also takes attachments whose bytes were read back from Storage (INVOICEPREP.2).
//
// No DB calls — those live in the API routes so they can be tested
// without mocking Supabase.

import { createHash } from 'node:crypto'
import { sniffMimeFromBytes } from '@/lib/invoice-extraction'
import { htmlToPlainText } from '@/lib/email-content'
import { sanitizeDbText } from '@/lib/db-safe-text'

// Inbound mail subdomain. The marketing site keeps un1tdublin.com's
// MX records pointing at the public mailbox; mail.un1tdublin.com
// has its MX delegated to Postmark's inbound infra so supplier
// invoices route here without colliding with the apex.
const DOMAIN = 'mail.un1tdublin.com'
const SLUG_SUFFIX = '-invoices'

// MIME types we accept. Matches src/lib/invoice-extraction.js so
// the webhook can reject early without burning a row.
export const INBOUND_INVOICE_SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

// Slugs accepted by the migration's regex check. Mirror it here so
// the webhook can pre-validate before hitting the DB.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

/**
 * Extract a normalised email address (no display name, no tag,
 * lower-cased) from a single recipient string.
 *
 * Examples:
 *   "Foo <Bar+tag@DOMAIN.com>"  → "bar@domain.com"
 *   "  Bar@Domain.COM  "        → "bar@domain.com"
 *   garbage                      → null
 */
function normaliseAddress(input) {
  if (typeof input !== 'string') return null
  // Pull the part inside <...> if present, otherwise the whole string.
  const angle = input.match(/<([^>]+)>/)
  const raw = (angle ? angle[1] : input).trim().toLowerCase()
  if (!raw.includes('@')) return null
  const [localFull, domain] = raw.split('@')
  if (!localFull || !domain) return null
  // Strip Postmark-style "+tag" so foo+test@... still routes.
  const local = localFull.split('+')[0]
  return `${local}@${domain}`
}

/**
 * Given a recipient address (or an array of recipients from
 * Postmark's ToFull), return the location slug or null.
 *
 * Match rule: local part must end with "-invoices" and domain must
 * match mail.un1tdublin.com (case-insensitive). The portion before
 * "-invoices" must satisfy the slug regex.
 */
export function parseInboundAddress(toAddress) {
  const candidates = Array.isArray(toAddress) ? toAddress : [toAddress]
  for (const c of candidates) {
    // ToFull entries are { Email, Name } objects; bare strings are
    // also accepted for hand-tested webhook payloads.
    const addr = normaliseAddress(typeof c === 'object' && c ? c.Email : c)
    if (!addr) continue
    const [local, domain] = addr.split('@')
    if (domain !== DOMAIN) continue
    if (!local.endsWith(SLUG_SUFFIX)) continue
    const slug = local.slice(0, -SLUG_SUFFIX.length)
    if (!SLUG_RE.test(slug)) continue
    return slug
  }
  return null
}

// State machine — what transitions are legal from each status.
// The intermediate states (quality_approved, data_approved) exist
// so the route can transition through them while async work runs.
// If the async work fails, the row is left in the intermediate
// state and the UI surfaces a retry. The transition map is kept
// data-driven so the test suite can assert on it directly.
export const INBOUND_INVOICE_TRANSITIONS = {
  received:         ['quality_approved', 'rejected'],
  quality_approved: ['extracted', 'rejected'],
  extracted:        ['data_approved', 'rejected'],
  data_approved:    ['forwarded', 'rejected'],
  forwarded:        [],
  rejected:         [],
}

export const INBOUND_INVOICE_STATUSES = Object.keys(INBOUND_INVOICE_TRANSITIONS)

/**
 * True if `to` is a legal next state from `from`. Both must be
 * known statuses — unknown values return false so the routes
 * never accept fabricated state names.
 */
export function canTransitionInboundInvoice(from, to) {
  const allowed = INBOUND_INVOICE_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * Storage path for the original attachment. Partitioned by
 * location_id so a future per-location retention policy or signed
 * URL scope is easy to add. Filename is suffixed with the inbox
 * row id to keep two emails sharing a filename apart.
 *
 *   inbound-invoices/<location_id>/<invoice_id>/<safe_filename>
 *
 * `safeFilename` should be the caller's responsibility — strip
 * path separators before calling.
 */
export function inboundInvoiceStoragePath({ locationId, invoiceId, safeFilename }) {
  if (!locationId || !invoiceId || !safeFilename) {
    throw new Error('inboundInvoiceStoragePath requires locationId, invoiceId, safeFilename')
  }
  return `${locationId}/${invoiceId}/${safeFilename}`
}

/**
 * Sanitise an inbound filename — strips path separators, control
 * chars, and trims to 200 chars so it always fits the
 * attachment_filename CHECK constraint (255). Returns null for
 * empty/unsafe input so the caller can fall back to a default.
 */
export function safeInboundFilename(name) {
  if (typeof name !== 'string') return null
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]/g, '_').trim()
  if (!cleaned) return null
  return cleaned.slice(0, 200)
}

export const INBOUND_BODY_MAX_CHARS = 20000

// Signature logos are a few KB; a photographed receipt is far bigger.
export const INLINE_IMAGE_SKIP_MAX_BYTES = 100 * 1024

const stripCid = (id) => String(id || '').trim().replace(/^<|>$/g, '')
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when the HTML references exactly this ContentID (cid:a1 is not cid:a10). */
function referencesCid(html, cid) {
  if (!cid) return false
  return new RegExp(`cid:${escapeRegExp(cid)}(?=["'\\s>)]|$)`, 'i').test(html)
}

/** The signature-logo test: a small image the HTML body shows by its ContentID. */
function looksInline({ mime, sizeBytes, contentId }, html) {
  return String(mime || '').startsWith('image/')
    && sizeBytes < INLINE_IMAGE_SKIP_MAX_BYTES
    && referencesCid(html, stripCid(contentId))
}

/** Bytes the caller already holds (read back from Storage), else the base64 Content. */
function attachmentBytes(att) {
  const held = att?.bytes
  if (held instanceof Uint8Array && held.length > 0) {
    return Buffer.isBuffer(held) ? held : Buffer.from(held.buffer, held.byteOffset, held.length)
  }
  return Buffer.from(String(att?.Content || ''), 'base64')
}

/**
 * Sort a Postmark Attachments array into what we can store.
 *
 * An image is skipped as a signature logo or similar only when all hold:
 * the HTML body references its ContentID (cid:...), it is under
 * INLINE_IMAGE_SKIP_MAX_BYTES, and the email has something else usable.
 * A phone can send a receipt photo inline beside a PDF, and that photo is
 * large, so size keeps it. The type is judged by the bytes first, because
 * senders mislabel PDFs. The bytes are `att.bytes` when the caller has
 * already read them back from Storage, else the decoded `Content`.
 * `index` is the position in the original array (see attachmentMessageId);
 * a null entry is passed over and keeps its position.
 *
 * `alreadyStored` describes attachments of this email that an earlier
 * delivery stored and the caller left out of `attachments`. One that is not
 * itself a logo still counts as "something else usable", so a retry judges
 * the logos the way the first delivery did. Unknown type or size counts as
 * not a logo.
 *
 * @param {Array<any> | undefined} attachments
 * @param {string | undefined | null} htmlBody
 * @param {{ alreadyStored?: Array<{ mime?: string | null, sizeBytes?: number | null, contentId?: string | null }> }} [options]
 */
export function classifyInboundAttachments(attachments, htmlBody, options = {}) {
  const html = String(htmlBody || '')
  const candidates = []
  const unsupported = new Set()
  ;(Array.isArray(attachments) ? attachments : []).forEach((att, index) => {
    const bytes = attachmentBytes(att)
    const mime = (bytes.length ? sniffMimeFromBytes(bytes) : null) || att?.ContentType || ''
    if (!INBOUND_INVOICE_SUPPORTED_MIME.has(mime)) {
      // Here the mime is always the declared type: a sniffed one is supported.
      if (mime) unsupported.add(mime)
      return
    }
    // Empty or undecodable content is simply not usable.
    if (!bytes.length) return
    const inline = looksInline({ mime, sizeBytes: bytes.length, contentId: att.ContentID }, html)
    candidates.push({ name: att.Name, mime, bytes, index, inline })
  })

  const storedReal = (options.alreadyStored || []).filter((s) =>
    !s || s.mime == null || s.sizeBytes == null || !looksInline({ mime: s.mime, sizeBytes: s.sizeBytes, contentId: s.contentId }, html),
  ).length
  const real = candidates.filter((c) => !c.inline)
  const keep = real.length + storedReal > 0 ? real : candidates
  const skippedInline = candidates.length - keep.length
  const usable = keep.map(({ name, mime, bytes, index }) => ({ name, mime, bytes, index }))
  return { usable, skippedInline, unsupportedTypes: [...unsupported] }
}

/**
 * Plain text of the email body for storage: TextBody, else HtmlBody
 * flattened, trimmed and capped. Null when there is nothing.
 */
export function inboundBodyText(body) {
  const text = typeof body?.TextBody === 'string' && body.TextBody.trim()
    ? body.TextBody
    : typeof body?.HtmlBody === 'string' ? htmlToPlainText(body.HtmlBody) : ''
  // Sanitise after cutting so a split surrogate pair is cleaned up too.
  const out = sanitizeDbText(String(text || '').trim().slice(0, INBOUND_BODY_MAX_CHARS))
  return out || null
}

/**
 * Per-attachment message id: the first keeps the bare id so rows
 * written before multi-attachment support still match.
 */
export function attachmentMessageId(messageId, index) {
  return index === 0 ? messageId : `${messageId}-${index}`
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
