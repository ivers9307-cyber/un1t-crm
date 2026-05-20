// XERO-API.2 PR 2 — GET /api/locations/[id]/xero/accounts
//
// Read-side endpoint for the AccountPicker in /invoices review.
// Returns rows from the local xero_accounts cache (populated by
// PR 1's pullAccounts sync helper). No live Xero call.
//
// Query params:
//   ?type=EXPENSE      — filter to a single AccountType (default: EXPENSE)
//   ?type=ALL          — bypass the type filter (advanced use; e.g.
//                        a future flow that needs revenue accounts).
//
// Always filters status='ACTIVE' — archived accounts never appear
// in the picker. The cache still holds them so historical
// extracted_fields rows can resolve their label, but the operator
// can't select an archived one going forward.
//
// Returns: { success, accounts: [{ id, xero_account_id, code, name, account_type, tax_type }], stale }
//   `stale` is true when accounts_last_synced_at is null OR > 30
//   days old, so the UI can prompt for a refresh.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 30

export async function GET(request, props) {
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

  const url = new URL(request.url)
  const typeRaw = (url.searchParams.get('type') || 'EXPENSE').toUpperCase()
  const wantAll = typeRaw === 'ALL'

  const db = createServerClient()

  let q = db
    .from('xero_accounts')
    .select('id, xero_account_id, code, name, account_type, tax_type')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .order('code', { ascending: true, nullsFirst: false })
  if (!wantAll) q = q.eq('account_type', typeRaw)

  const { data: accounts, error } = await q.limit(500)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Surface freshness so the UI can prompt the bookkeeper to
  // refresh if the cache is missing or stale.
  const { data: conn } = await db
    .from('xero_connections')
    .select('accounts_last_synced_at')
    .eq('location_id', locationId)
    .maybeSingle()
  const stale = !conn?.accounts_last_synced_at
    || (Date.now() - new Date(conn.accounts_last_synced_at).getTime()) > STALE_AFTER_DAYS * 86400_000

  return NextResponse.json({
    success: true,
    accounts: accounts || [],
    lastSyncedAt: conn?.accounts_last_synced_at || null,
    stale,
  })
}
