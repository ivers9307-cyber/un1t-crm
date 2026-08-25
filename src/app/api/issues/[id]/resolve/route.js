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
import { getEquipment, updateEquipment } from '@/lib/equipment-db'
import { shouldReturnToService, EQUIPMENT_STATUS } from '@/lib/equipment'
import { isIssueHandler } from '@/lib/issues-access'
import { hasPermission } from '@/lib/permissions'

const ResolveBody = z.object({
  notes: z.string().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  {},
  async ({ user, db, locationId, params, request }) => {
    if (!isIssueHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only issue handlers can resolve issues.' },
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
        label: existing.description.slice(0, 80),
        resource: `issue/${existing.id}`,
      },
      locationId: existing.location_id,
      details: { notes_length: (out.data.resolution_notes || '').length },
      request,
    })

    // EQUIP-MAINT.2 — an equipment fault resolving puts the asset back on
    // the floor. shouldReturnToService demands an exact issue-id match, so
    // kit taken off manually (no linked issue) stays off, and resolving an
    // unrelated issue on the same asset does nothing. Best-effort: a
    // failure here must not fail the resolve the operator just performed.
    //
    // HUBDOOR.2 — `equipment_admin` guards the SIDE EFFECT, not the
    // resolve. Returning an asset to service is the equipment register's
    // mutation: the direct route for it,
    // PATCH /api/equipment/[id], is withAuth({ permission:
    // 'equipment_admin' }). Before HUBDOOR.1 the two gates coincided by
    // accident — only owner/master reached this route and both hold
    // equipment_admin by default — so widening the resolve gate to honour
    // `issues_inbox` silently handed a granted head_coach or manager
    // (equipment_admin: false by default for both, and one such grant is
    // live at Stillorgan today) a way to put a machine back on the floor
    // that PATCH /api/equipment/[id] would refuse them. That is a gate
    // crossing the widening never argued for, so it is closed here rather
    // than inherited: they still resolve the issue and still notify the
    // submitter, and the asset stays off the floor until someone who owns
    // the register clears it on /maintenance. Behaviour is unchanged for
    // every actor who could reach this route before.
    if (existing.equipment_id && hasPermission(user, 'equipment_admin')) {
      try {
        const asset = await getEquipment(db, existing.equipment_id)
        if (shouldReturnToService(asset, existing.id)) {
          await updateEquipment(db, asset.id, {
            status: EQUIPMENT_STATUS.IN_SERVICE,
            out_of_service_issue_id: null,
          })
        }
      } catch (err) {
        logWarn('equipment', 'return-to-service failed', {
          issueId: existing.id, equipmentId: existing.equipment_id, error: err.message,
        })
      }
    }

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
