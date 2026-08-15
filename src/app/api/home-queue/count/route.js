// GET /api/home-queue/count — HOME.3, the needs-attention badge.
//
// Cheap sum of the same three TRUE counts assembleHomeQueue reports
// (getPendingApprovalsCount + the tickets needs-reply count query + the
// WA/IG needsAction count) via getHomeQueueCount (src/lib/home-queue.js) —
// no approval items, ticket subjects or conversation contacts are ever
// fetched. Every per-source gate mirrors the equivalent count route exactly
// (see src/lib/home-queue.js's header); a session ineligible for a source
// answers 0 for it, same as /api/approvals/count, /api/issues/count and
// /api/whatsapp/unread-count all do, so a 60s poll is harmless for any user.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getHomeQueueCount } from '@/lib/home-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    const count = await getHomeQueueCount(db, user)
    return NextResponse.json({ success: true, data: { count } })
  }
)
