// INVOICES.1 stage 1 approve — operator confirms the attachment is
// legible. Moves received → quality_approved. From there the
// /extract route runs Claude Vision OCR.

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  if (!canTransitionInboundInvoice(row.status, 'quality_approved')) {
    return NextResponse.json({
      success: false,
      error: `Cannot approve quality from '${row.status}' state.`,
    }, { status: 409 })
  }
  if (!row.attachment_path) {
    return NextResponse.json({
      success: false,
      error: 'This row has no attachment to approve.',
    }, { status: 400 })
  }

  const { data: updated, error } = await db
    .from('inbound_invoices')
    .update({
      status: 'quality_approved',
      quality_reviewed_at: new Date().toISOString(),
      quality_reviewed_by: user.id,
    })
    .eq('id', id)
    .eq('status', 'received') // optimistic concurrency
    .select('id, status, quality_reviewed_at, quality_reviewed_by')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: updated })
}
