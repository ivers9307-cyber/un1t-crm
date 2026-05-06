// POST /api/invoices/[id]/decline
//
// Owner/master only, contractor's location only. Body: { reason }.
// Reason is required — the whole point is "tell the contractor what
// to fix". Caps at 1000 chars to keep the email body sane.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendInvoiceDeclinedEmail } from '@/lib/contractor-invoice-email'
import { sendPush } from '@/lib/push'
import { periodLabel } from '@/lib/contractor-invoices'

export const runtime = 'nodejs'

const DeclineSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(1000),
})

export async function POST(request, { params }) {
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
  if (inv.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot decline an invoice in '${inv.status}' state.` },
      { status: 409 }
    )
  }

  if (user.role !== 'master') {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (!ownerLocations.includes(inv.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
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

  // Push notification (best-effort). Tap deep-link routes the
  // mobile app to the invoice detail where the operator can read
  // the reason and resubmit.
  try {
    const reasonSnippet = (declined.decline_reason || '').slice(0, 100)
    await sendPush([declined.contractor_id], {
      title: 'Invoice needs adjustment',
      body: reasonSnippet
        ? `${periodLabel(declined.period_start)} — ${reasonSnippet}${declined.decline_reason.length > 100 ? '…' : ''}`
        : `Your ${periodLabel(declined.period_start)} invoice was declined. Tap to view and resubmit.`,
      category: 'invoice_declined',
      data: {
        type: 'invoice_declined',
        invoice_id: declined.id,
      },
    })
  } catch (e) {
    console.warn(`[invoice-decline] push failed for ${declined.id}: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    data: declined,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
