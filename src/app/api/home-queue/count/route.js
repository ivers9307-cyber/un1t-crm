// GET /api/home-queue/count — HOME.3, the needs-attention badge.
//
// Cheap sum of the same three TRUE counts assembleHomeQueue reports
// (getPendingApprovalsCount + the tickets needs-reply count query + the
// WA/IG needsAction count) via getHomeQueueCounts (src/lib/home-queue.js) —
// no approval items, ticket subjects or conversation contacts are ever
// fetched. Every per-source gate mirrors the equivalent count route exactly
// (see src/lib/home-queue.js's header); a session ineligible for a source
// answers 0 for it, same posture as /api/whatsapp/unread-count, so a 60s
// poll is harmless for any user. HOME.3's sidebar retirement task made
// this the ONE poller Sidebar.jsx called at the time. NAV-BADGE.1 later
// restored /api/approvals/count as Approvals' own poller, and the sidebar
// no longer polls THIS endpoint at all — the other four per-source badge
// routes it used to poll separately (/api/issues/count,
// /api/churn-radar/count, /api/lead-radar/count,
// /api/hosts/pending-events/count) are still deleted.
//
// WIDGET.1 — the What Needs Me widget reads this. Its token carries the
// studio, which withAuth installs as the request's active location, so the
// widget for Hatch cannot read Stillorgan's numbers. That is why the gate
// moved from `location: false` to `location: true` — `allowWidgetToken`
// requires it (a widget token carries exactly one location; a
// location-free route is estate-wide by definition and must never accept
// one). This route once had no in-app caller left at all; the widget is
// now its only consumer, and it reports the per-source breakdown
// (getHomeQueueCounts) instead of a bare sum.
//
// EMAIL-TICKET-CLEANUP.2 — the ONE exception to "always 200 with a number":
// getHomeQueueCounts REJECTS rather than resolving when the tickets
// mailbox-visibility lookup itself fails, because a failed lookup can't be
// folded into the sum as a confident 0 the way a genuine source failure
// is — that would tell an operator "this excludes tickets, which we
// couldn't check" apart from a genuine "nothing to do". Answering 500
// mirrors /api/email/tickets/count's own posture on the identical
// failure: any usePolledCount reader ignores a non-ok response and
// keeps its last good number, so a blip would read as a slightly
// stale count instead of a confidently wrong "all clear".

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getHomeQueueCounts } from '@/lib/home-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: true, allowWidgetToken: true },
  async ({ user, db }) => {
    try {
      const { count, bySource, degraded } = await getHomeQueueCounts(db, user)
      return NextResponse.json({ success: true, data: { count, bySource, degraded } })
    } catch (e) {
      console.error('[home-queue/count] failed:', e.message)
      return NextResponse.json({
        success: false,
        error: 'Could not check the needs-attention count — try again.',
      }, { status: 500 })
    }
  }
)
