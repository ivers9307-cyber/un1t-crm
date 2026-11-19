// XERO-BILL-VAT.2 — GET /api/locations/[id]/xero/tax-rates
//
// Read-side endpoint for the VAT-rate picker in /invoices review.
// Returns the location's ACTIVE, expense-applicable rates from the
// xero_tax_rates cache (populated by pullTaxRates). No live Xero call.
//
// Returns: { success, taxRates: [{ tax_type, name, effective_rate, can_apply_to_expenses }], lastSyncedAt, stale }

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 30

export const GET = withAuth({ permission: null, location: 'param' }, async ({ db, locationId }) => {
  const { data: taxRates, error } = await db
    .from('xero_tax_rates')
    .select('tax_type, name, effective_rate, can_apply_to_expenses')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('can_apply_to_expenses', true)
    .order('effective_rate', { ascending: true, nullsFirst: true })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const { data: conn } = await db
    .from('xero_connections')
    .select('tax_rates_last_synced_at')
    .eq('location_id', locationId)
    .maybeSingle()
  const stale = !conn?.tax_rates_last_synced_at
    || (Date.now() - new Date(conn.tax_rates_last_synced_at).getTime()) > STALE_AFTER_DAYS * 86400_000

  return NextResponse.json({
    success: true,
    taxRates: taxRates || [],
    lastSyncedAt: conn?.tax_rates_last_synced_at || null,
    stale,
  })
})
