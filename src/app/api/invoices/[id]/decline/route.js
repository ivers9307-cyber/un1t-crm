// POST /api/invoices/[id]/decline
//
// Owner/master only, contractor's location only. Body: { reason }.
// Reason is required — the whole point is "tell the contractor what
// to fix". Caps at 1000 chars to keep the email body sane.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { validateBody } from '@/lib/validate'
import { sendInvoiceDeclinedEmail } from '@/lib/contractor-invoice-email'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { periodLabel } from '@/lib/contractor-invoices'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const DeclineSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(1000),
})

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, DeclineSchema)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const db = createServerClient()
  const { data: inv, error: loadErr } = await db
    .from('contractor_invoices')
    .select('id, contractor_id, location_id, status')
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
      { success: false, error: `Cannot decline an invoice in '${inv.status}' state.` },
      { status: 409 }
    )
  }

  const now = new Date().toISOString()
  const { data: declined, error: updErr } = await db
    .from('contractor_invoices')
    .update({
      status: 'declined',
      reviewed_by: user.id,
      reviewed_at: now,
      decline_reason: reason,
    })
    .eq('id', params.id)
    .eq('status', 'submitted')
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!declined) {
    return NextResponse.json(
      { success: false, error: 'Invoice was already actioned by someone else.' },
      { status: 409 }
    )
  }

  const warnings = []
  try {
    await sendInvoiceDeclinedEmail(declined.id)
  } catch (e) {
    warnings.push(`Decline email failed: ${e?.message || String(e)}. Contractor will see the status next time they open Invoices.`)
  }

  // NOTIF.9 — migrated to notifyUsers so contractors without the
  // mobile app get an email fallback explaining why the invoice
  // was declined.
  try {
    const reasonSnippet = (declined.decline_reason || '').slice(0, 100)
    await notifyUsersOnce(db, `invoice_declined:${declined.id}:${declined.reviewed_at || ''}`, [declined.contractor_id], {
      title: 'Invoice needs adjustment',
      body: reasonSnippet
        ? `${periodLabel(declined.period_start)} — ${reasonSnippet}${declined.decline_reason.length > 100 ? '…' : ''}`
        : `Your ${periodLabel(declined.period_start)} invoice was declined. Tap to view and resubmit.`,
      category: 'invoice_declined',
      emailSubject: `Your invoice needs adjustment — ${periodLabel(declined.period_start)}`,
      data: {
        type: 'invoice_declined',
        invoice_id: declined.id,
      },
    })
  } catch (e) {
    logWarn('invoice-decline', `notify failed for ${declined.id}`, { err: e })
  }

  return NextResponse.json({
    success: true,
    data: declined,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
