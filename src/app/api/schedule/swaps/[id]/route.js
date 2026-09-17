// src/app/api/schedule/swaps/[id]/route.js
import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { swapStatusSchema } from '@/lib/schemas'
import { resolveSwapTransition } from '@/lib/swap-lifecycle'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { MANAGER_ROLES } from '@/lib/schemas'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { logRosterChange, markChangesNotified } from '@/lib/roster-change-log'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

const SwapReviewSchema = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/swaps/:id — drive a swap through its lifecycle.
// Coaches: claim / accept / decline / withdraw / cancel-own.
// Managers: approve / reject (finalises on shift_assignments).
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapReviewSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Fetch the swap. requester_shift_id / target_shift_id are shift_assignments.id.
  // Only profile_id is read off the embeds for the reciprocal-swap reassign;
  // the nested block embed carries block_date for the decision push (mobile
  // week-preselects the schedule tab on it).
  // ROSTER-FIX.1 (D4) — the block embed also carries id / location_id and the
  // roster status because an approved DROP has to write its roster_change_log
  // row from THIS in-memory copy: the assignment is deleted, so the embed
  // cannot be re-read afterwards (and since mig 603 the swap row survives with
  // requester_shift_id NULL, which is just as unreadable for these fields).
  const { data: swap } = await db.from('shift_swap_requests')
    .select('*, requester_shift:shift_assignments!requester_shift_id(id, profile_id, block_id, block:shift_blocks!block_id(id, location_id, block_date, rosters:roster_id(status))), target_shift:shift_assignments!target_shift_id(id, profile_id, block_id)')
    .eq('id', params.id)
    .single()

  const decision = resolveSwapTransition({
    swap,
    requestedStatus: body.status,
    user,
    userLocationIds: getUserLocationIds(user),
    reviewNote: body.review_note ?? null,
    // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
    // approvals_shift_swaps permission rather than a bare manager-role check.
    canApprove: swap ? hasPermissionForLocation(user, swap.location_id, APPROVAL_CATEGORY_PERMISSION.shift_swaps) : false,
  })

  if (!decision.ok) {
    return NextResponse.json({ success: false, error: decision.error }, { status: decision.status })
  }

  // ROSTER-FIX.8a — `shift_swap_requests.requester_shift_id` FKs
  // `shift_assignments(id) ON DELETE SET NULL` as of mig 603 (it was ON DELETE
  // CASCADE from mig 237), so an approved DROP no longer takes this swap row
  // with it: the history survives the deletion with a null shift pointer, and
  // EITHER ORDER is now safe. The order below is kept as it is — stamp the
  // swap row first, then apply the assignment ops — because it is what the
  // tests pin and because it still reads the captured `swap` for the audit
  // row rather than depending on a re-read.
  //
  // ROSTER-FIX.1 — the cost of that ordering: if the assignment op fails after
  // the swap row is already `approved` and the change-log row is written, the
  // audit trail says a shift was dropped that the coach is in fact still on.
  // The caller gets a 400, so nothing claims success, but the partial state
  // outlives the request and only a log says so — see the logWarn below.
  const { data, error } = await db.from('shift_swap_requests')
    .update(decision.swapUpdates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // SWAPNOTIFY.1 — the drop's roster_change_log row (dropLog below) can end
  // up double-notifying the coach: dispatchSwapNotifications already sends
  // "Swap approved" for it, and if the row is left unstamped the NEXT
  // re-publish/approve covering that date picks it up via
  // collectUnnotifiedChanges and sends a SECOND "Roster updated" for the
  // same drop. dropLog/dropStamped carry the row's id (and whether it has
  // already been stamped) out of this loop and into dispatch.
  let dropLog = null
  let dropStamped = false

  // Assignment writes are awaited so a failure surfaces.
  for (const op of decision.assignmentOps) {
    // ROSTER-FIX.1 (D4) — audit the drop BEFORE the row goes. After the delete
    // there is no assignment and no embed left to describe what happened
    // (ROSTER-FIX.8a: the swap row itself now survives, with a null
    // requester_shift_id); the only trace of a coach losing a shift would
    // otherwise be its absence.
    let block = null
    if (op.delete) {
      block = swap.requester_shift?.block
      // ROSTER-FIX.1 — isPublished is passed TRUE unconditionally, unlike
      // every other logRosterChange caller. logRosterChange no-ops on a draft
      // roster because a draft edit rides the first-publish notification, but
      // a drop is a DELETE: on a draft there is no other record that the
      // assignment ever existed. The real roster status rides in details so a
      // reader can still tell the two apart (and re-publish notification
      // stays correct — the coach is notified either way).
      dropLog = await logRosterChange(db, {
        isPublished: true,
        locationId: block?.location_id || swap.location_id,
        blockId: block?.id || swap.requester_shift?.block_id || null,
        blockDate: block?.block_date || null,
        actorId: user.id,
        coachId: swap.requester_shift?.profile_id || swap.requester_id,
        action: 'unassigned',
        details: { via: 'swap_drop', swap_id: swap.id, roster_status: block?.rosters?.status ?? null },
      })
    }
    const q = op.delete
      ? db.from('shift_assignments').delete().eq('id', op.id)
      : db.from('shift_assignments').update(op.set).eq('id', op.id)
    const { error: opErr } = await q
    if (opErr) {
      // ROSTER-FIX.1 — a failed DELETE here leaves the swap `approved` and a
      // roster_change_log row claiming the coach was unassigned, while the
      // assignment is still there. Nothing retries, and the audit row is the
      // thing a manager trusts, so say so structurally rather than let the
      // 400 be the only trace.
      if (op.delete) {
        logWarn('swaps', 'approved drop: assignment delete failed after swap approved + change logged', {
          swapId: swap.id,
          assignmentId: op.id,
          err: opErr.message,
        })
      }
      return NextResponse.json({ success: false, error: opErr.message }, { status: 400 })
    }
    // SWAPNOTIFY.1 — the coach must never get "Roster updated" for a shift
    // they never saw published (a draft) or one that has already happened
    // (a past block_date). Decide that UNCONDITIONALLY here, right after the
    // delete has actually succeeded — independent of whether the
    // "Swap approved" push below manages to deliver. A draft/past drop is
    // stamped either way; a published, future one is left for dispatch to
    // stamp only once delivery is confirmed.
    if (op.delete && dropLog?.logged && dropLog.id) {
      // A missing block/roster embed reads as "not published" here (isDraft
      // defaults true), same as every other logRosterChange caller treats an
      // unreadable roster status — fail toward "stamp it", never toward
      // silently leaving the coach exposed to a later re-publish ping.
      const isDraft = block?.rosters?.status !== 'published'
      const isPast = !!block?.block_date && block.block_date < dublinTodayStr()
      if (isDraft || isPast) {
        await markChangesNotified(db, [dropLog.id])
        dropStamped = true
      }
    }
  }

  // ROSTER-FIX.8f — best-effort notifications, never block or fail the response.
  // Named for what it does since 8d: these are push WITH an email fallback, not
  // pushes, and the old name read as "coaches without the app get nothing".
  // SWAPNOTIFY.1 — moved into after() (next/server): an un-awaited promise
  // left hanging past the response is the exact shape Vercel can freeze
  // mid-flight, and any stamp inside it would be lost with it.
  after(() => dispatchSwapNotifications(db, decision, swap, user, { dropLog, dropStamped })
    .catch(err => console.error('[swaps] notify failed', err)))

  return NextResponse.json({ success: true, data })
}

// Map the resolver's notify intents to notifications. Bodies live here
// because they need user.full_name and human copy (the resolver stays pure).
// PUSH.2 — deduped per transition. Keys include the acting user where the
// same transition can legitimately recur with a different actor (a swap
// re-opened by a withdrawal can be claimed again, by the SAME actor too,
// which the key suppresses for 30 days; accepted as rare vs the
// double-invoke double-push this closes). The decision key includes the
// status so a decline followed by a re-review approval still notifies.
//
// ROSTER-FIX.8d — notifyUsers*, not sendPush*. Every one of these is somebody
// being told the state of a request they are part of, often one they now have
// to act on before a shift starts, and a push-only notification reaches nobody
// who has not installed the app. `swap` is fallbackEmail in the registry, so a
// recipient with no device tokens is emailed instead. Each call carries an
// explicit emailSubject: the registry default ("Shift swap update") is
// deliberately vague, and an inbox is a worse place than a lock screen to
// guess what a notification was about.
async function dispatchSwapNotifications(db, decision, swap, user, { dropLog, dropStamped } = {}) {
  const actor = user.full_name || 'A coach'
  for (const n of decision.notify) {
    switch (n.kind) {
      case 'claim_for_requester':
        await notifyUsersOnce(db, `swap_claimed:${swap.id}:${user.id}`, n.to, { title: 'Shift claimed', body: `${actor} claimed your shift. Awaiting manager approval.`, category: 'swap', emailSubject: `${actor} claimed your shift`, data: { type: 'swap_claimed', swap_id: swap.id } })
        break
      case 'accept_for_requester':
        await notifyUsersOnce(db, `swap_accepted:${swap.id}:${user.id}`, n.to, { title: 'Swap accepted', body: `${actor} accepted your swap. Awaiting manager approval.`, category: 'swap', emailSubject: `${actor} accepted your swap`, data: { type: 'swap_accepted', swap_id: swap.id } })
        break
      case 'claim_for_managers':
      case 'accept_for_managers':
        await notifyUsersAtRolesOnce(db, `swap_awaiting:${swap.id}:${user.id}`, swap.location_id, MANAGER_ROLES, { title: 'Swap awaiting approval', body: `${actor} took a shift. Tap to approve.`, category: 'swap', emailSubject: 'A shift swap is waiting for your approval', data: { type: 'swap_awaiting', swap_id: swap.id } })
        break
      case 'withdraw_for_requester':
        await notifyUsersOnce(db, `swap_withdrawn:${swap.id}:${user.id}`, n.to, { title: 'Swap re-opened', body: `${actor} withdrew. Your shift is open for swap again.`, category: 'swap', emailSubject: 'Your shift is open for swap again', data: { type: 'swap_withdrawn', swap_id: swap.id } })
        break
      case 'decline_for_requester':
        await notifyUsersOnce(db, `swap_declined:${swap.id}:${user.id}`, n.to, { title: 'Swap declined', body: `${actor} declined your swap request.`, category: 'swap', emailSubject: 'Your swap request was declined', data: { type: 'swap_declined', swap_id: swap.id } })
        break
      case 'decision_for_requester':
      case 'decision_for_taker': {
        const verb = decision.swapUpdates.status === 'approved' ? 'approved' : 'declined'
        const note = decision.swapUpdates.review_note ? ` Note: ${decision.swapUpdates.review_note}` : ''
        // block_date = the requester's shift date. For a reassign/reciprocal
        // approval the decision_for_taker notification links to this SAME
        // date because that is the shift the target now holds — the swap
        // moved the requester's shift to them, so their new shift and the
        // requester's old one share a date. Mobile week-preselects the
        // schedule tab on it.
        const result = await notifyUsersOnce(db, `swap_decision:${swap.id}:${decision.swapUpdates.status}`, n.to, { title: `Swap ${verb}`, body: `Your shift swap was ${verb}.${note}`, category: 'swap', emailSubject: `Your shift swap was ${verb}`, data: { type: 'swap_decision', swap_id: swap.id, status: decision.swapUpdates.status, block_date: swap.requester_shift?.block?.block_date ?? null } })
        // SWAPNOTIFY.1 — this IS the "Swap approved" push for an approved
        // drop; if it actually delivered, stamp the roster_change_log row
        // the route wrote so the next re-publish/approve safety net
        // (renotifyChangedCoaches) doesn't send a SECOND "Roster updated"
        // for the same drop. Only the requester notification counts (the
        // row is keyed to the requester's coach id); a draft/past drop was
        // already stamped unconditionally by the route (dropStamped), so
        // this never double-stamps it. Deliberately NOT stamped on
        // skipped/opt-out, failed, or deduped-only — that leaves the row
        // for the schedule-category safety net to still reach an
        // opted-out coach (same rule NOTIFY.1 uses).
        if (decision.effect === 'approved_drop' && n.kind === 'decision_for_requester' && !dropStamped && dropLog?.logged && dropLog.id) {
          try {
            const delivered = ((result?.sent || 0) + (result?.emailed || 0)) > 0
            if (delivered) {
              await markChangesNotified(db, [dropLog.id])
            }
          } catch (e) {
            // Never let a stamping failure surface inside after() — this
            // whole function is already best-effort and unobserved by the
            // caller.
            logWarn('swaps', 'post-delivery drop stamp failed', { swapId: swap.id, dropLogId: dropLog.id, err: e?.message })
          }
        }
        break
      }
      default:
        break
    }
  }
}
