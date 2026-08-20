// REPORT-ISSUE.2 — handler drill-in for a single issue.
//
// Distinct from /api/issues/[id] (PR 1) which is submitter-only
// (returns 404 if the caller isn't the submitter). This route
// returns the full inbox shape — submitter name, claimant,
// resolver, location — to issue handlers at the issue's location:
// owner + master by role, or anyone holding `issues_inbox` (HUBDOOR.1,
// src/lib/issues-access.js).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getInboxIssue } from '@/lib/issues'
import { isIssueHandler } from '@/lib/issues-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  {},
  async ({ user, db, locationId, params }) => {
    if (!isIssueHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only issue handlers can read the issues inbox.' },
        { status: 403 }
      )
    }
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'Issue id required.' }, { status: 400 })
    }
    const row = await getInboxIssue(db, id)
    if (!row) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    // Active-location scope: non-master can only view issues at the
    // location they're currently operating in. Master sees all.
    if (user?.role !== 'master' && !user?.isMaster && locationId && row.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: row })
  }
)
