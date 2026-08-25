// Removes a stored Xero connection for the given location. Does not
// revoke the token on Xero's side (which would require a separate
// /connections DELETE call) — re-auth re-uses the same tenant ID, so
// there's no harm in leaving it. We can plumb in a hard revoke later.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const locationId = body.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })
  }
  // IDOR guard — only disconnect a location the caller belongs to.
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db.from('xero_connections').delete().eq('location_id', locationId)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // XERO-ONE-ORG.3 — drop the org-specific caches with the connection.
  // They key on location_id, which still exists, so nothing cascades: CCF
  // Autos' disconnect left 509 rows (415 contacts, 78 accounts, 16 tax rates)
  // belonging to an org it was no longer connected to. Reconnect that location
  // to a DIFFERENT org and the pickers would offer the old company's contacts
  // and account codes — the wrong-org failure this series is about. Purged
  // AFTER the connection row is gone, so a partial failure leaves a
  // disconnected location with stale cache rather than a live connection with
  // no cache; the next connect re-syncs all three regardless.
  const purged = {}
  for (const table of ['xero_accounts', 'xero_contacts', 'xero_tax_rates']) {
    const { error: delErr, count } = await db
      .from(table)
      .delete({ count: 'exact' })
      .eq('location_id', locationId)
    if (delErr) console.warn(`[xero disconnect] ${table} purge: ${delErr.message}`)
    purged[table] = delErr ? null : (count ?? 0)
  }
  return NextResponse.json({ success: true, data: { purged } })
}
