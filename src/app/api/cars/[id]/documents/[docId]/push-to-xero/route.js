// POST /api/cars/[id]/documents/[docId]/push-to-xero
//
// INVOICE-OCR.1 — push the (operator-reviewed) extracted_invoice_fields
// on a car_document to Xero as a DRAFT ACCPAY bill via /Invoices.
//
// Body (optional):
//   { fields: <invoice fields object> }
// If provided, the body's fields are persisted onto the row FIRST
// (capturing any edits the operator made in the review screen),
// then the freshly-saved fields drive the push. If absent, the
// existing extracted_invoice_fields are used as-is.
//
// On success, stores xero_bill_id + xero_pushed_at + flips
// review_status to 'pushed'. On failure, stores xero_push_error.
// The /extract route can be re-run to retry the OCR step.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { invoiceFieldsSchema } from '@/lib/invoice-extraction'
import { pushExtractedInvoiceToXero } from '@/lib/xero/draft-bills'

export const runtime = 'nodejs'
export const maxDuration = 60

const Body = z.object({
  fields: invoiceFieldsSchema.optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsedBody = Body.safeParse(raw)
  if (!parsedBody.success) {
    return NextResponse.json({
      success: false,
      error: parsedBody.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }
  const overrideFields = parsedBody.data.fields || null

  const db = createServerClient()

  const { data: doc, error: loadErr } = await db
    .from('car_documents')
    .select('id, car_id, extracted_invoice_fields, cars!inner(id, location_id)')
    .eq('id', params.docId)
    .single()
  if (loadErr || !doc) {
    return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 })
  }
  if (doc.car_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Document does not belong to this car' }, { status: 400 })
  }
  const locationId = doc.cars.location_id
  const guard = assertLocationAccess(user, locationId)
  if (guard) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Resolve the fields to push: operator's edits (if any) take
  // precedence over the stored extraction.
  const fieldsToPush = overrideFields || doc.extracted_invoice_fields
  if (!fieldsToPush) {
    return NextResponse.json({
      success: false,
      error: 'No extracted fields available. Run /extract first.',
    }, { status: 422 })
  }

  // Persist the edits (if any) BEFORE the Xero call so the audit
  // trail matches what was pushed even if the Xero call fails.
  if (overrideFields) {
    const { error: persistErr } = await db
      .from('car_documents')
      .update({
        extracted_invoice_fields: overrideFields,
        review_status: 'reviewed',
      })
      .eq('id', params.docId)
    if (persistErr) {
      return NextResponse.json({
        success: false,
        error: `Failed to persist operator edits: ${persistErr.message}`,
      }, { status: 500 })
    }
  }

  // Push.
  const push = await pushExtractedInvoiceToXero({ locationId, fields: fieldsToPush })
  if (!push.ok) {
    await db.from('car_documents').update({
      review_status: 'failed',
      xero_push_error: push.error?.slice(0, 4000) || null,
    }).eq('id', params.docId)
    return NextResponse.json({ success: false, error: push.error }, { status: push.status || 500 })
  }

  // Success — record the bill linkage.
  const { data: updated, error: upErr } = await db
    .from('car_documents')
    .update({
      xero_bill_id: push.billId,
      xero_pushed_at: new Date().toISOString(),
      xero_pushed_by: user.id,
      xero_push_error: null,
      review_status: 'pushed',
    })
    .eq('id', params.docId)
    .select('id, review_status, xero_bill_id, xero_pushed_at')
    .single()
  if (upErr) {
    return NextResponse.json({
      success: false,
      error: `Xero push succeeded (BillID ${push.billId}) but DB update failed: ${upErr.message}`,
      push,
    }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    document: updated,
    xero: {
      bill_id: push.billId,
      invoice_number: push.invoiceNumber,
      deep_link_url: push.deepLinkUrl,
    },
  })
}
