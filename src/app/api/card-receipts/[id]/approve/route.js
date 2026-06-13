// POST /api/card-receipts/[id]/approve
//
// Owner/master only, at the receipt's location. Mirrors the contractor-
// invoice approval: status 'submitted' → 'awaiting_accountant_review',
// then drop a row into the central invoices_queue so the bookkeeper
// signs it off and forwards to Xero (SPEND.P3). The enqueue is best-
// effort — if it fails the approval still records and the operator can
// retry from /invoices.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { enqueueFromCardReceipt } from '@/lib/invoices-queue/enqueue'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()

  const { data: rec, error: loadErr } = await db
    .from('card_receipts')
    .select('id, submitter_id, location_id, status')
    .eq('id', params.id)
    .single()
  if (loadErr || !rec) {
    return NextResponse.json({ success: false, error: 'Card receipt not found' }, { status: 404 })
  }
  if (rec.status !== 'submitted') {
    return NextResponse.json(
      { success: false, error: `Cannot approve a receipt in '${rec.status}' state.` },
      { status: 409 }
    )
  }

  // Auth — owner-at-location or master.
  if (user.role !== 'master') {
    const ownerLocations = Object.entries(user.rolesByLocation || {})
      .filter(([, r]) => r === 'owner').map(([loc]) => loc)
    if (!ownerLocations.includes(rec.location_id)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
    }
  }

  const now = new Date().toISOString()
  const { data: approved, error: updErr } = await db
    .from('card_receipts')
    .update({
      status: 'awaiting_accountant_review',
      reviewed_by: user.id,
      reviewed_at: now,
      approved_at: now,
    })
    .eq('id', params.id)
    .eq('status', 'submitted') // race-safe
    .select()
    .single()
  if (updErr) {
    return NextResponse.json({ success: false, error: updErr.message }, { status: 400 })
  }
  if (!approved) {
    return NextResponse.json(
      { success: false, error: 'Receipt was already actioned by someone else.' },
      { status: 409 }
    )
  }

  const warnings = []
  const enq = await enqueueFromCardReceipt(approved.id)
  if (!enq.ok) {
    logWarn('card-receipt-approve', 'enqueue failed', { err: enq.error, receiptId: approved.id })
    warnings.push(`Queue insert failed: ${enq.error}. The approval is recorded; retry enqueue from /invoices.`)
  }

  return NextResponse.json({
    success: true,
    data: approved,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}
