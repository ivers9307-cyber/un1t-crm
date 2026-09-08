// GET /api/approvals/count — NAV-BADGE.1, the Approvals sidebar badge.
//
// HOME.3 deleted this route when it retired the eight per-item sidebar
// badges; MAIL-BADGE.1 then restored the Messages row, and this restores
// Approvals on the same narrow terms — one row, one poller, reading the
// number the /approvals page itself computes.
//
// It holds NO scoping logic. getPendingApprovalsCount fans out over the
// eleven providers applying EACH provider's own isVisible + role scoping,
// so a head coach counts rosters and shift swaps at their locations, an
// owner counts contractor invoices and FTE expenses, and master counts
// everything — without a line of that being restated here. Re-deriving the
// gate is how a badge starts disagreeing with the page it points at.
//
// permission: null, location: false — deliberately. The sidebar polls this
// for every authenticated session (a client-side gate reads the ACTIVE
// location only, and approvals span locations), so an ineligible session
// must get a cheap, quiet 0 rather than a 403. It is cheap because each
// provider's isVisible runs BEFORE its query.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    const count = await getPendingApprovalsCount(db, user)
    return NextResponse.json({ success: true, data: { count } })
  }
)
