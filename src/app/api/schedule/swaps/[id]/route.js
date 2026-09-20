// src/app/api/schedule/swaps/[id]/route.js
import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { swapStatusSchema } from '@/lib/schemas'
import { resolveSwapTransition, swapChangeLogEntries, swapApprovalRpc, swapApprovalError, swapIncomingMoves, SWAP_CONFLICTS_CODE } from '@/lib/swap-lifecycle'
import { findSwapConflicts } from '@/lib/swap-conflicts'
import { swapShiftHasStarted, swapShiftStartedInEveryZone } from '@/lib/swap-cover'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { MANAGER_ROLES } from '@/lib/schemas'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { logRosterChange, markChangesNotified } from '@/lib/roster-change-log'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

// COVERLOOP.1 — the status guard on the non-RPC update matched no row.
const SWAP_CHANGED_ERROR = 'This swap has just changed. Refresh and try again.'

const SwapReviewSchema = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
  // SWAPS.2 — the manager has seen the leave / same-day clash warnings for
  // this approval and wants it anyway. Ignored on every other transition.
  confirm_conflicts: z.boolean().optional(),
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
  // SWAPAUDIT.1 — the target_shift embed carries the same block fields: a
  // reciprocal swap audits BOTH blocks and needs each one's date + roster
  // status to decide whether its rows are stamped straight away.
  // SWAPS.2 — both block embeds also carry the block's times: the leave /
  // clash check compares them with the incoming coach's other shifts that day
  // (a moved shift loses its overrides, so the block's times are the window).
  // COVERLOOP.1 — both shifts also carry their own start_time_override: "has
  // this shift started" is judged on the EFFECTIVE start.
  const { data: swap } = await db.from('shift_swap_requests')
    .select('*, requester_shift:shift_assignments!requester_shift_id(id, profile_id, block_id, start_time_override, block:shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status))), target_shift:shift_assignments!target_shift_id(id, profile_id, block_id, start_time_override, block:shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status)))')
    .eq('id', params.id)
    .single()

  // COVERLOOP.1 — a claim, accept or approval on a shift that has already
  // started is refused (409). Only asked for those two target statuses: the
  // ways out (withdraw, cancel, reject, decline) never need it.
  // A RECIPROCAL swap moves two shifts, so its TARGET shift is asked too, on
  // its OWN studio's clock.
  const asksStarted = !!swap && (body.status === 'awaiting_approval' || body.status === 'approved')
  const nowMs = Date.now()
  const zoneCache = new Map()
  const shiftStarted = asksStarted ? await swapShiftStarted(db, swap, swap.requester_shift, nowMs, zoneCache) : false
  const targetShiftStarted = asksStarted && swap.target_shift_id != null
    ? await swapShiftStarted(db, swap, swap.target_shift, nowMs, zoneCache)
    : false

  const decision = resolveSwapTransition({
    swap,
    shiftStarted,
    targetShiftStarted,
    requestedStatus: body.status,
    user,
    userLocationIds: getUserLocationIds(user),
    reviewNote: body.review_note ?? null,
    // APPROVALS-PERCAT.1 — the "approve" transition is gated by the
    // approvals_shift_swaps permission rather than a bare manager-role check.
    canApprove: swap ? hasPermissionForLocation(user, swap.location_id, APPROVAL_CATEGORY_PERMISSION.shift_swaps) : false,
    // SCHEDROLES.1 — manager cancel / reject are judged at the SWAP's studio,
    // not from `user.role` (the ACTIVE studio's role), which carried no
    // location check at all on those two branches.
    isManagerHere: swap ? hasRoleAtLocation(user, swap.location_id, MANAGER_ROLES) : false,
  })

  if (!decision.ok) {
    return NextResponse.json({ success: false, error: decision.error }, { status: decision.status })
  }

  // SWAPS.2 — an approval that puts a coach onto a shift re-checks that coach
  // (both coaches, for a reciprocal swap) for approved leave covering the date
  // and for another live shift overlapping it that day, at any studio. A
  // conflict refuses with 409 and the sentences, unless the manager has
  // confirmed (confirm_conflicts) — a coach legitimately covering while on a
  // half-day, or floating across adjacent slots, is the manager's call, so
  // this is a confirm step and not a hard stop. A drop moves nobody onto
  // anything and is never checked. A check that could not read counts as a
  // conflict here (check_failed): a manager is asked, never silently waved
  // through on an unread check.
  if ((decision.effect === 'approved_reassign' || decision.effect === 'approved_swap') && body.confirm_conflicts !== true) {
    const conflicts = await findSwapConflicts(db, swapIncomingMoves(swap), { viewerId: user.id })
    if (conflicts.length > 0) {
      return NextResponse.json({
        success: false,
        code: SWAP_CONFLICTS_CODE,
        error: conflicts.map((c) => c.message).join(' '),
        conflicts,
      }, { status: 409 })
    }
  }

  // SWAPATOMIC.1 (mig 612) / SWAPS.2 (mig 615) — every approved effect is
  // ONE RPC: the swap-row approval and the assignment write (reciprocal move,
  // reassign move, or drop delete) happen in one transaction, after the
  // function has locked the rows and re-checked them against what this
  // request read (open, stale, conflict). Before SWAPS.2 a reassign or drop
  // stamped the swap `approved` and THEN wrote the assignment as a separate
  // call, so a failed write left a terminal approved swap with nobody moved.
  // The moves also clear the previous coach's paid-window overrides and
  // arrival stamp (SWAP_MOVE_CLEARS). Every other transition is a plain
  // swap-row update.
  let data
  const rpc = swapApprovalRpc(decision.effect, params.id, swap, decision.swapUpdates)
  if (rpc) {
    const { data: approved, error: rpcErr } = await db.rpc(rpc.fn, rpc.args)
    if (rpcErr) {
      const { status, error: msg } = swapApprovalError(rpcErr)
      return NextResponse.json({ success: false, error: msg }, { status })
    }
    data = approved
  } else {
    // COVERLOOP.1 — guarded on the status this request READ. The decision
    // above was made about that status; if the cover sweep (a shift that just
    // started), a manager or another coach changed the swap in between, an
    // unguarded write would overwrite theirs: a claim that read `pending` a
    // moment before the shift started turned the sweep's `cancelled` back into
    // `awaiting_approval`, and the managers were pushed to approve a dead
    // swap. A zero-row UPDATE is NOT an error in PostgREST, so the rows that
    // come back are the verdict (hence no .single()): none means nothing was
    // written, and nothing below (audit, warnings, notifications) may run.
    const { data: rows, error } = await db.from('shift_swap_requests')
      .update(decision.swapUpdates)
      .eq('id', params.id)
      .eq('status', swap.status)
      .select()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    if (!rows || rows.length === 0) {
      return NextResponse.json({ success: false, error: SWAP_CHANGED_ERROR }, { status: 409 })
    }
    data = rows[0]
  }

  // SWAPNOTIFY.1 — the drop's roster_change_log row (dropLog below) can end
  // up double-notifying the coach: dispatchSwapNotifications already sends
  // "Swap approved" for it, and if the row is left unstamped the NEXT
  // re-publish/approve covering that date picks it up via
  // collectUnnotifiedChanges and sends a SECOND "Roster updated" for the
  // same drop. dropLog/dropStamped carry the row's id (and whether it has
  // already been stamped) into dispatch.
  let dropLog = null
  let dropStamped = false

  if (decision.effect === 'approved_drop') {
    // ROSTER-FIX.1 (D4) — the only trace of a coach losing a shift, since the
    // assignment is gone. SWAPS.2 — written AFTER the atomic RPC succeeded
    // (it used to be written before a separate DELETE, so a failed delete
    // left an audit row claiming an unassignment that never happened), from
    // the swap + block embed read at the top of this request: that copy
    // outlives the deleted row, which is all the old "before" ordering was
    // for.
    const block = swap.requester_shift?.block
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
    // SWAPNOTIFY.1 — the coach must never get "Roster updated" for a shift
    // they never saw published (a draft) or one that has already happened
    // (a past block_date). Decide that UNCONDITIONALLY here, right after the
    // delete has actually succeeded — independent of whether the
    // "Swap approved" push below manages to deliver. A draft/past drop is
    // stamped either way; a published, future one is left for dispatch to
    // stamp only once delivery is confirmed.
    if (dropLog?.logged && dropLog.id) {
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

  // SWAPAUDIT.1 — an approved reassign / reciprocal swap moves coaches
  // between shifts, and on a published roster that move has to be in the
  // audit trail like any other edit. Written only now, after the RPC
  // succeeded (a refused one returned above), so the log never claims a move
  // that did not happen. Best-effort: nothing here can fail the approval.
  let moveLogs = null
  if (decision.effect === 'approved_reassign' || decision.effect === 'approved_swap') {
    moveLogs = await logSwapMoves(db, decision.effect, swap, user)
  }

  // SWAPS.2 — a coach claiming or accepting a shift is told if they are on
  // approved leave that day or already on an overlapping shift (any studio).
  // Advisory only: the claim has already been saved above and stands; the
  // manager's approval is where it is enforced. Only the claiming coach's own
  // conflicts — never a colleague's leave — and an unreadable check is left
  // out rather than shown to a coach as a warning.
  let warnings = null
  if (decision.effect === 'claimed' || decision.effect === 'accepted') {
    const conflicts = await findSwapConflicts(db, swapIncomingMoves(swap, { takerId: user.id, takerOnly: true }), { viewerId: user.id })
    warnings = conflicts.filter((c) => c.kind !== 'check_failed').map((c) => c.message)
  }

  // ROSTER-FIX.8f — best-effort notifications, never block or fail the response.
  // Named for what it does since 8d: these are push WITH an email fallback, not
  // pushes, and the old name read as "coaches without the app get nothing".
  // SWAPNOTIFY.1 — moved into after() (next/server): an un-awaited promise
  // left hanging past the response is the exact shape Vercel can freeze
  // mid-flight, and any stamp inside it would be lost with it.
  after(() => dispatchSwapNotifications(db, decision, swap, user, { dropLog, dropStamped, moveLogs })
    .catch(err => console.error('[swaps] notify failed', err)))

  return NextResponse.json(warnings ? { success: true, data, warnings } : { success: true, data })
}

// COVERLOOP.1 — has one of the swap's shifts (the requester's, or the target's
// on a reciprocal swap) started? The rule is swapShiftHasStarted
// (src/lib/swap-cover.js), the SAME predicate the cover sweep closes a swap on,
// so the two can never disagree: block_date + the assignment's
// start_time_override (else the block's start_time), as wall clock in the
// timezone of THAT shift's own studio (its block's location; the swap's if the
// block has none). Far from the start every zone on earth agrees and nothing
// is read; near it the studio's timezone is read once per studio per request,
// and an unreadable, empty or invalid one is Europe/Dublin. Never throws: this
// guard must not turn a swap action into a 500.
async function swapShiftStarted(db, swap, assignment, nowMs, zoneCache) {
  if (!assignment?.block) return false
  const shift = {
    block_date: assignment.block.block_date,
    start_time: assignment.block.start_time,
    start_time_override: assignment.start_time_override ?? null,
  }
  const everywhere = swapShiftStartedInEveryZone(shift, nowMs)
  if (everywhere !== null) return everywhere

  const locationId = assignment.block.location_id || swap.location_id
  if (!zoneCache.has(locationId)) {
    let tz = null
    try {
      // 0 rows is a legitimate answer (-> Europe/Dublin), hence maybeSingle.
      const { data, error } = await db.from('locations').select('id, timezone').eq('id', locationId).maybeSingle()
      if (error) throw new Error(error.message)
      tz = data?.timezone ?? null
    } catch (e) {
      logWarn('swaps', 'could not read the studio timezone for the started-shift check; using Europe/Dublin', { swapId: swap.id, locationId, err: e?.message })
    }
    zoneCache.set(locationId, tz)
  }
  return swapShiftHasStarted(shift, nowMs, zoneCache.get(locationId))
}

// SWAPAUDIT.1 — write the roster_change_log rows for an approved reassign
// (2 rows) or reciprocal swap (4 rows) and settle which of them are already
// "notified".
//
// Both coaches get a "Swap approved" decision message from
// dispatchSwapNotifications, so the re-publish safety net
// (collectUnnotifiedChanges -> renotifyChangedCoaches) must not reach them a
// second time with "Roster updated". Same rule SWAPNOTIFY.1 applies to a drop:
//   - a row on a draft roster, with no block embed, or on a past block_date is
//     stamped HERE, unconditionally — the coach must never be told about a
//     shift they never saw published or one that has already happened;
//   - every other row is returned, grouped by which decision message covers
//     its coach, and dispatch stamps a group only once THAT message actually
//     delivered. An opted-out, failed or deduped-only coach keeps unstamped
//     rows so the safety net still reaches them.
//
// Unlike the drop, isPublished is the real roster status: the assignment
// still exists after a move, so a draft move leaves its own trace and rides
// the first-publish notification (logRosterChange no-ops on it).
//
// Never throws. Returns { requester: [ids], taker: [ids] } of rows awaiting
// delivery, or null if logging blew up.
async function logSwapMoves(db, effect, swap, user) {
  try {
    const entries = swapChangeLogEntries(effect, swap)
    const today = dublinTodayStr()
    const results = await Promise.all(entries.map((e) => logRosterChange(db, {
      isPublished: e.block?.rosters?.status === 'published',
      locationId: e.block?.location_id || swap.location_id,
      blockId: e.blockId,
      blockDate: e.block?.block_date || null,
      actorId: user.id,
      coachId: e.coachId,
      action: e.action,
      details: { via: 'swap', swap_id: swap.id, effect },
    })))

    const immediate = []
    const pending = { requester: [], taker: [] }
    entries.forEach((e, i) => {
      const r = results[i]
      if (!r?.logged || !r.id) return
      // A missing block/roster embed reads as a draft, as in the drop path:
      // fail toward "stamp it", never toward a surprise re-publish ping.
      const isDraft = e.block?.rosters?.status !== 'published'
      const isPast = !!e.block?.block_date && e.block.block_date < today
      if (isDraft || isPast) immediate.push(r.id)
      else pending[e.role].push(r.id)
    })
    // markChangesNotified checks its own {error} and logs it (logWarn); it
    // never throws.
    if (immediate.length) await markChangesNotified(db, immediate)
    return pending
  } catch (e) {
    logWarn('swaps', 'approved swap: change log failed', { swapId: swap?.id, effect, err: e?.message })
    return null
  }
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
async function dispatchSwapNotifications(db, decision, swap, user, { dropLog, dropStamped, moveLogs } = {}) {
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
        // SWAPAUDIT.1 — the same rule for an approved reassign / reciprocal
        // swap, per coach: this message covers only the rows logSwapMoves
        // grouped under its recipient (requester or taker), so the other
        // coach's rows wait on their own delivery. A draft/past row never
        // reaches here (logSwapMoves stamped it already).
        const moveIds = moveLogs?.[n.kind === 'decision_for_requester' ? 'requester' : 'taker']
        if (moveIds?.length) {
          try {
            const delivered = ((result?.sent || 0) + (result?.emailed || 0)) > 0
            if (delivered) {
              await markChangesNotified(db, moveIds)
            }
          } catch (e) {
            logWarn('swaps', 'post-delivery swap move stamp failed', { swapId: swap.id, kind: n.kind, err: e?.message })
          }
        }
        break
      }
      default:
        break
    }
  }
}
