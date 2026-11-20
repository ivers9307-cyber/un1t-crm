// GET /api/mobile/impersonate/users?q=
//
// Mobile-only sibling of /api/impersonate/users. Master-gated, returns
// the searchable picker list. Same shape as the web route but supports
// optional ?q= server-side filtering so the picker on a phone doesn't
// need to download the full set on every keystroke.
//
// We DELIBERATELY don't surface email when q is empty, because the
// initial render shows up to ~50 users and we'd rather show full names
// + role chips. The detail row in the picker pulls email lazily.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { excludeTombstones } from '@/lib/staff-tombstone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sign-in only: the real-master check below keeps its old answer, and keeps
// working while impersonating. A signed-out call answers withAuth's 401
// 'Unauthorized' (was 'Unauthorised').
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  // Allow the route while impersonating — picker continues to operate
  // for the underlying master so they can re-target without stop.
  const realMasterId = user.impersonatingFrom?.masterId
    || (user.role === 'master' ? user.id : null)
  if (!realMasterId) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const q = (url.searchParams.get('q') || '').trim().toLowerCase()

  let query = excludeTombstones(db.from('profiles')
    .select('id, full_name, email, role, active, profile_locations(locations(id, name))'))
    .order('full_name')
    .limit(50)

  if (q) {
    // Postgres ilike — name OR email contains the query.
    query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
  }

  const { data, error } = await query
  if (error) {
    logError('impersonate', 'picker list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the people list. Try again.' }, { status: 500 })
  }

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
