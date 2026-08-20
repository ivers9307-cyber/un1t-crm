// REPORT-ISSUE.2 — handler inbox at the active location.
//
//   GET → list issues at the caller's active location. Default
//         status filter is the open-work set (open + in_progress);
//         pass ?status=resolved or ?status=closed for the other
//         tabs. Multiple statuses can be joined with commas:
//         ?status=open,in_progress (default).
//
// Auth: isIssueHandler — owner OR master at the active location (the
// REPORT-ISSUE.1 design, "All owners at the studio"), OR the grantable
// `issues_inbox` permission (HUBDOOR.1). One definition, shared with the
// /issues page and every other handler route: src/lib/issues-access.js.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listInboxIssues, ISSUE_INBOX_OPEN_STATUSES } from '@/lib/issues'
import { isIssueHandler } from '@/lib/issues-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
    if (!isIssueHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only issue handlers can read the issues inbox.' },
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
