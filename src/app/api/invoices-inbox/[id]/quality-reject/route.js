// INVOICES.1 stage 1 reject — operator says "not legible / not an
// invoice / wrong location" before OCR runs. Terminal.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  reason: z.string().min(1).max(1000),
})

export async function POST(request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  if (!canTransitionInboundInvoice(row.status, 'rejected')) {
    return NextResponse.json({
      success: false,
      error: `Cannot reject from '${row.status}' state.`,
    }, { status: 409 })
  }
  // Stage 1 reject means the row is still in 'received'. Any later
  // reject goes through /data-reject.
  if (row.status !== 'received') {
    return NextResponse.json({
      success: false,
      error: `Quality reject only applies in 'received' state. This one is '${row.status}'.`,
    }, { status: 409 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const { data: updated, error } = await db
    .from('invoices_queue')
    .update({
      status: 'rejected',
      rejected_stage: 'quality',
      rejected_at: new Date().toISOString(),
      reject_reason: reason,
      quality_reviewed_at: new Date().toISOString(),
      quality_reviewed_by: user.id,
    })
    .eq('id', id)
    .eq('status', 'received')
    .select('id, status, rejected_stage, rejected_at, reject_reason')
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
