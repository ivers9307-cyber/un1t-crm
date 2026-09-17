// GET /api/invoices/[id] — full detail including computed scheduled
// hours + estimated cost for the contractor over the invoice period.
//
// Auth:
//   contractor (self) — can read their own invoice (no calc needed
//                       on their side, but we include it anyway so
//                       the resubmit form can show "you scheduled X
//                       hours" as a hint).
//   owner-at-loc / master — can read + see calc.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { computeScheduledForPeriod, loadQueueRowsForInvoices } from '@/lib/contractor-invoices'
import { selectReviewComparison, contractorInvoiceLifecycle } from '@shared/contractor-invoice-review'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()

  const { data: inv, error } = await db
    .from('contractor_invoices')
    .select(`
      *,
      contractor:contractor_id ( id, full_name, email, hourly_rate, employment_type ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .eq('id', params.id)
    .single()
  if (error || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  // Auth gate.
  const isSelf = inv.contractor_id === user.id
  const isMaster = user.role === 'master'
  let isOwnerHere = false
  if (!isMaster && !isSelf) {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    isOwnerHere = ownerLocations.includes(inv.location_id)
    if (!isOwnerHere) {
      // 404 (not 403) so a non-owner can't tell this invoice exists. The
      // self/owner/master tiers above still get through.
      return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
    }
  }

  // Compute the schedule-vs-invoice comparison block ONLY for the
  // reviewer (owner / master). The hourly rate × scheduled hours
  // is commercially sensitive — we don't expose it to the
  // contractor themselves, and stripping here means a curl-savvy
  // self caller can't pull it via the API either.
  const reviewerView = isMaster || isOwnerHere
  let computed = null
  if (reviewerView) {
    try {
      computed = await computeScheduledForPeriod(db, {
        contractor_id: inv.contractor_id,
        location_id: inv.location_id,
        period_start: inv.period_start,
        period_end: inv.period_end,
      })
    } catch (e) {
      // INVOICEREVIEW.2 — an approved invoice still has its saved
      // snapshot to show, so a live-recompute failure must not 500 the
      // whole detail view.
      logWarn('invoice-detail', 'live roster recompute failed', { err: e, invoiceId: inv.id })
    }
  }

  // INVOICEREVIEW.2 — after approval the SAVED snapshot is the record;
  // the live recompute is only a secondary "current roster" line when
  // it has drifted. Decision lives in shared/ so web + phone agree.
  const reviewComparison = reviewerView ? selectReviewComparison(inv, computed) : null

  // Honest lifecycle label from the invoices_queue row the approval
  // enqueued — contractor_invoices.status never moves past
  // awaiting_accountant_review on its own.
  const queueFor = await loadQueueRowsForInvoices(db, [inv])
  const lifecycle = contractorInvoiceLifecycle(inv, queueFor(inv.id))

  // The *_at_review snapshot is rate × hours, same sensitivity as the
  // live block above — strip it from the contractor's own view.
  const row = reviewerView ? inv : {
    ...inv,
    scheduled_hours_at_review: undefined,
    estimated_cost_at_review: undefined,
    hourly_rate_at_review: undefined,
  }

  return NextResponse.json({
    success: true,
    data: {
      ...row,
      computed_scheduled: computed,
      review_comparison: reviewComparison,
      lifecycle,
      // Convenience flags for the client to render the right view.
      viewer_role: isMaster ? 'master' : isOwnerHere ? 'owner' : 'self',
    },
  })
}
