// REPORT-ISSUE.2 — handler inbox at the active location.
//
//   GET → list issues at the caller's active location. Default
//         status filter is the open-work set (open + in_progress);
//         pass ?status=resolved or ?status=closed for the other
//         tabs. Multiple statuses can be joined with commas:
//         ?status=open,in_progress (default).
//
// Auth: owner OR master at the active location. Per the
// REPORT-ISSUE.1 design ("All owners at the studio").

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listInboxIssues, ISSUE_INBOX_OPEN_STATUSES } from '@/lib/issues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isHandler(user) {
  if (user?.role === 'master' || user?.profileRole === 'master' || user?.isMaster) return true
  return user?.role === 'owner'
}

const ALLOWED_STATUSES = ['open', 'in_progress', 'resolved', 'closed']

function parseStatuses(url) {
  const raw = new URL(url).searchParams.get('status')
  if (!raw) return ISSUE_INBOX_OPEN_STATUSES
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const clean = wanted.filter((s) => ALLOWED_STATUSES.includes(s))
  return clean.length > 0 ? clean : ISSUE_INBOX_OPEN_STATUSES
}

export const GET = withAuth(
  {},
  async ({ user, db, locationId, request }) => {
    if (!isHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only owner + master can read the issues inbox.' },
        { status: 403 }
      )
    }
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'Active location required.' },
        { status: 400 }
      )
    }
    const statuses = parseStatuses(request.url)
    const data = await listInboxIssues(db, locationId, { statuses })
    return NextResponse.json({ success: true, data })
  }
)
