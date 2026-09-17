// INVOICEREVIEW.2 — pure display decisions for the contractor-invoice
// screens (invoice list, invoice detail, Approvals inbox card). No React:
// there is no RN component test runner, so every decision lives here and
// is covered by invoice-review.test.js.
//
// The server does the real work — GET /api/invoices and
// /api/invoices/[id] ship `lifecycle` (honest status from the
// invoices_queue row) and, for reviewers, `review_comparison` (the
// approval snapshot vs the live roster). These helpers only turn those
// payloads into strings and colours.

import { contractorInvoiceLifecycle } from 'shared/contractor-invoice-review'

const TONE_STYLE = {
  green: { tint: '#059669', bg: 'bg-green-500/20', text: 'text-green-700' },
  amber: { tint: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700' },
  red:   { tint: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700' },
  slate: { tint: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700' },
}

const KEY_ICON = {
  submitted: 'time-outline',
  declined: 'close-circle-outline',
  revoked: 'arrow-undo-outline',
  approved_not_queued: 'alert-circle-outline',
  rejected_by_accountant: 'close-circle-outline',
  voided_in_xero: 'remove-circle-outline',
  sent_to_xero: 'paper-plane-outline',
  paid: 'cash-outline',
}

/**
 * Badge for an invoice row: { label, icon, tint, bg, text }.
 * Uses the server's `lifecycle`; a payload without one (older server)
 * falls back to the invoice-only derivation, which never over-claims.
 */
export function invoiceStatusBadge(inv) {
  const lc = inv?.lifecycle && inv.lifecycle.label
    ? inv.lifecycle
    : contractorInvoiceLifecycle({ status: inv?.status, xero_synced_at: inv?.xero_synced_at })
  const style = TONE_STYLE[lc.tone] || TONE_STYLE.slate
  return {
    label: lc.label,
    icon: KEY_ICON[lc.key] || 'checkmark-circle-outline',
    ...style,
  }
}

function euro(n) {
  return `€${Number(n).toFixed(2)}`
}

function formatDay(iso) {
  if (!iso) return 'an unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown date'
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' })
}

function figureRows(f) {
  return [
    {
      label: 'Rostered hours',
      value: f.scheduled_hours != null ? `${f.scheduled_hours} h` : '—',
      sub: f.shift_count != null ? `${f.shift_count} shifts` : null,
    },
    {
      label: 'Hourly rate',
      value: f.hourly_rate != null ? `${euro(f.hourly_rate)}/h` : 'Not set on profile',
      warn: f.hourly_rate == null,
    },
    {
      label: 'Rostered amount',
      value: f.estimated_cost != null ? euro(f.estimated_cost) : '—',
      emphasize: true,
    },
  ]
}

function verdictTone(cmp) {
  if (!cmp || cmp.verdict === 'unknown') return 'slate'
  if (cmp.verdict === 'matches') return 'green'
  return cmp.significant ? 'red' : 'amber'
}

/**
 * Turn `data.review_comparison` into a render model, or null when the
 * viewer isn't a reviewer / nothing is computable.
 *
 * {
 *   heading,                 // "Roster vs invoice" | "... as approved on 2 Sep 2026"
 *   rows: [{label, value, sub?, warn?, emphasize?}],
 *   invoiced,                // "€800.00"
 *   verdict: { summary, tone, tint, bg, text },
 *   note,                    // legacy approval with no snapshot, else null
 *   current: null | { heading, rows, summary },
 * }
 */
export function reviewComparisonView(data) {
  const rc = data?.review_comparison
  if (!rc || !rc.primary) return null
  const { primary, current } = rc
  const tone = verdictTone(primary.comparison)
  return {
    heading: primary.source === 'snapshot'
      ? `Roster vs invoice, as approved on ${formatDay(primary.as_of)}`
      : 'Roster vs invoice',
    rows: figureRows(primary),
    invoiced: euro(data.invoice_amount),
    verdict: { summary: primary.summary, tone, ...TONE_STYLE[tone] },
    note: rc.snapshot_missing
      ? 'Approved before snapshots were saved, so this is the current roster.'
      : null,
    current: current
      ? { heading: 'Current roster (changed since approval)', rows: figureRows(current), summary: current.summary }
      : null,
  }
}
