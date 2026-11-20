// GET /api/admin/glofox-push-events  (GLOFOX3.6)
//
// Lists glofox_push_events rows that need operator review — failures
// + needs_review where reviewed_at is null. Joined with the contact
// for "jump to contact" + display name/email.
//
// Powers the Review tab on /admin/glofox-import. Master-only.
//
// Uses the partial index from mig 143:
//   idx_glofox_push_events_needs_review
//     ON (created_at DESC)
//     WHERE status IN ('needs_review', 'failed') AND reviewed_at IS NULL
// so this query stays fast even as the audit table grows.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in; the master check (user.role) stays here
// with its own 403 text, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  if (user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
  const includeReviewed = url.searchParams.get('include_reviewed') === 'true'

  let query = db
    .from('glofox_push_events')
    .select(`
      id, contact_id, location_id, source, status, glofox_member_id,
      glofox_response, error_message, created_at,
      reviewed_at, reviewed_by,
      contacts:contact_id ( id, name, email, first_name, last_name, location_id, glofox_member_id )
    `)
    .in('status', ['needs_review', 'failed'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (!includeReviewed) query = query.is('reviewed_at', null)

  const { data, error } = await query
  if (error) {
    logError('glofox-push', 'review list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the push events.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    events: data || [],
    count: (data || []).length,
  })
})
