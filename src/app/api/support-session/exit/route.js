// POST /api/support-session/exit
//
// Ends the caller's tenant support session: stops any impersonation,
// clears both cookies, and stamps ended_at on the open support_sessions
// row. Allowlisted in the proxy's SUPPORT_CONTROL_PATHS so it is reachable
// even inside a read-only session (a master must always be able to leave).
//
// Anyone can call this — like /api/impersonate/stop, we always want the
// session cleared even if the cookie has drifted out of sync. The audit
// update only fires for the master_user_id behind the session.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { stopSupportSession } from '@/lib/support-session'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // The REAL master id is on impersonatingFrom while a support session is
  // active (the master is impersonating the tenant owner); fall back to
  // the user id for the scope-only path or a defensive cookie-clear.
  const masterUserId = user.impersonatingFrom?.masterId || user.id
  const result = await stopSupportSession({ masterUserId })

  if (result.closed) {
    await logAuditEvent({
      category: 'auth',
      action: 'auth.support_session_stop',
      actor: { id: masterUserId },
      target: result.organizationId
        ? { resource: `organizations/${result.organizationId}` }
        : null,
      request,
    })
  }

  return NextResponse.json({ success: true })
}
