// GET /api/support-session — recent tenant support sessions (audit).
//
// Master-only. Returns the most recent support_sessions rows (org + master
// name resolved) for the Platform Console audit panel. Read-only.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getRecentSupportSessions } from '@/lib/support-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The REAL underlying session must be a master (masters control their own
// cross-tenant audit trail), so an impersonating master passes too.
const isRealMaster = (user) => user.profileRole === 'master' || !!user.impersonatingFrom

export const GET = withAuth(
  { permission: null, location: false, allow: isRealMaster, forbiddenMessage: 'Master only' },
  async ({ db }) => {
    const sessions = await getRecentSupportSessions(db, 25)
    return NextResponse.json({ success: true, data: { sessions } })
  },
)
