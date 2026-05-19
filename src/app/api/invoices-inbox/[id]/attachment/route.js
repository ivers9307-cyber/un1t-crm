// INVOICES.1 — short-lived signed URL for the inbox UI to display
// the original attachment. The bucket is private; signed URLs are
// the standard pattern (mirrors car_documents + fte_expense_items).

import { NextResponse } from 'next/server'
import { loadInvoiceForUser } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'inbound-invoices'
const SIGNED_URL_TTL_SECONDS = 300 // 5 minutes

export async function GET(_request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (!row.attachment_path) {
    return NextResponse.json({ success: false, error: 'No attachment.' }, { status: 404 })
  }

  const { data, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(row.attachment_path, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) {
    return NextResponse.json({
      success: false,
      error: `Could not sign attachment URL: ${error?.message || 'unknown error'}`,
    }, { status: 500 })
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
}
