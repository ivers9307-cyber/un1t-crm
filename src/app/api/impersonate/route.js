// POST /api/impersonate { target_user_id, reason? }
// POST /api/impersonate/stop  (separate route)
//
// Master-only. Starts an impersonation session — sets the
// un1t_impersonate cookie and writes an open row to
// impersonation_log. Subsequent requests through getCurrentUser()
// will return the target's profile/locations/permissions while the
// underlying auth session remains the master's.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { headers } from 'next/headers'
import { getCurrentUser } from '@/lib/auth'
import { startImpersonation } from '@/lib/impersonation'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

const Body = z.object({
  target_user_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // The REAL underlying session must be a master. When already
  // impersonating, the visible `user` is the target — but we know
  // the master's id via impersonatingFrom and trust that as the
  // signal. This lets a master cycle through users without first
  // hitting Stop (startImpersonation closes the prior log row
  // implicitly).
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

  // Sanity-check target exists + is active. RLS on profiles allows
  // master to read everyone via private.auth_is_master().
  const db = createServerClient()
  const { data: target, error: tErr } = await db
    .from('profiles')
    .select('id, full_name, role, active')
    .eq('id', parsed.data.target_user_id)
    .single()
  if (tErr || !target) {
    return NextResponse.json({ success: false, error: 'Target user not found.' }, { status: 404 })
  }

  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const userAgent = h.get('user-agent') || null

  try {
    const result = await startImpersonation({
      masterProfile: { id: realMasterId, role: 'master' },
      targetUserId: parsed.data.target_user_id,
      reason: parsed.data.reason || null,
      ip, userAgent,
    })

    // AUDIT-EXPAND.1 — impersonation start. Actor is the REAL
    // master (not the visible user, which is the target). The
    // reason is captured in details since it's typed at start
    // time but not surfaced anywhere else.
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
      },
      request,
    })

    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'Impersonation failed' }, { status: 500 })
  }
}
