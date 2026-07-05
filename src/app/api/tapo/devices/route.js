// GET /api/tapo/devices
//
// TAPO-T1.4 — staff-facing Tapo device registry for the active
// location. Returns EVERY row, including disabled ones — a disabled
// row reported by the bridge is an adoptable device (staff name +
// enable it), so the devices UI (X5) needs to see them.
//
// Service-role route: RLS does nothing here, so we authorize in app
// code — getCurrentUser (401) → hasPermission (403) → location scope.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    const { data, error } = await db
      .from('tapo_devices')
      .select('*')
      .eq('location_id', locationId)
      .order('enabled', { ascending: false })
      .order('name', { ascending: true })
      .limit(200)
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, devices: data || [] })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}
