// POST /api/hosts/impersonate/exit — end the caller's view-as-host session.
// The admin's staff session is untouched (the host cookie is additive), so
// getCurrentUser still resolves them. (HOST-PORTAL.4)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { stopHostImpersonation } from '@/lib/host-impersonation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  await stopHostImpersonation({ adminUserId: user.id })
  return NextResponse.json({ success: true })
}
