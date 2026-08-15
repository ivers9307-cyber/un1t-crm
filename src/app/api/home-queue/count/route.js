// GET /api/home-queue/count — HOME.3, the needs-attention badge.
//
// Cheap sum of the same three TRUE counts assembleHomeQueue reports
// (getPendingApprovalsCount + the tickets needs-reply count query + the
// WA/IG needsAction count) via getHomeQueueCount (src/lib/home-queue.js) —
// no approval items, ticket subjects or conversation contacts are ever
// fetched. Every per-source gate mirrors the equivalent count route exactly
// (see src/lib/home-queue.js's header); a session ineligible for a source
// answers 0 for it, same posture as /api/whatsapp/unread-count, so a 60s
// poll is harmless for any user. HOME.3's sidebar retirement task made
// this the ONE poller Sidebar.jsx calls now — the per-source badge routes
// it used to poll separately (/api/approvals/count, /api/issues/count,
// /api/churn-radar/count, /api/lead-radar/count, /api/hosts/pending-
// events/count) are deleted; this endpoint's count is what the sidebar
// and the /dashboard/today queue header agree on.
//
// EMAIL-TICKET-CLEANUP.2 — the ONE exception to "always 200 with a number":
// getHomeQueueCount REJECTS rather than resolving when the tickets
// mailbox-visibility lookup itself fails, because this endpoint has no
// per-source field the way GET /api/home-queue's `degraded` array does —
// a bare `count` here can't tell an operator "this excludes tickets,
// which we couldn't check" from a genuine "nothing to do". Answering 500
// mirrors /api/email/tickets/count's own posture on the identical
// failure: the title-bar poller (usePolledCount) ignores a non-ok
// response and keeps its last good number, so a blip reads as a slightly
// stale count instead of a confidently wrong "all clear".

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getHomeQueueCount } from '@/lib/home-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    try {
      const count = await getHomeQueueCount(db, user)
      return NextResponse.json({ success: true, data: { count } })
    } catch (e) {
      console.error('[home-queue/count] failed:', e.message)
      return NextResponse.json({
        success: false,
        error: 'Could not check the needs-attention count — try again.',
      }, { status: 500 })
    }
  }
)
