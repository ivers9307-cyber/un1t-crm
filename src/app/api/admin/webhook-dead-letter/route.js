// GET /api/admin/webhook-dead-letter — list of captured webhook events that
// 200'd the provider but failed to process.
//
// WHO SEES WHAT (MAIL-DEADLETTER.1 review fix). Master sees every row. Anyone
// else sees ONLY rows at locations where they are OWNER — judged per location
// via hasRoleAtLocation (deadLetterOwnerLocationIds in ./_helpers.js), never
// `user.role`, which is the caller's ACTIVE-studio role and let any owner in
// any org read every org's payloads (for postmark_inbound: the full email
// body, headers and attachment metadata). The bound is applied IN THE QUERY
// (`.in('location_id', …)`), so foreign rows never leave the database; and
// because SQL's IN is never true for NULL, a row with no location_id is
// invisible to a non-master (master triages those; the replay/resolve detail
// routes still resolve a NULL inbound row to where its recipient routes today).
//
// Query params:
//   provider?   Filter to a specific provider ('glofox', 'inbody', 'postmark', …).
//   status?     Filter by status ('pending', 'resolved', 'failed', 'discarded').
//
// Returns up to 200 rows, newest first, each annotated with `replayable` —
// whether SOME replay path exists for the provider: the registry's automatic
// re-drivers (inbody, postmark ingest failures) OR the operator-only ones
// (postmark_inbound since MAIL-DEADLETTER.1 — it re-runs the inbound pipeline
// and must never be auto-replayed; see src/lib/webhook-replay.js). The UI
// offers Replay only where this says so rather than duplicating the lists
// client-side and drifting. postmark_queue / email_ticket_* stay
// DELIBERATELY unreplayable (an exhausted budget would reset; a sent email
// would double-send).
// Response: { success: true, data: [...rows] }
//
// Actions live on the sibling routes: [id]/replay (registry-gated) and
// [id]/resolve (the human acknowledge path, DEADLETTER-UI.1).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { isManuallyReplayable } from '@/lib/webhook-replay'
import { deadLetterOwnerLocationIds } from './_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_STATUSES = new Set(['pending', 'resolved', 'failed', 'discarded'])
const ROW_LIMIT = 200

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Master, or owner SOMEWHERE — judged per location, never by the active
  // role. A collection route, so 403 gives nothing away; the bound below
  // decides which rows that owner actually sees.
  const ownerLocationIds = deadLetterOwnerLocationIds(user)
  if (ownerLocationIds !== null && ownerLocationIds.length === 0) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const providerFilter = url.searchParams.get('provider') || null
  const statusFilter = url.searchParams.get('status') || null

  if (statusFilter && !VALID_STATUSES.has(statusFilter)) {
    return NextResponse.json({
      success: false,
      error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}`,
    }, { status: 400 })
  }

  const db = createServerClient()

  let query = db
    .from('webhook_dead_letter')
    .select('id, provider, event_type, payload, error, attempts, status, received_at, last_attempt_at, resolved_at, location_id')
    .order('received_at', { ascending: false })
    .limit(ROW_LIMIT)

  // Non-master: bound to the caller's owner locations (excludes NULL rows).
  if (ownerLocationIds !== null) query = query.in('location_id', ownerLocationIds)
  if (providerFilter) query = query.eq('provider', providerFilter)
  if (statusFilter) query = query.eq('status', statusFilter)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const rows = (data || []).map((r) => ({ ...r, replayable: isManuallyReplayable(r.provider) }))
  return NextResponse.json({ success: true, data: rows })
}
