// EXPENSELIFE.1 — pure display decisions for the FTE expense screens
// (expenses tab list + claim detail). No React: there is no RN component
// test runner, so the decision lives here and is covered by
// expense-review.test.js.
//
// GET /api/expenses and /api/expenses/[id] ship `lifecycle` — an honest
// status derived from the per-item invoices_queue rows the approval
// enqueued (shared/accountant-queue-lifecycle.js). Before this, an
// approved claim ('awaiting_accountant_review') had no style entry at
// all: the list printed the raw status string and the detail screen
// read `.bg` off undefined.

import { expenseClaimLifecycle } from 'shared/accountant-queue-lifecycle'

const TONE_STYLE = {
  green: { color: '#059669', bg: 'bg-green-500/20', text: 'text-green-700' },
  amber: { color: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700' },
  red:   { color: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700' },
  slate: { color: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700' },
}

const KEY_ICON = {
  draft: 'create-outline',
  submitted: 'time-outline',
  declined: 'close-circle-outline',
  revoked: 'arrow-undo-outline',
  approved_not_queued: 'alert-circle-outline',
  queued_for_accountant: 'hourglass-outline',
  rejected_by_accountant: 'close-circle-outline',
  voided_in_xero: 'remove-circle-outline',
  sent_to_xero: 'paper-plane-outline',
  paid: 'cash-outline',
}

/**
 * Badge for an expense claim: { key, label, icon, color, bg, text, detail }.
 * Uses the server's `lifecycle`; a payload without one (older server)
 * falls back to the status-only derivation, which never over-claims.
 */
export function expenseStatusBadge(claim) {
  const lc = claim?.lifecycle && claim.lifecycle.label
    ? claim.lifecycle
    : expenseClaimLifecycle({ status: claim?.status, xero_synced_at: claim?.xero_synced_at })
  const style = TONE_STYLE[lc.tone] || TONE_STYLE.slate
  return {
    key: lc.key,
    label: lc.label,
    icon: KEY_ICON[lc.key] || 'checkmark-circle-outline',
    detail: lc.detail || null,
    ...style,
  }
}
