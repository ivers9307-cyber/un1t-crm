// POST /api/cars/[id]/issue-xero-invoice
//
// Pre-flight validation → upsert Contact in Xero → create Invoice
// (AUTHORISED, "Car" branding theme) → email it to the buyer →
// download PDF and store in Supabase → persist all metadata.
//
// All happens inside a single API call so the UI flips state in
// one round-trip. Errors at intermediate steps return 4xx/5xx with
// a clear message.

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { issueCarInvoice, validateInvoiceFields } from '@/lib/xero/invoices'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

// withAuth only signs the caller in (its 401 'Unauthorized'; was 'Unauthorised').
// car_processing somewhere (403), the car (404), its studio (404),
// car_processing there (403), already issued (409) and the fields (400) keep
// their order; the Xero call and the write are unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { data: car, error: loadErr } = await db
    .from('cars').select('*').eq('id', params.id).single()
  if (loadErr || !car) {
    return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard
  // ROLESWEEP.1b — judged at the car's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  if (car.xero_invoice_id) {
    return NextResponse.json({
      success: false,
      error: `Invoice already issued (${car.xero_invoice_number || car.xero_invoice_id}). Use Void & reissue if the price has changed.`,
    }, { status: 409 })
  }

  // Hard-block on missing fields so the operator sees what to fix
  // before the (slow) Xero round-trip starts.
  const fieldErrors = validateInvoiceFields(car)
  if (fieldErrors.length) {
    return NextResponse.json({
      success: false,
      error: fieldErrors.join(' '),
      fieldErrors,
    }, { status: 400 })
  }

  try {
    const result = await issueCarInvoice(car)

    const { error: upErr } = await db.from('cars').update({
      xero_invoice_id: result.invoiceId,
      xero_invoice_number: result.invoiceNumber,
      xero_invoice_url: result.invoiceUrl,
      xero_invoice_online_url: result.onlineInvoiceUrl,
      xero_invoice_pdf_path: result.pdfPath,
      xero_invoice_amount: result.amount,
      xero_invoice_branding_id: result.brandingThemeId,
      xero_invoice_emailed_at: result.emailedAt,
      xero_invoice_issued_at: result.issuedAt,
    }).eq('id', car.id)

    if (upErr) {
      logError('cars-xero-invoice', 'car update after invoice failed', { carId: car.id, invoiceNumber: result.invoiceNumber, err: upErr })
      return NextResponse.json({
        success: false,
        error: `Invoice created in Xero (${result.invoiceNumber}) but saving it on the car failed.`,
        invoice: result,
      }, { status: 500 })
    }

    // Atomic issue-count bump (best-effort) — secondary to the invoice op.
    try { await db.rpc('increment_car_xero_issue_count', { p_car_id: car.id }) } catch {}

    return NextResponse.json({ success: true, invoice: result })
  } catch (e) {
    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    // CAR-SALES-ACCOUNT.1 — Xero's top-level message for invoice
    // validation failures is just "A validation exception occurred"
    // which is useless to the operator. The real detail is buried
    // in body.Elements[*].ValidationErrors[*].Message. Surface it.
    const validationDetails = []
    const elements = e?.body?.Elements
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (Array.isArray(el?.ValidationErrors)) {
          for (const v of el.ValidationErrors) {
            if (v?.Message) validationDetails.push(v.Message)
          }
        }
      }
    }
    // ROUTEWRAP.R15 — Xero's own per-field validation messages are the
    // operator's to fix and still ride the answer; the top-level error text
    // (which can carry database or token-exchange detail) is logged instead.
    logError('cars-xero-invoice', 'issue failed', { carId: car.id, status, err: e?.message || String(e) })
    const message = validationDetails.length
      ? `Xero refused the invoice — ${validationDetails.join(' · ')}`
      : 'Xero could not issue the invoice. Try again.'
    return NextResponse.json({
      success: false,
      error: message,
      ...(validationDetails.length ? { validationDetails } : {}),
    }, { status })
  }
})
