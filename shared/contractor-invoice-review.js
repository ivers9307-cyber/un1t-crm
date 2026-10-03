// INVOICEREVIEW.2 — pure decisions for the contractor-invoice review
// surfaces (web /schedule/invoices, the mobile invoice detail and the
// mobile Approvals inbox). No DB, no network, no platform imports: the
// API routes run these server-side and ship the result, so web and
// phone read the same verdict.
//
// Three decisions live here:
//
//   1. rosterComparison()  — invoiced amount vs rostered hours × rate,
//      with a tolerance so a rate-rounding artefact (a profile rate of
//      €19.98 against invoices written at €20) reads "matches roster"
//      instead of a spurious €1.60 alarm.
//
//   2. selectReviewComparison() — WHICH numbers to show. Approval saves
//      a snapshot onto the row (scheduled_hours_at_review /
//      estimated_cost_at_review / hourly_rate_at_review). Once approved,
//      the snapshot is the record; the live recompute drifts as the
//      roster is edited after the fact, so it only appears as a
//      secondary "current roster" line, and only when it differs.
//
//   3. contractorInvoiceLifecycle() — an honest status label. The owner
//      approval flips contractor_invoices.status to
//      'awaiting_accountant_review' and NOTHING ever moves it again; the
//      real progress lives on the invoices_queue row the approval
//      enqueues (source_contractor_invoice_id). So the label is derived
//      from that queue row, and stops at what the data can prove.

import { queueRowLifecycle, latestQueueRowBy } from './accountant-queue-lifecycle.js'

// A delta under €1 OR under 1% of the rostered cost reads as a match.
export const MATCH_TOLERANCE_EUR = 1
export const MATCH_TOLERANCE_PCT = 1
// Above this the mismatch is flagged as significant (the web's orange box).
export const BIG_MISMATCH_PCT = 5

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * Compare an invoiced amount to the rostered estimate.
 *
 * @param {{ invoiced: number|string, estimated: number|string|null }} args
 * @returns {{
 *   verdict: 'matches'|'over'|'under'|'unknown',
 *   diff: number|null,   // invoiced − estimated, rounded to cents
 *   pct: number|null,    // diff as % of estimated, 1dp
 *   significant: boolean // |pct| > BIG_MISMATCH_PCT
 * }}
 */
export function rosterComparison({ invoiced, estimated }) {
  const inv = num(invoiced)
  const est = num(estimated)
  if (inv == null || est == null) {
    return { verdict: 'unknown', diff: null, pct: null, significant: false }
  }
  const diff = round2(inv - est)
  const pct = est > 0 ? Math.round((diff / est) * 1000) / 10 : null
  const absDiff = Math.abs(diff)
  const withinEur = absDiff < MATCH_TOLERANCE_EUR
  const withinPct = pct != null && Math.abs(pct) < MATCH_TOLERANCE_PCT
  if (withinEur || withinPct) {
    return { verdict: 'matches', diff, pct, significant: false }
  }
  return {
    verdict: diff > 0 ? 'over' : 'under',
    diff,
    pct,
    significant: pct == null ? true : Math.abs(pct) > BIG_MISMATCH_PCT,
  }
}

/**
 * One-line human summary of a rosterComparison() result.
 * e.g. "Matches roster", "€42.00 over roster (+6.1%)".
 */
export function rosterComparisonSummary(cmp) {
  if (!cmp || cmp.verdict === 'unknown') return 'No roster estimate (hourly rate not set)'
  if (cmp.verdict === 'matches') return 'Matches roster'
  const amount = `€${Math.abs(cmp.diff).toFixed(2)} ${cmp.verdict === 'over' ? 'over' : 'under'} roster`
  if (cmp.pct == null) return amount
  const sign = cmp.pct > 0 ? '+' : '−'
  return `${amount} (${sign}${Math.abs(cmp.pct).toFixed(1)}%)`
}

const APPROVED_STATUSES = new Set(['approved', 'awaiting_accountant_review'])

function hasSnapshot(inv) {
  return num(inv?.scheduled_hours_at_review) != null
}

function figuresFrom(source, { hours, rate, cost, shiftCount }, invoiced, asOf = null) {
  const comparison = rosterComparison({ invoiced, estimated: cost })
  return {
    source, // 'snapshot' | 'live'
    as_of: asOf,
    scheduled_hours: hours,
    hourly_rate: rate,
    estimated_cost: cost,
    shift_count: shiftCount,
    comparison,
    summary: rosterComparisonSummary(comparison),
  }
}

/**
 * Decide which roster-vs-invoice figures a reviewer sees.
 *
 * @param {object} inv   contractor_invoices row (status, invoice_amount,
 *                       approved_at, reviewed_at, *_at_review snapshot)
 * @param {object|null} live  computeScheduledForPeriod() result, or null
 * @returns {null | {
 *   primary: object,            // figuresFrom() shape
 *   current: object|null,       // live recompute, only when it DIFFERS
 *                               //   from an approval snapshot
 *   snapshot_missing: boolean,  // approved before snapshots existed
 * }}
 */
export function selectReviewComparison(inv, live) {
  if (!inv) return null
  const invoiced = inv.invoice_amount
  const liveFigures = live
    ? figuresFrom('live', {
        hours: num(live.scheduled_hours),
        rate: num(live.hourly_rate),
        cost: num(live.estimated_cost),
        shiftCount: num(live.shift_count),
      }, invoiced)
    : null

  const approved = APPROVED_STATUSES.has(inv.status)
  if (approved && hasSnapshot(inv)) {
    const primary = figuresFrom('snapshot', {
      hours: num(inv.scheduled_hours_at_review),
      rate: num(inv.hourly_rate_at_review),
      cost: num(inv.estimated_cost_at_review),
      shiftCount: null, // not snapshotted at approval
    }, invoiced, inv.approved_at || inv.reviewed_at || null)
    const differs = !!liveFigures && (
      liveFigures.scheduled_hours !== primary.scheduled_hours
      || liveFigures.estimated_cost !== primary.estimated_cost
      || liveFigures.hourly_rate !== primary.hourly_rate
    )
    return { primary, current: differs ? liveFigures : null, snapshot_missing: false }
  }

  if (!liveFigures) return null
  return { primary: liveFigures, current: null, snapshot_missing: approved }
}

/**
 * Honest lifecycle label for a contractor invoice.
 *
 * `queue` is the invoices_queue row enqueued at approval:
 *   undefined → not looked up / lookup failed (don't claim either way)
 *   null      → looked up, none exists (the enqueue failed)
 *   object    → { status, forwarded_at, xero_bill_id, xero_synced_at,
 *                 xero_bill_status, xero_bill_paid_at }
 *
 * Queue status flow (mig 184/185): quality_approved (contractor rows
 * enter here) → extracted → data_approved → forwarded | rejected.
 * xero_bill_status / xero_bill_paid_at arrive via the Xero webhook
 * (mig 208) — the only paid signal in the data.
 *
 * @returns {{ key: string, label: string, tone: 'green'|'amber'|'red'|'slate' }}
 */
export function contractorInvoiceLifecycle(inv, queue) {
  const status = inv?.status
  if (status === 'declined') return { key: 'declined', label: 'Declined', tone: 'red' }
  if (status === 'revoked') return { key: 'revoked', label: 'Revoked by contractor', tone: 'slate' }
  if (status === 'submitted' || !status) return { key: 'submitted', label: 'Awaiting review', tone: 'amber' }

  if (status === 'approved') {
    // Pre-queue (INVOICES-QUEUE.1) rows forwarded straight to Xero by email.
    return inv.xero_synced_at
      ? { key: 'sent_to_xero', label: 'Sent to Xero', tone: 'green' }
      : { key: 'approved', label: 'Approved', tone: 'green' }
  }

  if (status === 'awaiting_accountant_review') {
    // EXPENSELIFE.1 — the queue-row decision is shared with FTE expense
    // claims (shared/accountant-queue-lifecycle.js) so the two can't drift.
    return queueRowLifecycle(queue)
  }

  return { key: String(status), label: String(status), tone: 'slate' }
}

/**
 * Pick the queue row per contractor invoice (newest wins if a retry
 * enqueued twice). Returns a Map<invoiceId, row>.
 */
export function latestQueueRowByInvoice(rows) {
  return latestQueueRowBy(rows, 'source_contractor_invoice_id')
}
