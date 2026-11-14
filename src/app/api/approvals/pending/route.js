// APPROVALS.1 — /api/approvals/pending
//
// Returns the full grouped payload the /approvals page renders.
// Shape:
//   {
//     success: true,
//     data: {
//       providers: [
//         { key, label, reviewBase, count, items: ApprovalItem[] },
//         …
//       ],
//       total: number,
//       studios: [{ id, name }],   // APPROVALSQ.6 — studios the person could open
//     }                            // /approvals at, so the page knows whether
//   }                              // to offer "All my studios"
//
// APPROVALSQ.6 — `?scope=all` returns the union of the per-studio lists
// (src/lib/approvals/all-studios.js). Any other `scope` value is ignored.
//
// Scope is enforced inside each provider's fetchPending() — this
// route is just an orchestrator. Anyone authenticated can call;
// users with no approver authority get all-zero buckets back.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getPendingApprovals } from '@/lib/approvals/registry'
import { getPendingApprovalsAllStudios, listEligibleStudios } from '@/lib/approvals/all-studios'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  try {
    if (new URL(request.url).searchParams.get('scope') === 'all') {
      const data = await getPendingApprovalsAllStudios(db, user)
      return NextResponse.json({ success: true, data })
    }
    const data = await getPendingApprovals(db, user)
    // The switch's gate. Never let it cost the default list.
    let studios = []
    try {
      studios = listEligibleStudios(user).studios
    } catch (e) {
      console.warn(`[approvals] studio list failed: ${e.message || e}`)
    }
    return NextResponse.json({ success: true, data: { ...data, studios } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
