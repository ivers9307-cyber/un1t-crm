// XERO-API.2 PR 2 — GET /api/locations/[id]/xero/accounts
//
// Read-side endpoint for the AccountPicker in /invoices review.
// Returns rows from the local xero_accounts cache (populated by
// PR 1's pullAccounts sync helper). No live Xero call.
//
// Query params:
//   (none) / ?type=SPEND — the DEFAULT: every account class you can
//                        code a supplier bill to (see BILL_ACCOUNT_TYPES).
//                        Filtering to the single 'EXPENSE' class was a
//                        bug: standard Irish/UK charts (e.g. SourceIt)
//                        put day-to-day expenses under OVERHEADS and
//                        DIRECTCOSTS, so a bill picker limited to
//                        'EXPENSE' hid the accounts operators actually
//                        use (they saw 4 of 29+).
//   ?type=<ACCOUNTTYPE>  — filter to one specific Xero AccountType.
//   ?type=ALL          — bypass the type filter entirely.
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

// Xero AccountTypes you can code a purchase bill (ACCPAY) line to —
// the debit side. Covers P&L expenses (EXPENSE/OVERHEADS/DIRECTCOSTS)
// plus balance-sheet postings a bill legitimately hits: capital
// purchases (FIXED), prepayments (CURRENT), and creditor/tax
// liabilities (CURRLIAB). Deliberately EXCLUDES income (SALES,
// REVENUE, OTHERINCOME), EQUITY, and BANK — you never debit those on
// a supplier bill.
const BILL_ACCOUNT_TYPES = ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'FIXED', 'CURRENT', 'CURRLIAB']

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
  // Default (no param) = SPEND: the full bill-codeable set.
  const typeRaw = (url.searchParams.get('type') || 'SPEND').toUpperCase()

  const db = createServerClient()

  let q = db
    .from('xero_accounts')
    .select('id, xero_account_id, code, name, account_type, tax_type')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .order('code', { ascending: true, nullsFirst: false })
  if (typeRaw === 'ALL') {
    // no account_type filter
  } else if (typeRaw === 'SPEND') {
    q = q.in('account_type', BILL_ACCOUNT_TYPES)
  } else {
    q = q.eq('account_type', typeRaw) // single specific AccountType
  }

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
