// POST /api/support-session/start { organization_id, mode, reason? }
//
// Master-only. Opens a tenant support session against an ORGANIZATION in
// one of two modes (read_only | act_on_behalf), REUSING the impersonation
// mechanism for the tenant-eye identity/scope-swap. Returns the landing
// URL (/portfolio, scoped to the org). The read-only ENFORCEMENT lives in
// src/proxy.js — this route only establishes the state.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { headers } from 'next/headers'
import { getCurrentUser } from '@/lib/auth'
import { startSupportSession } from '@/lib/support-session'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  organization_id: uuidLike,
  mode: z.enum(['read_only', 'act_on_behalf']),
  reason: z.string().max(500).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // The REAL underlying session must be a master. When already in a
  // support session (impersonating an owner) the visible `user` is the
  // owner — trust impersonatingFrom.masterId. This lets a master switch
  // tenants without exiting first (startSupportSession closes the prior
  // open row + impersonation implicitly).
  const realMasterId = user.impersonatingFrom?.masterId || (user.profileRole === 'master' ? user.id : null)
  if (!realMasterId) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { organization_id, mode, reason } = validation.data

  const h = await headers()
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const userAgent = h.get('user-agent') || null

  try {
    const result = await startSupportSession({
      masterProfile: { id: realMasterId, role: 'master' },
      organizationId: organization_id,
      mode,
      reason: reason || null,
      ip,
      userAgent,
    })

    await logAuditEvent({
      category: 'auth',
      action: 'auth.support_session_start',
      actor: { id: realMasterId },
      target: {
        label: result.organizationName,
        resource: `organizations/${organization_id}`,
      },
      details: {
        mode,
        reason: reason || null,
        impersonated_user_id: result.impersonatedUserId,
        support_session_id: result.sessionId,
      },
      request,
    })

    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'Failed to start support session' }, { status: 500 })
  }
}
