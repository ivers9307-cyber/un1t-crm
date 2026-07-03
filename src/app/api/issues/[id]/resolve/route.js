// REPORT-ISSUE.2 — resolve an issue. Resolution notes are
// mandatory (validated in the lib) so the submitter notification
// has something useful in it. Auto-pushes notify_issue_resolved
// to the submitter on success — best-effort, never blocks.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { resolveIssue, getInboxIssue } from '@/lib/issues'
import { logAuditEvent } from '@/lib/audit'
import { sendPushOnce } from '@/lib/push-dedup'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'

const ResolveBody = z.object({
  notes: z.string().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isHandler(user) {
  if (user?.role === 'master' || user?.profileRole === 'master' || user?.isMaster) return true
  return user?.role === 'owner'
}

export const POST = withAuth(
  {},
  async ({ user, db, locationId, params, request }) => {
    if (!isHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only owner + master can resolve issues.' },
        { status: 403 }
      )
    }
    const id = params?.id
    if (!id) {
      return NextResponse.json({ success: false, error: 'Issue id required.' }, { status: 400 })
    }

    // Existence + location scope check.
    const existing = await getInboxIssue(db, id)
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (user?.role !== 'master' && !user?.isMaster && locationId && existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const validation = await validateBody(request, ResolveBody, { allowEmpty: true })
    if (!validation.ok) return validation.response
    const body = validation.data

    const out = await resolveIssue(db, {
      issueId: id, profileId: user.id, notes: body?.notes,
    })
    if (!out.ok) {
      return NextResponse.json(
        { success: false, error: out.error, code: out.code },
        { status: out.status || 500 }
      )
    }

    await logAuditEvent({
      category: 'business',
      action: 'issue.resolved',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        id: existing.id,
        label: existing.description.slice(0, 80),
        resource: `issue/${existing.id}`,
      },
      locationId: existing.location_id,
      details: { notes_length: (out.data.resolution_notes || '').length },
      request,
    })

    // Notify the submitter their report is resolved. Best-effort —
    // a push delivery failure should not unwind the state change.
    if (existing.submitter_id && existing.submitter_id !== user.id) {
      const notes = (out.data.resolution_notes || '').slice(0, 180)
      sendPushOnce(db, `issue_resolved:${existing.id}`, existing.submitter_id, {
        title: 'Your report has been resolved',
        body: notes ? `${notes}` : 'A handler at the studio has marked your report resolved.',
        category: 'issue_resolved',
        data: { type: 'issue_resolved', issue_id: existing.id },
      }).catch((e) => logWarn('issues-resolve', 'push failed', { err: e?.message }))
    }

    return NextResponse.json({ success: true, data: out.data })
  }
)
