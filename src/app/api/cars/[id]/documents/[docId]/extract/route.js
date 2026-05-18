// POST /api/cars/[id]/documents/[docId]/extract
//
// INVOICE-OCR.1 — runs Claude Vision OCR on a stored car_document
// PDF/image, validates the extracted JSON against the invoice
// schema, and persists it as extracted_invoice_fields on the row.
// The operator then reviews + edits in the UI before calling the
// /push-to-xero sibling route.
//
// Idempotent: re-running overwrites the prior extraction. Useful
// when an operator uploads a clearer scan or wants to redo a
// low-confidence extraction.
//
// Manager+ gated (matches the existing /send-to-xero route guard).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { extractInvoiceFields } from '@/lib/invoice-extraction'

export const runtime = 'nodejs'
// Anthropic Vision calls on a 5-10 page invoice can take 15-25s.
// Pro ceiling is 300s; default 10s would time out. Cap at 60s —
// any slower than that and we want to fail loudly rather than
// hold the request thread.
export const maxDuration = 60

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()

  // Load + validate car ↔ document linkage + location access.
  const { data: doc, error: loadErr } = await db
    .from('car_documents')
    .select('id, car_id, cars!inner(id, location_id)')
    .eq('id', params.docId)
    .single()
  if (loadErr || !doc) {
    return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 })
  }
  if (doc.car_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Document does not belong to this car' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, doc.cars.location_id)
  if (guard) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Run the extraction. invoice-extraction.js never throws — it
  // returns { ok, fields | error }.
  const result = await extractInvoiceFields(params.docId)
  if (!result.ok) {
    // Stamp the failure on the row so the UI can show "extraction
    // failed, retry?" + a recent error message.
    await db.from('car_documents').update({
      review_status: 'failed',
      xero_push_error: result.error?.slice(0, 4000) || null,
    }).eq('id', params.docId)
    return NextResponse.json({ success: false, error: result.error, raw_response: result.raw_response }, { status: 422 })
  }

  // Persist the extracted fields + bump status to 'extracted'.
  // Operator reviews + edits via PATCH (handled inline below or
  // in a future route — for now the same JSONB can be updated
  // directly via PATCH on the doc; in this PR the UI calls /extract
  // once then /push-to-xero, and any edits happen client-side
  // before push).
  const { data: updated, error: upErr } = await db
    .from('car_documents')
    .update({
      extracted_invoice_fields: result.fields,
      extracted_at: new Date().toISOString(),
      extracted_by: user.id,
      review_status: 'extracted',
      xero_push_error: null,
    })
    .eq('id', params.docId)
    .select('id, review_status, extracted_invoice_fields, extracted_at')
    .single()

  if (upErr) {
    return NextResponse.json({
      success: false,
      error: `Extraction succeeded but persistence failed: ${upErr.message}`,
      fields: result.fields,
    }, { status: 500 })
  }

  return NextResponse.json({ success: true, document: updated, fields: result.fields })
}
