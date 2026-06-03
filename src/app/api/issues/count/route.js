// GET /api/issues/count
//
// REPORT-ISSUE.2 / SIDEBAR-BADGES.1 — sidebar badge count: open +
// in_progress staff-reported issues at the active location. Follows the
// { success, data: { count } } envelope the Sidebar's usePolledCount
// expects. Returns count 0 for users without the issues_inbox permission
// (or no active location) rather than erroring, so the 60s poll is
// harmless if it somehow runs for an ineligible user.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { countInboxIssues } from '@/lib/issues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'issues_inbox')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  try {
    const count = await countInboxIssues(db, locationId)
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
