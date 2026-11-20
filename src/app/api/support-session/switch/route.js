// POST /api/support-session/switch { mode }
//
// Switches the master's currently-open support session between read_only
// and act_on_behalf. Allowlisted in the proxy's SUPPORT_CONTROL_PATHS so
// the upgrade (read_only → act_on_behalf) is reachable while read-only.
// Master-only. Closes the current audited span and opens a fresh one with
// the new mode (each mode is its own bounded audit span).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { switchSupportMode } from '@/lib/support-session'
import { logAuditEvent } from '@/lib/audit'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ mode: z.enum(['read_only', 'act_on_behalf']) })

// withAuth only signs the caller in; the real-master check, the body and the
// switch run here in their old order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, request }) => {
  const realMasterId = user.impersonatingFrom?.masterId || (user.profileRole === 'master' ? user.id : null)
  if (!realMasterId) {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { mode } = validation.data

  const result = await switchSupportMode({ masterUserId: realMasterId, mode })
  if (!result.ok) {
    const status = result.error === 'no_active_support_session' ? 404 : 400
    // A failed insert carries the database's text; answer its fixed code.
    const known = ['no_active_support_session', 'invalid_mode'].includes(result.error)
    if (!known) logError('support-session', 'switch failed', { masterUserId: realMasterId, err: result.error })
    return NextResponse.json({ success: false, error: known ? result.error : 'insert_failed' }, { status })
  }

  await logAuditEvent({
    category: 'auth',
    action: 'auth.support_session_switch',
    actor: { id: realMasterId },
    target: result.organizationId ? { resource: `organizations/${result.organizationId}` } : null,
    details: { mode },
    request,
  })

  return NextResponse.json({ success: true, data: { mode } })
})
