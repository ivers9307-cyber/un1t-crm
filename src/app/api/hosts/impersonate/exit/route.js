// POST /api/hosts/impersonate/exit — end the caller's view-as-host session.
// The admin's staff session is untouched (the host cookie is additive), so
// getCurrentUser still resolves them. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { stopHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Any signed-in staff session may close its OWN view-as-host session (the log
// rows are keyed on the caller's id), as before: no role, no studio.
export const POST = withAuth({ permission: null, location: false }, async ({ user }) => {
  await stopHostImpersonation({ adminUserId: user.id })
  return NextResponse.json({ success: true })
})
