// /api/cars/[id]/issue-xero-invoice — placeholder.
//
// Phase B will implement the real call against Xero's Accounting API
// (POST /Invoices with the buyer + line items). The plumbing for the
// resulting invoice id / number / URL is already in the cars table
// (xero_invoice_id, xero_invoice_number, xero_invoice_url,
// xero_invoice_issued_at), so wiring this up doesn't need a schema
// migration — only the OAuth dance (XERO_CLIENT_ID, XERO_CLIENT_SECRET,
// XERO_TENANT_ID, XERO_REFRESH_TOKEN) and the SDK call.
//
// Until those env vars are set, this returns 501 Not Implemented so
// the UI can show a clear "configure Xero to enable" message.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: car } = await db.from('cars').select('*').eq('id', params.id).single()
  if (!car) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return guard

  // Pre-flight: do we even have buyer details + a price to invoice?
  if (!car.buyer_name) {
    return NextResponse.json({ success: false, error: 'Add buyer details first' }, { status: 400 })
  }
  if (!car.irish_sale_price_inc_vat) {
    return NextResponse.json({ success: false, error: 'Set the Irish sale price first' }, { status: 400 })
  }

  const configured = process.env.XERO_CLIENT_ID
    && process.env.XERO_CLIENT_SECRET
    && process.env.XERO_TENANT_ID
    && process.env.XERO_REFRESH_TOKEN

  if (!configured) {
    return NextResponse.json({
      success: false,
      error: 'Xero integration is not configured. Add XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_TENANT_ID and XERO_REFRESH_TOKEN to your environment to enable invoice creation from this button.',
      placeholder: true,
    }, { status: 501 })
  }

  // Phase B will call Xero here and persist the result. For now we
  // shouldn't reach this branch at all because the env vars aren't
  // set on the live deploy.
  return NextResponse.json({
    success: false,
    error: 'Xero call not yet implemented. Configure values are present but the integration code lands in Phase B.',
    placeholder: true,
  }, { status: 501 })
}
