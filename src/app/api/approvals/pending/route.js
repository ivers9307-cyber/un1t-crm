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
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { getPendingApprovals } from '@/lib/approvals/registry'
import { getPendingApprovalsAllStudios, listEligibleStudios } from '@/lib/approvals/all-studios'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in (anyone signed in; each provider scopes).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
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
    logError('approvals', 'pending list failed', { err: e })
    return NextResponse.json({ success: false, error: 'fetch_failed' }, { status: 500 })
  }
})
