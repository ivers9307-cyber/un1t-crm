// GET /api/lead-radar/classpass
//
// LEAD-CLASSPASS.1 — the read-only ClassPass surface. ClassPass
// drop-ins (classpass_payg) rarely convert to a direct membership, so
// they sit outside the funnel and the cleanup list. This endpoint
// backs an awareness-only tab on the Lead Radar: a list, no triage.
//
//   GET — list ClassPass non-members. Optional ?filter= (attending |
//         lapsed) splits active from lapsed ClassPass users; the
//         response is capped — see LIST_CAP — with the full filtered
//         total.
//
// There is no POST: ClassPass is not a triage surface.
//
// Access: lead_radar permission (owner + head_coach by default).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadClassPass } from '@/lib/lead-radar-data'
import { radarCache } from '@/lib/radar-cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The ClassPass base is large (~1,500). Cap the list payload; the
// operator narrows with the attending / lapsed filter.
const LIST_CAP = 500

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'lead_radar')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const filter = new URL(request.url).searchParams.get('filter')
  const db = createServerClient()
  try {
    const { classpass, summary } = await radarCache(
      'lead', locationId, 'classpass',
      () => loadClassPass(db, locationId),
    )
    const filtered =
      filter === 'attending' ? classpass.filter((r) => r.attending)
      : filter === 'lapsed'  ? classpass.filter((r) => !r.attending)
      : classpass
    return NextResponse.json({
      success: true,
      data: { items: filtered.slice(0, LIST_CAP), total: filtered.length, summary },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
