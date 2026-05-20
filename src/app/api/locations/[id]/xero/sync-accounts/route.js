// XERO-API.1 PR 1 — POST /api/locations/[id]/xero/sync-accounts.
//
// Manual refresh of the cached chart of accounts for one location.
// Triggered from the Settings → Xero card (small Refresh button).
//
// Auth: must be a location member. We deliberately don't require
// the bookkeeper permission key — anyone with access to the
// Settings integrations card can trigger a refresh (it's benign,
// read-then-cache, no side effects on Xero's side). Locking it
// further would only mean the bookkeeper has to ping someone else
// to press the button.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Location membership — master + locations array both checked.
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  try {
    const result = await pullAccounts(locationId)
    return NextResponse.json({
      success: true,
      syncedCount: result.syncedCount,
      deletedCount: result.deletedCount,
      syncedAt: result.syncedAt,
    })
  } catch (e) {
    const status = e instanceof XeroError && e.status
      ? Math.min(Math.max(e.status, 400), 599)
      : 500
    return NextResponse.json(
      { success: false, error: e.message || 'Sync failed' },
      { status },
    )
  }
}
