// POST /api/mobile/impersonate { target_user_id, reason? }
//
// Mobile-only sibling of /api/impersonate. Same audit semantics — writes
// a row to impersonation_log keyed off the real master id and closes any
// previously-open row for that master — but does NOT set a cookie. The
// mobile app stores the target_user_id locally (SecureStore) and sends
// it on every request via the x-impersonate-target header. getCurrentUser
// reads either the cookie or the header to swap profiles.
//
// Auth: Supabase JWT (Bearer). Master-gated; nested impersonations are
// rejected (mobile UI doesn't have a use-case for chained switching and
// it makes the audit trail clearer).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { headers } from 'next/headers'
import { withAuth } from '@/lib/with-auth'
import { logAuditEvent } from '@/lib/audit'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

const Body = z.object({
  target_user_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
})

// withAuth only signs the caller in (its 401 'Unauthorized'; was 'Unauthorised').
// The real-master check (including the already-impersonating case), the body,
// the self check and the target read run by hand below, in their old order;
// the log rows and the audit event are unchanged.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {

  // Real master id — falls back to user.id when not currently
  // impersonating, and to impersonatingFrom.masterId when the caller
  // is currently in an impersonation session (re-targeting).
  const realMasterId = user.impersonatingFrom?.masterId || (user.role === 'master' ? user.id : null)
  if (!realMasterId) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  if (parsed.data.target_user_id === realMasterId) {
    return NextResponse.json({ success: false, error: 'Cannot impersonate yourself.' }, { status: 400 })
  }

  const { data: target, error: tErr } = await db
    .from('profiles')
    .select('id, full_name, role, active')
    .eq('id', parsed.data.target_user_id)
    .single()
  if (tErr || !target) {
    return NextResponse.json({ success: false, error: 'Target user not found.' }, { status: 404 })
  }

  // Close any currently-active row for this master so there's never
  // more than one open at a time. (Same invariant as the cookie path.)
  await db
    .from('impersonation_log')
    .update({ ended_at: new Date().toISOString() })
    .eq('master_user_id', realMasterId)
    .is('ended_at', null)

  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const userAgent = h.get('user-agent') || null

  const { error: insErr } = await db.from('impersonation_log').insert({
    master_user_id: realMasterId,
    target_user_id: parsed.data.target_user_id,
    ip,
    user_agent: userAgent,
    reason: parsed.data.reason || null,
  })
  if (insErr) {
    logError('mobile-impersonate', 'impersonation log insert failed', { masterId: realMasterId, err: insErr })
    return NextResponse.json({ success: false, error: 'Impersonation failed' }, { status: 500 })
  }

  // AUDIT-EXPAND.1 — mirror the cookie-path event so mobile-initiated
  // impersonation shows up in /admin/audit-log alongside web events.
  await logAuditEvent({
    category: 'auth',
    action: 'auth.impersonate_start',
    actor: { id: realMasterId },
    target: {
      id: target.id,
      label: target.full_name,
      resource: `profiles/${target.id}`,
    },
    details: {
      reason: parsed.data.reason || null,
      target_role: target.role,
      surface: 'mobile',
    },
    request,
  })

  return NextResponse.json({
    success: true,
    targetUserId: target.id,
    targetName: target.full_name,
    targetRole: target.role,
  })
})
