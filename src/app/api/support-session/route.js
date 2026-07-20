// GET /api/support-session — recent tenant support sessions (audit).
//
// Master-only. Returns the most recent support_sessions rows (org + master
// name resolved) for the Platform Console audit panel. Read-only.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getRecentSupportSessions } from '@/lib/support-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  // The REAL underlying session must be a master (masters control their
  // own cross-tenant audit trail).
  const isMaster = user.profileRole === 'master' || !!user.impersonatingFrom
  if (!isMaster) return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })

  const db = createServerClient()
  const sessions = await getRecentSupportSessions(db, 25)
  return NextResponse.json({ success: true, data: { sessions } })
}
