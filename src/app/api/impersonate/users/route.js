// GET /api/impersonate/users
//
// Master-only. Returns the searchable list of users the master can
// impersonate (everyone, including other masters, including
// inactive — masters control their own audit trail and may need to
// see what an inactive user could see at the time their account
// was active).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Use the REAL master id — if a session is currently impersonating,
  // we still want to show the picker for the underlying master.
  const realMasterId = user.impersonatingFrom?.masterId || user.id
  if (user.role !== 'master' && !user.impersonatingFrom) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('profiles')
    .select('id, full_name, email, role, active, profile_locations(locations(id, name))')
    .order('full_name')
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Exclude the master themselves from the picker.
  const filtered = (data || []).filter(p => p.id !== realMasterId)
  return NextResponse.json({
    success: true,
    users: filtered.map(p => ({
      id: p.id,
      full_name: p.full_name,
      email: p.email,
      role: p.role,
      active: p.active,
      locations: (p.profile_locations || [])
        .map(pl => pl.locations?.name)
        .filter(Boolean),
    })),
  })
}
