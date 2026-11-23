// INVOICES.1 — operator-edited overrides on extracted_fields.
//
// Stage 2 review: Claude Vision extracts, operator reviews. If
// anything is wrong the operator edits the fields right in the
// inbox UI; the corrected values get persisted to extracted_fields
// before /data-approve fires the Xero forward.
//
// Legal while the row is in 'extracted' state (and on a data_approved
// row whose Xero send failed). After forwarded the fields are frozen —
// read the file again if a correction is needed.
//
// INVOICEPREP.3: after an 'extracted' row is saved, recheckInvoiceRow
// recomputes its review reasons from the edited fields, and the response
// carries them as review_reasons, with extracted_fields as stored after the
// re-check (it may re-derive the tax type). A failed re-check is logged and
// never undoes the save: the response then carries the reasons the row was
// loaded with. A row that moved on before the save answers 409.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/validate'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForUser } from '../../_helpers'
import { invoiceFieldsSchema } from '@/lib/invoice-extraction'
import { recheckInvoiceRow } from '@/lib/invoices-queue/prepare'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// We accept the full schema so the UI can send back the whole
// edited object — keeps the contract symmetrical with GET.
const Schema = z.object({
  extracted_fields: invoiceFieldsSchema,
})

// withAuth only signs the caller in; loadInvoiceForUser keeps the row gate
// (404 unknown or not allowed) in its old place, before the state check.
export const PATCH = withAuth({ permission: null, location: false }, async ({ request, params }) => {
  const { id } = params
  const ctx = await loadInvoiceForUser(id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  // Editable while 'extracted' (normal review) OR while
  // 'data_approved' with a Xero send failure — that row was approved
  // but never reached Xero (no bill created), so the operator must be
  // able to correct the field that caused the failure (e.g. a missing
  // supplier) and retry. A successfully 'forwarded' row stays frozen.
  const editable =
    row.status === 'extracted' ||
    (row.status === 'data_approved' && !!row.xero_error)
  if (!editable) {
    return NextResponse.json({
      success: false,
      error: `Cannot edit fields in '${row.status}' state.`,
    }, { status: 409 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { extracted_fields } = validation.data

  // No .single(): a guarded update that matched nothing is a concurrent
  // change (409), not an error.
  const { data: rows, error } = await db
    .from('invoices_queue')
    .update({ extracted_fields })
    .eq('id', id)
    .eq('status', row.status)   // concurrency guard for the state we loaded
    .select('id, status, extracted_fields, updated_at')
  const updated = Array.isArray(rows) ? rows[0] : null
  if (error) {
    logError('invoices-inbox', 'fields update failed', { id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the fields. Try again.' }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({
      success: false,
      error: 'Row was modified concurrently — refresh and retry.',
    }, { status: 409 })
  }
  if (updated.status !== 'extracted') {
    return NextResponse.json({ success: true, data: updated })
  }
  return NextResponse.json({ success: true, data: { ...updated, ...(await recheckAfterSave(db, id, row)) } })
})

// The re-check needs the whole row (fields, reasons, studio). A failure here
// answers the reasons the row holds: the fresh row's if it was read, else the
// ones it was loaded with.
async function recheckAfterSave(db, id, loaded) {
  const fallback = (r) => (Array.isArray(r?.review_reasons) ? { review_reasons: r.review_reasons } : {})
  let fresh = null
  try {
    const { data, error } = await db
      .from('invoices_queue')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error || !data) {
      logError('invoices-inbox', 'fields re-check read failed', { id, err: error })
      return fallback(loaded)
    }
    fresh = data
    const { reasons, fields } = await recheckInvoiceRow(db, fresh)
    return fields ? { review_reasons: reasons, extracted_fields: fields } : { review_reasons: reasons }
  } catch (err) {
    logError('invoices-inbox', 'fields re-check failed', { id, err })
    return fallback(fresh || loaded)
  }
}
