// GET /api/locations/[id]/ac-devices
//
// Lightweight helper for the StaffForm AC allowlist picker. Returns
// the enabled ac_devices rows at a given location so the master can
// tick which ones a staff member should be able to control.
//
// Master-only. The studio_management AC routes already filter their
// device list by the caller's per-staff allowlist; THIS route is
// distinct because masters editing staff for a non-active location
// need to see every device at that location regardless of their
// own active context.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only.' }, { status: 403 })
  }

  // Next.js 15+ delivers `params` as a Promise — the existing
  // /api/locations/[id]/unifi-doors route awaits it the same way.
  // Reading `params.id` synchronously returns undefined and short-
  // circuits to the 400 below, which is what was happening before
  // this fix.
  const { id: locationId } = await params
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'Location id required.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('ac_devices')
    .select('id, label, provider')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('label', { ascending: true })

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, devices: data || [] })
}
