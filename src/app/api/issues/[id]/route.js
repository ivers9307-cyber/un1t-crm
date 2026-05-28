// REPORT-ISSUE.1 — drill-in for an issue the caller submitted.
//
// PR 1: read-only, scoped to your own submissions.
// PR 2: extends with handler actions (claim, resolve, close) and a
//       separate read path that also lets owners view issues at
//       their location.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getMyIssue } from '@/lib/issues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  {},
  async ({ user, db, params }) => {
    const issueId = params?.id
    if (!issueId) {
      return NextResponse.json(
        { success: false, error: 'Issue id required.' },
        { status: 400 }
      )
    }
    const row = await getMyIssue(db, { issueId, profileId: user.id })
    if (!row) {
      // 404 (not 403) so we don't leak existence of someone else's
      // issue to the caller. Distinguished from "you don't have the
      // perm" because the PR 1 surface is submitter-only by design.
      return NextResponse.json(
        { success: false, error: 'Issue not found.' },
        { status: 404 }
      )
    }
    return NextResponse.json({ success: true, data: row })
  }
)
