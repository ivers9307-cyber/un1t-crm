// ADS-REPORT.0 — settings API test-connection probe for ad_accounts.
//
// POST { locationId, provider } → does a cheap live read with the stored
// token and reports success + account name, or the provider error message.
import { NextResponse } from 'next/server'
import { assertLocationAccess } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { resolveAdsAccount } from '@/lib/ads/accounts'
import { testMetaConnection } from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'

// No permission key, as before: membership of the body's studio
// (assertLocationAccess, 403) is the whole gate.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const { locationId, provider } = await request.json().catch(() => ({}))
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const account = await resolveAdsAccount(db, locationId, provider)
  if (!account?.access_token) {
    return NextResponse.json({ success: false, error: 'No active account/token saved' }, { status: 400 })
  }

  if (provider === 'meta') {
    const res = await testMetaConnection(account)
    return NextResponse.json(res) // { success, name?, error? }
  }

  return NextResponse.json({ success: false, error: 'Provider not supported yet' }, { status: 400 })
})
