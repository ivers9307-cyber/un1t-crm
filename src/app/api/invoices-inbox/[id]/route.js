// INVOICES.1 — single inbound invoice endpoints.
//
// GET    /api/invoices-inbox/[id]  — detail (master + owner-at-location)
// DELETE /api/invoices-inbox/[id]  — delete (rejected rows only; master + owner)

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForCaller } from '../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'

// SAAS-7 — remove from the row's OWN bucket. mig 185 widened the queue
// beyond supplier emails (contractor/FTE/card/car rows live in their own
// buckets — see the attachment route's bucket map); removing from the
// hardcoded inbound-invoices bucket orphaned the real object for those
// sources. Fallback covers legacy pre-mig-185 rows.
export function removalBucket(row) {
  return row?.attachment_bucket || STORAGE_BUCKET
}

// withAuth only signs the caller in; loadInvoiceForCaller keeps the
// invoices_inbox permission and the master / owner-at-the-row's-studio check
// (404 on no access), as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await loadInvoiceForCaller(user, params?.id)
  if (ctx.response) return ctx.response
  return NextResponse.json({ success: true, data: ctx.row })
})

// Deletion is allowed only for terminal-rejected rows so the inbox
// doesn't accumulate junk. Forwarded rows stay around for audit.
export const DELETE = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForCaller(user, id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (row.status !== 'rejected') {
    return NextResponse.json({
      success: false,
      error: `Can only delete rejected rows. This one is '${row.status}'. Reject it first.`,
    }, { status: 409 })
  }

  // Best-effort storage cleanup before the row goes.
  if (row.attachment_path) {
    try { await db.storage.from(removalBucket(row)).remove([row.attachment_path]) } catch { /* ignore */ }
  }

  const { error: delErr } = await db
    .from('invoices_queue')
    .delete()
    .eq('id', id)
    .eq('status', 'rejected') // belt + braces against a race
  if (delErr) {
    logError('invoices-inbox', 'rejected row not deleted', { invoiceId: id, code: delErr.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not delete the invoice. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
})
