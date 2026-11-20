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
import { withAuth } from '@/lib/with-auth'
import { stopSupportSession } from '@/lib/support-session'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in (401 as before) — no role, no studio, so a
// master inside a read-only session can always leave. Everything after it is
// the hand-written body, unchanged: stop, cookie clear, then the audit row.
export const POST = withAuth({ permission: null, location: false }, async ({ user, request }) => {

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
})
