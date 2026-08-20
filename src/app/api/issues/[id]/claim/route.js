// REPORT-ISSUE.2 — claim an open issue. Sets claimed_by/at +
// flips status to 'in_progress'. Concurrency-safe inside the lib.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { claimIssue, getInboxIssue } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'
import { isIssueHandler } from '@/lib/issues-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  {},
  async ({ user, db, locationId, params, request }) => {
    if (!isIssueHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only issue handlers can claim issues.' },
        { status: 403 }
      )
    }
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'Issue id required.' }, { status: 400 })
    }

    // Active-location scope check up front so 403 reasons stay clean.
    const existing = await getInboxIssue(db, id)
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (user?.role !== 'master' && !user?.isMaster && locationId && existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const out = await claimIssue(db, { issueId: id, profileId: user.id })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'business',
      action: 'issue.claimed',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        label: existing.description.slice(0, 80),
        resource: `issue/${existing.id}`,
      },
      locationId: existing.location_id,
      request,
    })

    return NextResponse.json({ success: true, data: out.data })
  }
)
