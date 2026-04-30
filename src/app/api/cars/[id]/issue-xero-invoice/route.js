// POST /api/cars/[id]/issue-xero-invoice
// Pushes a Xero customer invoice for the car and writes the resulting
// xero_invoice_* fields back to the row. The detail-page button calls
// this; the API also flips xero_invoice_issued_at so the existing
// completion gate in completionGaps() automatically un-blocks.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { issueCarInvoice } from '@/lib/xero/invoices'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car, error: loadErr } = await db
    .from('cars')
    .select('*')
    .eq('id', params.id)
    .single()
  if (loadErr || !car) {
    return NextResponse.json({ success: false, error: 'Car not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (car.xero_invoice_id) {
    return NextResponse.json({
      success: false,
      error: `Invoice already issued (${car.xero_invoice_number || car.xero_invoice_id}). Void it in Xero first if you need to re-issue.`,
    }, { status: 409 })
  }

  try {
    const result = await issueCarInvoice(car)

    const { error: upErr } = await db.from('cars').update({
      xero_invoice_id: result.invoiceId,
      xero_invoice_number: result.invoiceNumber,
      xero_invoice_url: result.invoiceUrl,
      xero_invoice_issued_at: result.issuedAt,
    }).eq('id', car.id)

    if (upErr) {
      // The invoice IS in Xero at this point, but we couldn't persist
      // the link — surface that explicitly so the operator can paste
      // the number/URL manually rather than thinking it failed.
      return NextResponse.json({
        success: false,
        error: `Invoice created in Xero (${result.invoiceNumber}) but DB update failed: ${upErr.message}`,
        invoice: result,
      }, { status: 500 })
    }

    return NextResponse.json({ success: true, invoice: result })
  } catch (e) {
    const status = e instanceof XeroError && e.status ? Math.min(Math.max(e.status, 400), 599) : 500
    return NextResponse.json({ success: false, error: e.message || 'Xero error' }, { status })
  }
}
