// INVOICES.1 stage 1 reject — operator says "not legible / not an
// invoice / wrong location" before OCR runs. Terminal.
//
// INVOICEPREP.3 — also a quality_approved row that preparation flagged
// unreadable or duplicate_file: it never reaches extracted, so this is the
// only way a person can set it aside. The write is guarded on the status the
// route read, and clears the queue columns so nothing reads the row again.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { loadInvoiceForUser } from '../../_helpers'
import { canTransitionInboundInvoice } from '@/lib/inbound-invoices'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Reasons that keep a row out of extracted, so data-reject cannot reach it.
const UNCLEARABLE = new Set(['unreadable', 'duplicate_file'])

const Schema = z.object({
  reason: z.string().min(1).max(1000),
})

// Sign-in here, then loadInvoiceForUser (which signs the caller in again) keeps
// its 404s for another studio's row and its owner/master + invoices_inbox
// rule; every later check is unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ request, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { user, db, row } = ctx

  if (!canTransitionInboundInvoice(row.status, 'rejected')) {
    return NextResponse.json({
      success: false,
      error: `Cannot reject from '${row.status}' state.`,
    }, { status: 409 })
  }
  // Stage 1 reject means the row is still in 'received', or was vouched for
  // but cannot be read or is a copy. Any later reject goes through /data-reject.
  const reasons = Array.isArray(row.review_reasons) ? row.review_reasons : []
  const flagged = row.status === 'quality_approved' && reasons.some((r) => UNCLEARABLE.has(r))
  if (row.status !== 'received' && !flagged) {
    return NextResponse.json({
      success: false,
      error: `Quality reject only applies in 'received' state, or to a row that could not be read or is a copy. This one is '${row.status}'.`,
    }, { status: 409 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { reason } = validation.data

  const nowIso = new Date().toISOString()
  const { data: rows, error } = await db
    .from('invoices_queue')
    .update({
      status: 'rejected',
      rejected_stage: 'quality',
      rejected_at: nowIso,
      reject_reason: reason,
      quality_reviewed_at: nowIso,
      quality_reviewed_by: user.id,
      analysis_queued_at: null,
      analysis_claimed_at: null,
    })
    .eq('id', id)
    .eq('status', row.status)
    .select('id, status, rejected_stage, rejected_at, reject_reason')
  if (error) {
    logError('invoices-inbox', 'quality reject failed', { invoiceId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not reject the invoice. Try again.' }, { status: 500 })
  }
  const updated = Array.isArray(rows) ? rows[0] : null
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: updated })
})
