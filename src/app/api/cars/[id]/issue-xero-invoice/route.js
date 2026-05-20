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
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { issueCarInvoice, validateInvoiceFields } from '@/lib/xero/invoices'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car, error: loadErr } = await db
    .from('cars').select('*').eq('id', params.id).single()
  if (loadErr || !car) {
    return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

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
      xero_invoice_issue_count: (car.xero_invoice_issue_count || 0) + 1,
    }).eq('id', car.id)

    if (upErr) {
      return NextResponse.json({
        success: false,
        error: `Invoice created in Xero (${result.invoiceNumber}) but DB update failed: ${upErr.message}`,
        invoice: result,
      }, { status: 500 })
    }

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
    const message = validationDetails.length
      ? `${e.message || 'Xero error'} — ${validationDetails.join(' · ')}`
      : (e.message || 'Xero error')
    return NextResponse.json({
      success: false,
      error: message,
      ...(validationDetails.length ? { validationDetails } : {}),
    }, { status })
  }
}
