// INVOICES.1 — single inbound invoice endpoints.
//
// GET    /api/invoices-inbox/[id]  — detail (master + owner-at-location)
// DELETE /api/invoices-inbox/[id]  — delete (rejected rows only; master + owner)

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'

export async function GET(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  return NextResponse.json({ success: true, data: ctx.row })
}

// Deletion is allowed only for terminal-rejected rows so the inbox
// doesn't accumulate junk. Forwarded rows stay around for audit.
export async function DELETE(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
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
    try { await db.storage.from(STORAGE_BUCKET).remove([row.attachment_path]) } catch { /* ignore */ }
  }

  const { error: delErr } = await db
    .from('invoices_queue')
    .delete()
    .eq('id', id)
    .eq('status', 'rejected') // belt + braces against a race
  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
