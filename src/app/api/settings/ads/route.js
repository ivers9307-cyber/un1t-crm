// ADS-REPORT.0 — settings API for ad_accounts.
//
// GET  ?locationId=…  → masked ad_accounts rows for a location
// PUT  { locationId, provider, external_account_id, access_token, is_active }
// Owner/manager/master only. Service-role DB; access enforced in app code.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { maskAccountRow, buildAccountPatch } from '@/lib/ads/accounts'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const locationId = new URL(request.url).searchParams.get('locationId')
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('ad_accounts').select('*').eq('location_id', locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: (data || []).map(maskAccountRow) })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { locationId, provider } = body
  if (!locationId || !['meta', 'tiktok'].includes(provider)) {
    return NextResponse.json({ success: false, error: 'locationId + valid provider required' }, { status: 400 })
  }

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const role = user.isMaster ? 'master' : user.rolesByLocation?.[locationId]
  if (!ADMIN_ROLES.includes(role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const patch = buildAccountPatch(body)
  const row = { location_id: locationId, provider, ...patch, updated_at: new Date().toISOString() }

  const { data, error } = await db
    .from('ad_accounts')
    .upsert(row, { onConflict: 'location_id,provider,external_account_id' })
    .select('*')
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data: maskAccountRow(data) })
}
