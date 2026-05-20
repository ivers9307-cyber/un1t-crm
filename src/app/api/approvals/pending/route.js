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
//     }
//   }
//
// Scope is enforced inside each provider's fetchPending() — this
// route is just an orchestrator. Anyone authenticated can call;
// users with no approver authority get all-zero buckets back.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getPendingApprovals } from '@/lib/approvals/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  try {
    const data = await getPendingApprovals(db, user)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
