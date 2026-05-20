// FTE-EXPENSES.1 — helpers shared by the API routes and the email
// templates. Pure functions only — anything that needs the DB or
// Storage clients lives in the caller.
//
// Mirrors the structure of src/lib/contractor-invoices.js but with
// the differences a header+items expense claim needs:
//   - Categories enum + label map
//   - Per-claim totals computation (sum of items.amount, sum of
//     items.vat_amount, count)
//   - State-transition guard so the route handlers share one
//     authoritative "what is this status allowed to become" rule
//
// The fixed category enum is the spec the user signed off on:
// Travel, Meals, Supplies, Mileage, Training, Other.

export const EXPENSE_CATEGORIES = Object.freeze([
  'travel',
  'meals',
  'supplies',
  'mileage',
  'training',
  'other',
])

export const EXPENSE_CATEGORY_LABELS = Object.freeze({
  travel:   'Travel',
  meals:    'Meals & Entertainment',
  supplies: 'Supplies',
  mileage:  'Mileage',
  training: 'Training',
  other:    'Other',
})

/**
 * Status of an expense claim. Lifecycle:
 *
 *   draft → submitted → { approved, declined, revoked }
 *
 * draft     — employee is still adding line items / editing.
 *             Mutable. Only visible to the submitter + admins.
 * submitted — locked for editing. In the approver queue.
 * approved  — terminal-success. Xero forward triggered on entry.
 *             Reimbursement happens via payroll outside the CRM.
 * declined  — terminal-but-recoverable. Employee can start a new
 *             claim for the same period (the partial unique index
 *             on the table allows it because the declined row is
 *             excluded from the uniqueness predicate).
 * revoked   — same recoverability as declined, but initiated by the
 *             submitter rather than the approver. e.g. they spotted
 *             a typo right after submitting and want to fix it
 *             before the approver looks.
 */
export const EXPENSE_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'approved',
  // INVOICES-QUEUE.1 — terminal-from-submitter's-POV state. Owner
  // has approved; queue has a row; bookkeeper signs off in /invoices
  // before Xero forward.
  'awaiting_accountant_review',
  'declined',
  'revoked',
])

/**
 * Pure transition guard. Returns true if the given status change is
 * legal AT ALL (caller-identity gating — only the submitter can
 * revoke, only master/owner can approve/decline — is enforced at the
 * route layer). Useful for one-liner 409 responses without scattering
 * the rule set across files.
 *
 * @param {string} from current status
 * @param {string} to   desired next status
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!EXPENSE_STATUSES.includes(from) || !EXPENSE_STATUSES.includes(to)) return false
  if (from === to) return false
  const LEGAL = {
    draft:     ['submitted'],
    submitted: ['approved', 'declined', 'revoked'],
    // INVOICES-QUEUE.1 — owner approval immediately flips to the
    // accountant-review state once the queue row(s) are inserted.
    // The 'approved' state is a transient marker used by audit but
    // the row never settles there in the new flow.
    approved:  ['awaiting_accountant_review'],
    awaiting_accountant_review: [], // terminal-from-submitter's-POV
    declined:  [],     // terminal — new claim must be opened
    revoked:   [],     // terminal — new claim must be opened
  }
  return (LEGAL[from] || []).includes(to)
}

/**
 * Convert a YYYY-MM string into a period range.
 *
 * Examples:
 *   periodForMonth('2026-05') →
 *     { period_start: '2026-05-01', period_end: '2026-05-31', label: 'May 2026' }
 *
 * @param {string} monthKey 'YYYY-MM'
 * @returns {{ period_start: string, period_end: string, label: string } | null}
 *   null when the input doesn't match the format.
 */
export function periodForMonth(monthKey) {
  if (typeof monthKey !== 'string') return null
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  // Use UTC to dodge timezone surprises — period_end is the last day
  // of the month in the local jurisdiction (Europe/Dublin); since
  // both period_start and period_end are stored as DATE (no time
  // component), as long as we compute them consistently the UI's
  // "May 2026" label is the same on every machine.
  const pad2 = (n) => String(n).padStart(2, '0')
  const periodStart = `${year}-${pad2(month)}-01`
  // Last day of month = day 0 of next month in JS Date arithmetic.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const periodEnd = `${year}-${pad2(month)}-${pad2(lastDay)}`
  return { period_start: periodStart, period_end: periodEnd, label: periodLabel(periodStart) }
}

/**
 * Friendly label for a period_start date. 'May 2026'.
 * @param {string} periodStart ISO date 'YYYY-MM-DD'
 * @returns {string}
 */
export function periodLabel(periodStart) {
  const d = new Date(`${periodStart}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return periodStart
  return d.toLocaleDateString('en-IE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Roll up an array of line items into the totals stored on the claim
 * header. The DB trigger maintains these whenever items change, but
 * this helper is used by API routes that want to compute totals
 * client-side for a payload preview before the row is created.
 *
 * @param {Array<{ amount: number|string, vat_amount?: number|string }>} items
 * @returns {{ total_amount: number, total_vat_amount: number, item_count: number, total_net_amount: number }}
 */
export function computeClaimTotals(items) {
  if (!Array.isArray(items)) {
    return { total_amount: 0, total_vat_amount: 0, item_count: 0, total_net_amount: 0 }
  }
  let totalAmount = 0
  let totalVat = 0
  for (const it of items) {
    const a = Number(it?.amount || 0)
    const v = Number(it?.vat_amount || 0)
    if (!Number.isFinite(a) || a < 0) continue
    if (!Number.isFinite(v) || v < 0) continue
    totalAmount += a
    totalVat += Math.min(v, a) // clamp VAT to amount for safety
  }
  return {
    total_amount: round2(totalAmount),
    total_vat_amount: round2(totalVat),
    item_count: items.length,
    total_net_amount: round2(totalAmount - totalVat),
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Build a storage path for a receipt file. Used by the items upload
 * route. Path shape matches the contractor-invoices convention so
 * future tooling (bulk-download, audit log) can use a single
 * regex for both buckets.
 *
 *   {profile_id}/{claim_id}/{item_id}-{random_6char}-{sanitised_name}
 *
 * @param {object} args
 * @param {string} args.profileId
 * @param {string} args.claimId
 * @param {string} args.itemId
 * @param {string} args.filename original filename from the upload
 * @returns {string}
 */
export function buildReceiptPath({ profileId, claimId, itemId, filename }) {
  const safe = String(filename || 'receipt')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 80) || 'receipt'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${profileId}/${claimId}/${itemId}-${suffix}-${safe}`
}

/**
 * The MIME types we accept for a receipt upload. PDF for invoices,
 * common image types for phone-camera captures. WebP added because
 * iOS Safari camera roll occasionally serves it.
 */
export const RECEIPT_ACCEPTED_MIMES = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/webp',
])

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
