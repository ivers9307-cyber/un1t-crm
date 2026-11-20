// CHECKLIST.2 — mobile read endpoint for the coach's checklist
// today.
//
// Auth: Supabase JWT + active location header (same contract as
// /api/mobile/me).
//
// Returns: { success, data: { instances: [...] } }. Empty array
// when the coach isn't on shift today, has no template for their
// role at this location for this day, or both.
//
// The act of GETting this endpoint lazily generates the instance
// (if a shift + matching template exist) — there's no separate
// "create" call. Idempotent: a second GET on the same day returns
// the same row.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { resolveTodayInstances } from '@/lib/checklist-instances'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Signed in (the phone's Bearer token too) with an active studio; no
// permission key, as before.
export const GET = withAuth({ permission: null, location: true }, async ({ user, db }) => {
  const location = user.activeLocation
  const instances = await resolveTodayInstances(db, {
    profile: { id: user.id, role: user.role, location_role: user.role },
    location,
  })

  return NextResponse.json({
    success: true,
    data: { instances },
  })
})
