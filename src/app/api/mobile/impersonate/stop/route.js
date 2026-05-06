// POST /api/mobile/impersonate/stop
//
// Mobile-only sibling of /api/impersonate/stop. Stamps ended_at on the
// active log row keyed off the real master id. The mobile client clears
// its locally-stored target id separately (SecureStore) — we don't
// touch any cookies here.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // Real master id — when impersonating, the visible user is the
  // target, but impersonatingFrom carries the master id we audit
  // against. If neither is set this is a no-op.
  const masterUserId = user.impersonatingFrom?.masterId
    || (user.role === 'master' ? user.id : null)

  if (masterUserId) {
    const db = createServerClient()
    await db
      .from('impersonation_log')
      .update({ ended_at: new Date().toISOString() })
      .eq('master_user_id', masterUserId)
      .is('ended_at', null)
  }

  return NextResponse.json({ success: true })
}
