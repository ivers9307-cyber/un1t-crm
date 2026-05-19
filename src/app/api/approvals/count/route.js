// APPROVALS.1 — /api/approvals/count
//
// Lightweight endpoint for the sidebar badge polling. Fans out
// across every registered provider via countPending() (which uses
// HEAD COUNT exact requests) and sums. Cheaper than /pending
// because no row materialisation happens.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  try {
    const count = await getPendingApprovalsCount(db, user)
    return NextResponse.json({ success: true, data: { count } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'count_failed' }, { status: 500 })
  }
}
