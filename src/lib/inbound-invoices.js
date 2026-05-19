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
// Pure functions only. No DB calls — those live in the API routes
// so they can be tested without mocking Supabase.

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
