// /api/schedule/rosters/[id]/reject — ROSTER-FIX.4.
//
// The other half of the approvals queue. An owner could approve a draft
// roster but never turn one down: the only way out was to leave it in the
// queue forever, so the queue stopped meaning "waiting on you".
//
// D5 — rejecting DELETES the draft row. Publishing is what tags blocks with
// a roster id, so a draft references nothing and nothing references it;
// there is no orphan to clean up, no new status to teach every reader, and
// no migration. The manager re-publishes a trimmed period to try again.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { notifyUsersOnce } from '@/lib/push-dedup'
import { logWarn } from '@/lib/log'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'

const RejectSchema = z.object({
  // Why it was turned down, shown to the manager who submitted it.
  note: z.string().max(2000).nullable().optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // An empty POST is valid — the note is optional and the browser sends no
  // body when the operator skips the prompt.
  const validation = await validateBody(request, RejectSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const note = validation.data.note || null

  const db = createServerClient()

  const { data: roster, error: fetchErr } = await db
    .from('rosters')
    .select('id, location_id, status, period_start, period_end, created_by')
    .eq('id', params.id)
    .maybeSingle()
  if (fetchErr) {
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 400 })
  }
  if (!roster) {
    return NextResponse.json({ success: false, error: 'Roster not found' }, { status: 404 })
  }

  // ROSTER-FIX.4 — permission BEFORE the status branch (approve checks it
  // after). A caller with no rosters permission at this location gets the
  // same 403 whatever state the roster is in, so the endpoint can't be used
  // to probe which ids exist as drafts.
  if (!hasPermissionForLocation(user, roster.location_id, APPROVAL_CATEGORY_PERMISSION.rosters)) {
    return NextResponse.json({ success: false, error: 'You do not have permission to reject rosters.' }, { status: 403 })
  }

  if (roster.status !== 'draft') {
    return NextResponse.json({
      success: false,
      error: `Roster is already ${roster.status}; only draft rosters can be rejected.`,
    }, { status: 409 })
  }

  const { error: delErr } = await db
    .from('rosters')
    .delete()
    .eq('id', params.id)
  if (delErr) {
    return NextResponse.json({ success: false, error: delErr.message }, { status: 400 })
  }

  // Tell the manager who submitted it. Best-effort: the rejection already
  // happened, so a push/email hiccup must not report it as a failure.
  if (roster.created_by) {
    const range = roster.period_start === roster.period_end
      ? roster.period_start
      : `${roster.period_start} – ${roster.period_end}`
    try {
      await notifyUsersOnce(db, `roster_rejected:${roster.id}`, [roster.created_by], {
        title: 'Roster not approved',
        body: `Your roster for ${range} was not approved${note ? ` — “${note}”` : ''}. Adjust it and publish again.`,
        category: 'schedule',
        emailSubject: 'Roster not approved',
        data: {
          type: 'roster_rejected',
          roster_id: roster.id,
          location_id: roster.location_id,
          start_date: roster.period_start,
          end_date: roster.period_end,
        },
      })
    } catch (e) {
      logWarn('rosters/reject', 'submitter notify failed', { err: e?.message })
    }
  }

  return NextResponse.json({ success: true, data: { id: roster.id, rejected: true } })
}
