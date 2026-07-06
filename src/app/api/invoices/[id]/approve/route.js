// POST /api/invoices/[id]/approve
//
// Owner/master only, must be the contractor's location.
// Steps:
//   1. Check status = 'submitted'
//   2. Snapshot the at-review hours/cost into the row (audit truth)
//   3. Stamp status='approved', reviewed_*, approved_at
//   4. Forward PDF to Xero via email-to-bills (best-effort)
//   5. Send approval email to contractor (best-effort)
//
// Steps 4 + 5 are wrapped in try/catch so a Xero or Postmark blip
// doesn't unwind the approval. The DB row is the source of truth;
// failed forwards surface as warnings the operator can retry.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { computeScheduledForPeriod, periodLabel } from '@/lib/contractor-invoices'
import { sendInvoiceApprovedEmail } from '@/lib/contractor-invoice-email'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { enqueueFromContractorInvoice } from '@/lib/invoices-queue/enqueue'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()

  const { data: inv, error: loadErr } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, location_id, period_start, period_end, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !inv) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  // Auth FIRST — before the status check — so a non-owner can't probe an
  // invoice's existence or state. 404 (not 403) to avoid the existence leak.
  // APPROVALS-PERCAT.1 — permission is the only gate. 404 (not 403)
  // preserves the IDOR posture: a caller without rights can't tell the
  // invoice exists.
  if (!hasPermissionForLocation(user, inv.location_id, APPROVAL_CATEGORY_PERMISSION.contractor_invoices)) {
    return NextResponse.json({ success: false, error: 'Invoice not found' }, { status: 404 })
  }

  if (inv.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot approve an invoice in '${inv.status}' state.` },
      { status: 409 }
    )
  }

  // Snapshot the at-review numbers for audit.
  const computed = await computeScheduledForPeriod(db, {
    contractor_id: inv.contractor_id,
    location_id: inv.location_id,
    period_start: inv.period_start,
    period_end: inv.period_end,
  })

  const now = new Date().toISOString()
  // INVOICES-QUEUE.1 — owner approval flips status straight to
  // awaiting_accountant_review. Direct Xero forward is now the
  // bookkeeper's job from /invoices (queue handles it).
  const { data: approved, error: updErr } = await db
    .from('contractor_invoices')
    .update({
      status: 'awaiting_accountant_review',
      reviewed_by: user.id,
      reviewed_at: now,
      approved_at: now,
      scheduled_hours_at_review: computed.scheduled_hours,
      estimated_cost_at_review: computed.estimated_cost,
      hourly_rate_at_review: computed.hourly_rate,
    })
    .eq('id', params.id)
    .eq('status', 'submitted') // race-safe
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!approved) {
    // Lost the race — someone else already approved/declined.
    return NextResponse.json(
      { success: false, error: 'Invoice was already actioned by someone else.' },
      { status: 409 }
    )
  }

  const warnings = []

  // Drop into the central invoices_queue. Bookkeeper runs Claude
  // Vision + final Xero forward from /invoices. Best-effort: if
  // enqueue fails the approval is still recorded; operator can
  // retry from PR 2's queue UI.
  const enq = await enqueueFromContractorInvoice(approved.id)
  if (!enq.ok) {
    logWarn('invoice-approve', 'enqueue failed', { err: enq.error, invoiceId: approved.id })
    warnings.push(`Queue insert failed: ${enq.error}. The approval is recorded; retry enqueue from /invoices.`)
  }

  // Email contractor (best-effort).
  try {
    await sendInvoiceApprovedEmail(approved.id)
  } catch (e) {
    warnings.push(`Approval email failed: ${e?.message || String(e)}. The contractor will see the status next time they open Invoices.`)
  }

  // NOTIF.9 — migrated to notifyUsers so contractors without the
  // mobile app get an email fallback (category invoice_approved
  // opts in via fallbackEmail: true in notifications-registry).
  // Honours notify_invoice_approved + the master push_notifications
  // switch the same way sendPush did.
  try {
    await notifyUsersOnce(db, `invoice_approved:${approved.id}:${approved.reviewed_at || ''}`, [approved.contractor_id], {
      title: 'Invoice approved',
      body: `€${Number(approved.invoice_amount).toFixed(2)} for ${periodLabel(approved.period_start)} has been approved and forwarded to accounts.`,
      category: 'invoice_approved',
      emailSubject: `Your invoice has been approved — €${Number(approved.invoice_amount).toFixed(2)}`,
      data: {
        type: 'invoice_approved',
        invoice_id: approved.id,
      },
    })
  } catch (e) {
    logWarn('invoice-approve', `notify failed for ${approved.id}`, { err: e })
  }

  return NextResponse.json({
    success: true,
    data: approved,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
