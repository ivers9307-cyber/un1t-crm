// GET /api/approvals/count — NAV-BADGE.1, the Approvals sidebar badge.
//
// HOME.3 deleted this route when it retired the eight per-item sidebar
// badges; MAIL-BADGE.1 then restored the Messages row, and this restores
// Approvals on the same narrow terms — one row, one poller, reading the
// number the /approvals page itself computes.
//
// It holds NO scoping logic. getPendingApprovalsCount fans out over the
// eleven providers, gating each with isProviderVisible — permission key +
// category-bundle (only three providers, invoices-queue/issues/host-events,
// layer their own isVisible() on top) — then scoping to the caller's
// CURRENT ACTIVE location for ten of the eleven (host_events is the one
// org-wide exception). So a head coach counts time off, shift swaps and
// hyrox sessions (plus agent requests, offer purchases); an owner
// additionally counts contractor invoices, FTE expenses and rosters;
// master counts everything — none of it restated here. Re-deriving the
// gate is how a badge starts disagreeing with the page it points at.
//
// permission: null, location: false — deliberately. The sidebar polls this
// for every authenticated session, so an ineligible session must get a
// cheap, quiet 0 rather than a 403. It is cheap because isProviderVisible
// runs BEFORE each provider's query.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    try {
      const count = await getPendingApprovalsCount(db, user)
      return NextResponse.json({ success: true, data: { count } })
    } catch (e) {
      console.error('[approvals/count] failed:', e.message)
      return NextResponse.json({
        success: false,
        error: 'Could not check the approvals count — try again.',
      }, { status: 500 })
    }
  }
)
