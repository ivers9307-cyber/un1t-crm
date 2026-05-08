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
import { computeScheduledForPeriod, periodLabel } from '@/lib/contractor-invoices'
import { sendContractorInvoiceBillEmail } from '@/lib/xero/contractor-bills'
import { sendInvoiceApprovedEmail } from '@/lib/contractor-invoice-email'
import { sendPush } from '@/lib/push'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
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
  if (inv.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot approve an invoice in '${inv.status}' state.` },
      { status: 409 }
    )
  }

  // Auth.
  if (user.role !== 'master') {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (!ownerLocations.includes(inv.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  // Snapshot the at-review numbers for audit.
  const computed = await computeScheduledForPeriod(db, {
    contractor_id: inv.contractor_id,
    location_id: inv.location_id,
    period_start: inv.period_start,
    period_end: inv.period_end,
  })

  const now = new Date().toISOString()
  const { data: approved, error: updErr } = await db
    .from('contractor_invoices')
    .update({
      status: 'approved',
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

  // Forward to Xero (best-effort).
  try {
    const xero = await sendContractorInvoiceBillEmail(approved.id)
    await db
      .from('contractor_invoices')
      .update({
        xero_email_message_id: xero.messageId,
        xero_synced_at: new Date().toISOString(),
      })
      .eq('id', approved.id)
  } catch (e) {
    warnings.push(`Xero forward failed: ${e?.message || String(e)}. The approval is saved — retry the Xero forward from the invoice detail page.`)
  }

  // Email contractor (best-effort).
  try {
    await sendInvoiceApprovedEmail(approved.id)
  } catch (e) {
    warnings.push(`Approval email failed: ${e?.message || String(e)}. The contractor will see the status next time they open Invoices.`)
  }

  // Push notification (best-effort). category=invoice_approved
  // maps to notify_invoice_approved on the contractor's profile,
  // and the master push_notifications switch is honoured by
  // sendPush itself.
  try {
    await sendPush([approved.contractor_id], {
      title: 'Invoice approved',
      body: `€${Number(approved.invoice_amount).toFixed(2)} for ${periodLabel(approved.period_start)} has been approved and forwarded to accounts.`,
      category: 'invoice_approved',
      data: {
        type: 'invoice_approved',
        invoice_id: approved.id,
      },
    })
  } catch (e) {
    // Pushed are non-blocking; don't surface as a warning unless
    // the entire transport is broken — and even then operators can
    // see this in logs. Log only.
    logWarn('invoice-approve', `push failed for ${approved.id}`, { err: e })
  }

  return NextResponse.json({
    success: true,
    data: approved,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
