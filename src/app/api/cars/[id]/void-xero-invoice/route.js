// POST /api/cars/[id]/void-xero-invoice?reissue=true
//
// Voids the existing Xero invoice on a car. With ?reissue=true,
// also pushes a fresh invoice immediately afterwards (the typical
// flow when the sale price changed and we want the buyer to
// receive the corrected document).
//
// On void-only: clears xero_invoice_* columns so the car is in
// "no invoice" state again. The voided invoice stays in Xero's
// history under VOIDED status — Xero never deletes anything.
//
// On reissue: a new invoice is created with a new InvoiceNumber.
// The old number remains in Xero's audit trail.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { issueCarInvoice, voidCarInvoice, validateInvoiceFields } from '@/lib/xero/invoices'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

const CLEARED_INVOICE_FIELDS = {
  xero_invoice_id: null,
  xero_invoice_number: null,
  xero_invoice_url: null,
  xero_invoice_online_url: null,
  xero_invoice_pdf_path: null,
  xero_invoice_amount: null,
  xero_invoice_branding_id: null,
  xero_invoice_emailed_at: null,
  xero_invoice_issued_at: null,
}

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(request.url)
  const reissue = url.searchParams.get('reissue') === 'true'

  const db = createServerClient()
  const { data: car, error: loadErr } = await db
    .from('cars').select('*').eq('id', params.id).single()
  if (loadErr || !car) {
    return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return guard

  if (!car.xero_invoice_id) {
    return NextResponse.json({ success: false, error: 'No invoice to void.' }, { status: 400 })
  }

  // If reissuing, validate UP FRONT — don't void the old one only
  // to find we can't issue a new one because a field is missing.
  if (reissue) {
    const errors = validateInvoiceFields(car)
    if (errors.length) {
      return NextResponse.json({
        success: false,
        error: `Cannot reissue — fix these first: ${errors.join(' ')}`,
        fieldErrors: errors,
      }, { status: 400 })
    }
  }

  try {
    const voidResult = await voidCarInvoice(car)

    if (!reissue) {
      const { error: upErr } = await db.from('cars').update(CLEARED_INVOICE_FIELDS).eq('id', car.id)
      if (upErr) {
        return NextResponse.json({
          success: false,
          error: `Invoice voided in Xero (${car.xero_invoice_number}) but DB update failed: ${upErr.message}`,
          void: voidResult,
        }, { status: 500 })
      }
      return NextResponse.json({ success: true, void: voidResult })
    }

    // Reissue: clear the old fields, then push a new invoice. Use
    // the freshly-loaded `car` (with new sale price etc) — the old
    // invoice details on it are about to be replaced.
    const carWithoutInvoice = { ...car, ...CLEARED_INVOICE_FIELDS }
    const issueResult = await issueCarInvoice(carWithoutInvoice)

    const { error: upErr } = await db.from('cars').update({
      xero_invoice_id: issueResult.invoiceId,
      xero_invoice_number: issueResult.invoiceNumber,
      xero_invoice_url: issueResult.invoiceUrl,
      xero_invoice_online_url: issueResult.onlineInvoiceUrl,
      xero_invoice_pdf_path: issueResult.pdfPath,
      xero_invoice_amount: issueResult.amount,
      xero_invoice_branding_id: issueResult.brandingThemeId,
      xero_invoice_emailed_at: issueResult.emailedAt,
      xero_invoice_issued_at: issueResult.issuedAt,
    }).eq('id', car.id)

    if (upErr) {
      return NextResponse.json({
        success: false,
        error: `Voided ${car.xero_invoice_number} and issued ${issueResult.invoiceNumber} in Xero, but DB update failed: ${upErr.message}`,
        void: voidResult,
        invoice: issueResult,
      }, { status: 500 })
    }

    // Atomic issue-count bump (best-effort) — secondary to the invoice op.
    try { await db.rpc('increment_car_xero_issue_count', { p_car_id: car.id }) } catch {}

    return NextResponse.json({ success: true, void: voidResult, invoice: issueResult })
  } catch (e) {
    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({ success: false, error: e.message || 'Xero error' }, { status })
  }
}
