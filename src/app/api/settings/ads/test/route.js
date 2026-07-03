// ADS-REPORT.0 — settings API test-connection probe for ad_accounts.
//
// POST { locationId, provider } → does a cheap live read with the stored
// token and reports success + account name, or the provider error message.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveAdsAccount } from '@/lib/ads/accounts'
import { testMetaConnection } from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const { locationId, provider } = await request.json().catch(() => ({}))
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const account = await resolveAdsAccount(db, locationId, provider)
  if (!account?.access_token) {
    return NextResponse.json({ success: false, error: 'No active account/token saved' }, { status: 400 })
  }

  if (provider === 'meta') {
    const res = await testMetaConnection(account)
    return NextResponse.json(res) // { success, name?, error? }
  }

  return NextResponse.json({ success: false, error: 'Provider not supported yet' }, { status: 400 })
}
