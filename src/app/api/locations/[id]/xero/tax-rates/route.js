// XERO-BILL-VAT.2 — GET /api/locations/[id]/xero/tax-rates
//
// Read-side endpoint for the VAT-rate picker in /invoices review.
// Returns the location's ACTIVE, expense-applicable rates from the
// xero_tax_rates cache (populated by pullTaxRates). No live Xero call.
//
// Returns: { success, taxRates: [{ tax_type, name, effective_rate, can_apply_to_expenses }], lastSyncedAt, stale }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 30

export async function GET(_request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
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
}
