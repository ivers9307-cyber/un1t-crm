// INVOICES.1 — operator-edited overrides on extracted_fields.
//
// Stage 2 review: Claude Vision extracts, operator reviews. If
// anything is wrong the operator edits the fields right in the
// inbox UI; the corrected values get persisted to extracted_fields
// before /data-approve fires the Xero forward.
//
// Only legal while the row is in 'extracted' state. After
// data_approved or forwarded the fields are frozen — re-extract
// from scratch if a correction is needed.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { loadInvoiceForUser } from '../../_helpers'
import { invoiceFieldsSchema } from '@/lib/invoice-extraction'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// We accept the full schema so the UI can send back the whole
// edited object — keeps the contract symmetrical with GET.
const Schema = z.object({
  extracted_fields: invoiceFieldsSchema,
})

export async function PATCH(request, { params }) {
  const { id } = await params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (row.status !== 'extracted') {
    return NextResponse.json({
      success: false,
      error: `Cannot edit fields in '${row.status}' state. Only 'extracted' is editable.`,
    }, { status: 409 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { extracted_fields } = validation.data

  const { data: updated, error } = await db
    .from('invoices_queue')
    .update({ extracted_fields })
    .eq('id', id)
    .eq('status', 'extracted')
    .select('id, status, extracted_fields, updated_at')
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
