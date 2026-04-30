// Removes a stored Xero connection for the given location. Does not
// revoke the token on Xero's side (which would require a separate
// /connections DELETE call) — re-auth re-uses the same tenant ID, so
// there's no harm in leaving it. We can plumb in a hard revoke later.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const locationId = body.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })
  }

  const db = createServerClient()
  const { error } = await db.from('xero_connections').delete().eq('location_id', locationId)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
