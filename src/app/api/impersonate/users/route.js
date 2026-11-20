// GET /api/impersonate/users
//
// Master-only. Returns the searchable list of users the master can
// impersonate (everyone, including other masters, including
// inactive — masters control their own audit trail and may need to
// see what an inactive user could see at the time their account
// was active).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { excludeTombstones } from '@/lib/staff-tombstone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; the master-or-viewing-as check stays here,
// first, as before (a master viewing as someone keeps the picker).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  // Use the REAL master id — if a session is currently impersonating,
  // we still want to show the picker for the underlying master.
  const realMasterId = user.impersonatingFrom?.masterId || user.id
  if (user.role !== 'master' && !user.impersonatingFrom) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const { data, error } = await excludeTombstones(db.from('profiles')
    .select('id, full_name, email, role, active, profile_locations(locations(id, name))'))
    .order('full_name')
  if (error) {
    logError('impersonate', 'user list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the people list.' }, { status: 500 })
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
})
