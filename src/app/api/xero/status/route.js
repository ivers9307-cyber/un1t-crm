// GET /api/xero/status?location_id=...
// Returns whether a Xero connection exists for the location (without
// leaking the tokens), the tenant name, and the last refresh timestamp.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })

  const db = createServerClient()
  const { data: conn } = await db
    .from('xero_connections')
    .select('tenant_id, tenant_name, tenant_type, scopes, connected_at, last_refreshed_at, expires_at')
    .eq('location_id', locationId)
    .maybeSingle()

  return NextResponse.json({
    success: true,
    connected: !!conn,
    connection: conn || null,
  })
}
