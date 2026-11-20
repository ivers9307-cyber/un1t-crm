// INVOICES.1 — short-lived signed URL for the inbox UI to display
// the original attachment.
//
// QUEUE-ATTACHMENT-BUCKET — INVOICES-QUEUE.1 PR 1 (mig 185) widened
// the queue beyond supplier emails. Each row's storage location is
// now recorded on attachment_bucket:
//   supplier_email     → 'inbound-invoices'
//   contractor_invoice → 'contractor-invoices'
//   fte_expense_item   → 'fte-expense-receipts'
//   car_document       → 'car-documents'
// Use the per-row bucket so previews work for every source. The
// old hardcoded 'inbound-invoices' meant car/contractor/FTE rows
// returned 404 and the UI showed 'No attachment available' even
// though the file was sitting fine in its own bucket.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForCaller } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SIGNED_URL_TTL_SECONDS = 300 // 5 minutes
// Fallback for any legacy row written before mig 185 added the
// attachment_bucket column. New rows always have it populated.
const FALLBACK_BUCKET = 'inbound-invoices'

// withAuth only signs the caller in; loadInvoiceForCaller keeps the
// invoices_inbox permission and the master / owner-at-the-row's-studio check
// (404 on no access), as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await loadInvoiceForCaller(user, params?.id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (!row.attachment_path) {
    return NextResponse.json({ success: false, error: 'No attachment.' }, { status: 404 })
  }

  const bucket = row.attachment_bucket || FALLBACK_BUCKET
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(row.attachment_path, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) {
    logError('invoices-inbox', 'attachment url not signed', { invoiceId: row.id, bucket, err: error || null })
    return NextResponse.json({ success: false, error: 'Could not open the attachment. Try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: {
      url: data.signedUrl,
      filename: row.attachment_filename,
      mime_type: row.attachment_mime_type,
      size_bytes: row.attachment_size_bytes,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    },
  })
})
