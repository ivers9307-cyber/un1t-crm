// POST /api/mobile/impersonate/stop
//
// Mobile-only sibling of /api/impersonate/stop. Stamps ended_at on the
// active log row keyed off the real master id. The mobile client clears
// its locally-stored target id separately (SecureStore) — we don't
// touch any cookies here.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

// withAuth only signs the caller in (the phone's Bearer session, as before);
// who the real master is, and whether anything is stamped, is decided here.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  // Real master id — when impersonating, the visible user is the
  // target, but impersonatingFrom carries the master id we audit
  // against. If neither is set this is a no-op.
  const masterUserId = user.impersonatingFrom?.masterId
    || (user.role === 'master' ? user.id : null)
  const wasImpersonating = !!user.impersonatingFrom
  const targetIdAtStop = wasImpersonating ? user.id : null

  if (masterUserId) {
    await db
      .from('impersonation_log')
      .update({ ended_at: new Date().toISOString() })
      .eq('master_user_id', masterUserId)
      .is('ended_at', null)
  }

  // AUDIT-EXPAND.1 — only emit when a session was actually active.
  if (wasImpersonating) {
    await logAuditEvent({
      category: 'auth',
      action: 'auth.impersonate_stop',
      actor: { id: masterUserId },
      target: targetIdAtStop ? {
        id: targetIdAtStop,
        resource: `profiles/${targetIdAtStop}`,
      } : null,
      details: { surface: 'mobile' },
      request,
    })
  }

  return NextResponse.json({ success: true })
})
