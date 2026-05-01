// POST /api/impersonate/stop
//
// Clears the un1t_impersonate cookie and stamps ended_at on the
// active log row. Anyone can call this — even if the cookie has
// drifted out of sync with the underlying session, we want it
// cleared. The audit log update only fires for the master_user_id
// matching the underlying session.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { stopImpersonation } from '@/lib/impersonation'

export const runtime = 'nodejs'

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // The "real" master id is on impersonatingFrom when active. If
  // we're not in an impersonation session, fall back to the user id —
  // the stop is then a no-op cookie-clear (defensive cleanup).
  const masterUserId = user.impersonatingFrom?.masterId || user.id
  await stopImpersonation({ masterUserId })
  return NextResponse.json({ success: true })
}
