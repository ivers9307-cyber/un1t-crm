import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import {
  EXECUTING_KINDS,
  CONDITIONAL_EXECUTING_KINDS,
  stuckExecutionStartedAt,
  isRetryableFailure,
  executingMarker,
  finishedMarker,
} from '@/lib/agent/request-recovery'
import { approvalGrantsTrialCredit } from '@/lib/approvals/agent-request-why'
import { logWarn } from '@/lib/log'
import { isManualEventId } from '@/lib/manual-timetable'
import { hasRoleAtLocation } from '@/lib/role-at-location'
import { MANAGER_ROLES } from '@/lib/schemas'

// PATCH /api/agent/membership-requests/[id] — staff decides a queued
// agent request. Decision rights follow the comms surface (any staff
// at the request's location — INBOX-APPROVALS, Richard 2026-07-03).
// 'approved' + 'declined' apply to every kind; 'saved' is the
// retention outcome on a cancellation (member kept).
//
// Pause: the actual Glofox change is made by staff manually after approving
// (Glofox's pause route rejects the impersonation header it needs).
//
// CANCEL-FORM.5 — membership CANCELLATION executes in Glofox on approve ONLY
// when the location opted in (locations.glofox_auto_cancel_memberships, mig
// 584; default off → status write, staff cancel by hand as before). Either
// way the member is now told: approve / actioned / saved confirm on the
// channel the request arrived by (email for form-delivered rows, in-thread
// otherwise), and an email-delivered row's decline goes by email too — a
// decline is never silence. Staff may supply `end_date` on the card; it
// overrides details.requested_end_date (Mia rows carry only free text).
//
// AGENT-HANDS.1 — class_booking: APPROVING EXECUTES. The route books
// the class via the same live-probed createBooking the inbox Book tab
// uses, lands the row on 'actioned' (or 'failed' with the Glofox
// message_code kept verbatim in details.result), and the agent sends
// the confirmation into the originating WhatsApp/Instagram thread —
// staff touch exactly one button.

// Client-settable outcomes only — 'actioned'/'failed' are written by the
// server's own execution branches, never accepted as caller input (a raw
// PATCH {status:'actioned'} would phantom-complete a pending request
// without the Glofox action ever running).
const DecisionSchema = z.object({
  status: z.enum(['approved', 'declined', 'saved']),
  decision_note: z.string().max(2000).nullable().optional(),
  // CANCEL-FORM.5 — cancellation only: the end date staff confirm/set.
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const MEMBERSHIP_KINDS = new Set(['cancellation', 'pause'])

// EVENT-MOVE.7 — approving an event_move writes at the source AND the target
// studio, so the approver needs what the staff move route needs at both
// (/api/event-registrations/[id]/move): `races` and a manager role. Judged
// BEFORE the claim, so a refusal leaves the request pending for someone who
// can approve it. A missing target is not refused here: the move itself
// answers target_unavailable.
async function eventMoveApproverRefusal(db, user, row) {
  const targetId = row.details?.target_event_id
  let target = null
  if (targetId) {
    const { data, error } = await db.from('race_events')
      .select('id, location_id, locations:location_id ( name )')
      .eq('id', targetId)
      .maybeSingle()
    if (error) {
      logWarn('agent-requests', 'event move: target event read failed', { requestId: row.id, err: error })
      return NextResponse.json({ success: false, error: 'The target event could not be read. Try again.' }, { status: 500 })
    }
    target = data || null
  }
  const studios = [{ id: row.location_id, name: null }]
  if (target?.location_id && target.location_id !== row.location_id) studios.push({ id: target.location_id, name: target.locations?.name || null })
  else if (target?.location_id) studios[0].name = target.locations?.name || null
  for (const studio of studios) {
    const allowed = !!studio.id
      && hasPermissionForLocation(user, studio.id, 'races')
      && hasRoleAtLocation(user, studio.id, MANAGER_ROLES)
    if (allowed) continue
    let name = studio.name
    if (!name && studio.id) {
      const { data: loc } = await db.from('locations').select('name').eq('id', studio.id).maybeSingle()
      name = loc?.name || null
    }
    return NextResponse.json({ success: false, error: `Approving this move needs a manager at ${name || 'that studio'}` }, { status: 403 })
  }
  return null
}

/**
 * Who approved, for the move's actor name. Under impersonation the REAL
 * caller is named, "<master> as <user>" (the staff move route's actorFor).
 */
function moveApproverName(user) {
  const userName = user.full_name || user.email || 'staff'
  const imp = user.impersonatingFrom
  return imp?.masterId ? `${imp.masterName || imp.masterEmail || 'master'} as ${userName}` : userName
}

export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  // Confirm the request belongs to a location this user can act on.
  const { data: row } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, status, details, contact_id, channel, conversation_id')
    .eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // APPROVALS-PERCAT.1 — agent requests are now fully gated on the
  // per-category permission (default manager+). 404 preserves the
  // detail-route IDOR posture (never confirm a foreign id exists).
  if (!hasPermissionForLocation(user, row.location_id, APPROVAL_CATEGORY_PERMISSION.agent_requests)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const v = await validateBody(request, DecisionSchema)
  if (!v.ok) return v.response

  // CANCEL-FORM.5 — membership kinds read the location once: the auto-cancel
  // toggle (a COLUMN, mig 585) and the operator's confirmation copy.
  const isMembershipKind = MEMBERSHIP_KINDS.has(row.kind)
  let locationRow = null
  if (isMembershipKind) {
    const { data } = await db.from('locations')
      .select('name, glofox_auto_cancel_memberships, settings')
      .eq('id', row.location_id)
      .maybeSingle()
    locationRow = data || null
  }
  const autoCancel = row.kind === 'cancellation'
    && v.data.status === 'approved'
    && CONDITIONAL_EXECUTING_KINDS.has(row.kind)
    && locationRow?.glofox_auto_cancel_memberships === true

  // MIA-REVIEW.3 — a row stuck at 'approved' with details.execution.stage
  // 'executing' is a crashed approval (the process died between the claim and
  // the Glofox call finishing): never actioned, never failed, no confirmation
  // sent, and previously unrecoverable because every re-decision 409'd. Such a
  // row may be RE-approved to retry the execution. Everything else keeps the
  // strict once-only rule.
  const retryStartedAt = stuckExecutionStartedAt(row, Date.now())
  const isRetry = !!retryStartedAt && v.data.status === 'approved'
  // AGENT-RETRY.1 — a FAILED execution may be re-approved: the operator
  // fixes the underlying problem in Glofox (credits, account link), then
  // retries the side effect. Approve-only; decline on a failed row still
  // 409s. Deliberately no staleness gate here — the UI decides what to
  // OFFER (retryOffered), the route trusts a deliberate operator action
  // (Glofox arbitrates a pointless retry the same way it always has).
  const isFailedRetry = isRetryableFailure(row) && v.data.status === 'approved'
  if (row.status !== 'pending' && !isRetry && !isFailedRetry) {
    return NextResponse.json({ success: false, error: 'Already decided' }, { status: 409 })
  }

  if (row.kind === 'event_move' && v.data.status === 'approved') {
    const refusal = await eventMoveApproverRefusal(db, user, row)
    if (refusal) return refusal
  }

  // Atomic claim — flip pending → the caller's decision. A concurrent
  // decision loses the .eq('status','pending') predicate and 409s, so
  // outcomes can't clobber each other and executions can't double-run
  // (claim-before-execute, same pattern as claim-before-send in comms).
  // A RETRY claims on the stale marker instead: two concurrent retries both
  // read the same started_at, the first rewrites it, the second's predicate no
  // longer matches and 409s. The double-execution guard is unchanged.
  const nowIso = new Date().toISOString()
  // Executing kinds carry an intent marker for the duration of the side
  // effect, so a crash is visible (and retryable) rather than silent.
  const executing = v.data.status === 'approved' && (EXECUTING_KINDS.has(row.kind) || autoCancel)
  const claimPatch = {
    status: v.data.status,
    decision_note: v.data.decision_note?.trim() || null,
    decided_by: user.id,
    decided_at: nowIso,
    updated_at: nowIso,
  }
  // CANCEL-FORM.5 — a staff-supplied end date lands on the row with the claim
  // (so a crash after this point still shows the date staff confirmed).
  const baseDetails = row.kind === 'cancellation' && v.data.end_date
    ? { ...(row.details || {}), requested_end_date: v.data.end_date }
    : row.details
  if (executing) claimPatch.details = executingMarker(baseDetails, { startedAt: nowIso, by: user.id })
  else if (baseDetails !== row.details) claimPatch.details = baseDetails

  let claimQuery = db.from('agent_membership_requests').update(claimPatch).eq('id', id)
  // AGENT-RETRY.1 — a failed-retry claims on status='failed': two concurrent
  // retries race the predicate, the loser matches zero rows and 409s, so the
  // execution still can't double-run (same shape as the pending claim).
  claimQuery = isRetry
    ? claimQuery.eq('status', 'approved').eq('details->execution->>started_at', retryStartedAt)
    : isFailedRetry
      ? claimQuery.eq('status', 'failed')
      : claimQuery.eq('status', 'pending')
  const { data: claimed } = await claimQuery.select('id').maybeSingle()
  if (!claimed) {
    return NextResponse.json({ success: false, error: 'Already decided' }, { status: 409 })
  }
  if (isRetry) {
    console.warn(`[agent-requests] retrying crashed execution ${id} (${row.kind}), stalled since ${retryStartedAt}`)
  }
  if (isFailedRetry) {
    console.warn(`[agent-requests] retrying failed execution ${id} (${row.kind}), previous result ${row.details?.result?.message_code || 'unknown'}`)
  }

  let finalStatus = v.data.status
  let details = claimPatch.details || row.details || {}
  let executed = null

  // Operator-editable confirmation copy — loaded lazily (only the execution
  // branches that actually message the customer pay for the read) and once.
  let confirmationCopy = null
  async function confirmationTemplate(key) {
    if (!confirmationCopy) {
      const { agentConfirmationTemplates } = await import('@/lib/agent/notify')
      confirmationCopy = await agentConfirmationTemplates(db, row.location_id)
    }
    return confirmationCopy[key]
  }

  // AGENT-EVENTS.3 — approving a drafted PAID-entry cancellation
  // executes it. The refund (if any) stays a human decision processed
  // manually in Revolut Business — this only frees the spot.
  if (executing && row.kind === 'event_cancellation') {
    const { cancelRaceRegistration } = await import('@/lib/race-cancel')
    const result = await cancelRaceRegistration(db, details.registration_id)
    executed = { ok: result.ok, error: result.error || null }
    details = { ...details, result: executed }
    finalStatus = result.ok ? 'actioned' : 'failed'
    if (result.ok && row.conversation_id) {
      try {
        const { sendAgentThreadMessage, buildCancellationConfirmationText } = await import('@/lib/agent/notify')
        await sendAgentThreadMessage(db, {
          channel: row.channel,
          conversationId: row.conversation_id,
          text: buildCancellationConfirmationText({
            className: details.event_name,
            classTime: details.event_date,
            template: await confirmationTemplate('cancellation'),
          }),
        })
      } catch (e) {
        console.warn(`[agent-requests] event cancellation confirmation send error: ${e?.message || e}`)
      }
    }
  }

  // EVENT-MOVE.7 — approving Mia's event_move request runs the shared move
  // (moveRegistration, the same rules and SQL function staff and hosts use)
  // with the agent as actor and the approving staff member named. Never
  // forced: a full time refuses, and staff can move it by hand from the
  // teams page. expectedSourceEventId refuses a move whose entry has left
  // the event the request was filed against (conflict). The customer is
  // told in-thread either way; a refusal is told once, not on every retry.
  if (executing && row.kind === 'event_move') {
    const { moveRegistration, MOVE_ERROR_MESSAGES } = await import('@/lib/registration-move')
    const result = await moveRegistration(db, {
      registrationId: details.registration_id,
      targetEventId: details.target_event_id,
      targetWaveId: details.target_wave_id || null,
      expectedSourceEventId: details.source_event_id || null,
      actor: { type: 'agent', id: null, name: `Mia, approved by ${moveApproverName(user)}` },
      note: details.note || null,
      notify: true,
      force: false,
    })
    // A conflict whose entry is already on the target is a move that landed:
    // an earlier attempt that died after the write (the stuck-retry lane) or
    // a staff member who moved it by hand first. Read, never assumed.
    let alreadyMoved = false
    if (!result.ok && result.error === 'conflict') {
      const { data: current, error: currentErr } = await db.from('race_registrations')
        .select('race_event_id, wave_id, status')
        .eq('id', details.registration_id)
        .maybeSingle()
      if (currentErr) logWarn('agent-requests', 'event move: conflict re-read failed', { requestId: id, err: currentErr })
      // Live only: a cancelled entry sitting on the target is not a move that landed.
      alreadyMoved = !!current && current.status === 'confirmed' && current.race_event_id === details.target_event_id
        && (!details.target_wave_id || current.wave_id === details.target_wave_id)
    }
    if (alreadyMoved) {
      executed = { ok: true, move_id: null, notified: false, recovered: 'already_on_target' }
      const { failure: _previousFailure, ...rest } = details
      details = { ...rest, result: executed }
      finalStatus = 'actioned'
    } else if (result.ok) {
      executed = { ok: true, move_id: result.move?.id || null, notified: result.notified === true }
      // A retry that now succeeds drops the earlier attempt's failure code.
      const { failure: _previousFailure, ...rest } = details
      details = { ...rest, result: executed }
      finalStatus = 'actioned'
    } else {
      executed = { ok: false, move_error: result.error, message: MOVE_ERROR_MESSAGES[result.error] || null }
      details = { ...details, result: executed, failure: result.error }
      finalStatus = 'failed'
    }
    const moved = finalStatus === 'actioned'
    const tellCustomer = row.conversation_id && (moved || (!isRetry && !isFailedRetry))
    if (tellCustomer) {
      try {
        const { sendAgentThreadMessage, buildEventMoveConfirmationText, buildEventMoveFailedText } = await import('@/lib/agent/notify')
        const text = moved
          ? buildEventMoveConfirmationText({
            eventName: details.target_event_name,
            dateLabel: details.target_date_label,
            timeLabel: details.target_wave_label,
            notified: executed.notified === true,
            priceGapCents: details.price_gap_cents,
            currency: details.currency,
            template: await confirmationTemplate('eventMove'),
          })
          : buildEventMoveFailedText({ error: result.error, template: await confirmationTemplate('eventMoveFailed') })
        await sendAgentThreadMessage(db, { channel: row.channel, conversationId: row.conversation_id, text })
      } catch (e) {
        console.warn(`[agent-requests] event move message send error: ${e?.message || e}`)
      }
    }
  }

  // AGENT-EVENTS.2 — approving a drafted event booking executes it.
  if (executing && row.kind === 'event_booking') {
    const { registerSoloEventEntry } = await import('@/lib/race-register-solo')
    const { data: contact } = await db.from('contacts')
      .select('id, name, first_name, last_name, email, phone')
      .eq('id', row.contact_id)
      .maybeSingle()
    const { data: race } = await db.from('race_events')
      .select('id, name, kind, slug, race_date, active, location_id, registration_opens_at, registration_closes_at, member_pricing_enabled, member_fee_cents, non_member_fee_cents, members_only, payment_currency, waves:race_waves(id, start_time, capacity, label)')
      .eq('id', details.event_id)
      .maybeSingle()
    if (!contact || !race) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, reason: 'NOT_EXECUTABLE' } }
    } else {
      const result = await registerSoloEventEntry(db, { race, waveId: details.wave_id || null, contact })
      executed = { ok: result.ok, reason: result.reason || null }
      details = { ...details, result: executed }
      finalStatus = result.ok ? 'actioned' : 'failed'
      if (result.ok && row.conversation_id) {
        try {
          const { sendAgentThreadMessage, buildBookingConfirmationText } = await import('@/lib/agent/notify')
          await sendAgentThreadMessage(db, {
            channel: row.channel,
            conversationId: row.conversation_id,
            text: buildBookingConfirmationText({
              className: details.event_name,
              classTime: details.event_date,
              template: await confirmationTemplate('booking'),
            }),
          })
        } catch (e) {
          console.warn(`[agent-requests] event confirmation send error: ${e?.message || e}`)
        }
      }
    }
  }

  // AGENT-CANCEL.1 — approving a drafted cancellation executes it.
  if (executing && row.kind === 'class_cancellation') {
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, cancelBooking } =
      await import('@/lib/glofox')
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', row.contact_id)
      .maybeSingle()
    const creds = await glofoxCredentialsForLocation(db, row.location_id)
    // PERSON-ACCT.7 — the booking may live on a SIBLING account (the agent
    // resolves ownership across the whole person before drafting and records
    // it). Cancelling against row.contact_id's account would simply fail
    // against the wrong account — which is why PR1 refused to draft those at
    // all. Honour the override when the row carries one.
    const executingMemberId = row.details?.executing_glofox_member_id || contact?.glofox_member_id || null
    if (creds?.readError) {
      // REGISTRYREAD.1a: the settings read failed; nothing was sent to
      // Glofox. Same 'failed' + Fix & retry lane, true advice on the card.
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' } }
    } else if (!executingMemberId || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else {
      const result = await cancelBooking(creds, details.booking_id, executingMemberId)
      const messageCode = result?.body?.message_code || result?.body?.message || null
      executed = {
        ok: result.ok, status: result.status, message_code: messageCode,
        // GLOFOXPOSTRETRY.1 — Glofox answered 5xx and a read found it cancelled.
        ...(result.recovered ? { recovered: result.recovered } : {}),
      }
      details = { ...details, result: executed }
      finalStatus = result.ok ? 'actioned' : 'failed'

      if (result.ok && row.conversation_id) {
        try {
          const { sendAgentThreadMessage, buildCancellationConfirmationText } = await import('@/lib/agent/notify')
          await sendAgentThreadMessage(db, {
            channel: row.channel,
            conversationId: row.conversation_id,
            text: buildCancellationConfirmationText({
              className: details.class_name,
              classTime: details.class_time,
              template: await confirmationTemplate('cancellation'),
            }),
          })
        } catch (e) {
          console.warn(`[agent-requests] cancellation confirmation send error: ${e?.message || e}`)
        }
      }
    }
  }

  // MIA-BOARD.2 — past-start guard. On 23 Aug two funnel bookings were
  // approved at 8:26pm for classes that had run that MORNING; Glofox accepted
  // the post-hoc bookings and the customer got confirmations for finished
  // classes (the Ciaran incident). An approval whose class has started
  // expires instead of executing — regardless of how it dodged the sweep
  // (approved into the 15-minute gap, or a retry on an old failed row).
  // Only rows carrying a machine-readable details.starts_at are guardable;
  // funnel rows always have one, legacy Mia-thread rows may not. Expiring is
  // SILENT to the member (MIA-EXPIRY-QUIET.1) — staff follow up by hand.
  //
  // MANUALFUNNEL.1 — a class off a studio's hand-written timetable (no Glofox
  // there: staff book it on the studio's own platform) is exempt. Approving
  // it executes nothing and messages nobody, it only records that staff did
  // the booking, so recording it after the class has run is still true.
  const manualBooking = row.kind === 'class_booking' && isManualEventId(details?.event_id)
  let expiredBeforeExecution = false
  if (executing && row.kind === 'class_booking' && !manualBooking) {
    const startsAtMs = Date.parse(row.details?.starts_at || '')
    if (Number.isFinite(startsAtMs) && startsAtMs < Date.now()) {
      expiredBeforeExecution = true
      finalStatus = 'expired'
      details = { ...details, result: { ok: false, reason: 'CLASS_ALREADY_STARTED' } }
      executed = { ok: false, reason: 'CLASS_ALREADY_STARTED' }
      // MIA-EXPIRY-QUIET.1 (Richard, 2026-08-31) — a missed booking is never
      // announced to the member. This used to send an in-thread apology; an
      // automated "sorry we missed it" is a second failure on top of the
      // first. The deciding staffer is told inline instead (the card's
      // 'expired' outcome line says the member has NOT been contacted) and
      // follows up in their own words.
      if (details?.source === 'start_funnel') {
        try {
          await db.from('class_booking_requests')
            .update({ status: 'failed', last_error: 'class_already_started' })
            .eq('approval_request_id', id)
        } catch (e) { console.warn(`[agent-requests] cbr sync error: ${e?.message || e}`) }
      }
      console.warn(`[agent-requests] refused past-start execution ${id} (starts_at ${row.details?.starts_at})`)
    }
  }

  // MANUALFUNNEL.1 — approving a manual-timetable booking records it as done.
  // Nothing is sent to Glofox (the studio has none) and no trial is bought.
  // Judged on the event id, never on details.reason: a request that reached
  // its card through the queue's retry path carries 'processing_error'.
  let manualNotified = null
  if (executing && manualBooking) {
    executed = { ok: true, manual: true }
    details = { ...details, result: executed }
    finalStatus = 'actioned'
    let queueRowId = null
    if (details?.source === 'start_funnel') {
      // Keep the funnel's queue row in step, or it sits in needs_review for
      // good. Best-effort: the card is the record staff act on.
      const { data: synced, error: cbrErr } = await db.from('class_booking_requests')
        .update({ status: 'booked', last_error: null })
        .eq('approval_request_id', id)
        .select('id')
      if (cbrErr) logWarn('agent-requests', 'manual booking: queue row sync failed', { requestId: id, err: cbrErr })
      queueRowId = Array.isArray(synced) && synced[0]?.id ? synced[0].id : null
    }
    // MANUALSCHEDULE.1 — tell Meta the booking was really made. The funnel
    // already sent a Lead when the customer asked for the class; this is the
    // Schedule that the Glofox path sends when ITS booking lands
    // (class-booking-processor.js), with the same event id shape, so an ad
    // campaign can be pointed at people who end up booked rather than anyone
    // who fills the form. Sent only on approve: a declined or expired card
    // sends nothing. Best-effort and gated inside the helper on the
    // location's settings.meta_ads.dataset_id; it never fails the decision.
    let manualContact = null
    let manualPage = null
    let manualLocation = null
    try {
      const [{ data: c }, { data: page }, { data: loc }] = await Promise.all([
        db.from('contacts').select('id, first_name, last_name, name, email, phone').eq('id', row.contact_id).maybeSingle(),
        db.from('landing_page_settings').select('public_path, blocks').eq('location_id', row.location_id).maybeSingle(),
        db.from('locations').select('name, address').eq('id', row.location_id).maybeSingle(),
      ])
      manualContact = c || null
      manualPage = page || null
      manualLocation = loc || null
      if (c && (c.email || c.phone)) {
        const { sendWebsiteConversion } = await import('@/lib/meta-capi')
        const { classFunnelConfigFromBlocks } = await import('@/lib/public-landing')
        await sendWebsiteConversion(db, {
          locationId: row.location_id, eventName: 'Schedule',
          email: c.email, phone: c.phone,
          eventSourceUrl: page?.public_path ? classFunnelConfigFromBlocks(page.blocks, page.public_path).eventSourceUrl : undefined,
          // Stable per booking, so a re-run of this approval is deduped by Meta.
          eventId: queueRowId ? `classbooking-${queueRowId}` : `classbooking-approval-${id}`,
          contentName: details?.class_name || 'Class',
          // MATCHQUALITY.1 — same identifiers as the Lead, so Meta joins them.
          firstName: c.first_name, lastName: c.last_name, externalId: c.id,
        })
      }
    } catch (e) { logWarn('agent-requests', 'manual booking: Schedule event failed', { requestId: id, err: e }) }
    // MANUALCONFIRM.1 — tell the customer. The studio has no WhatsApp number,
    // so this email is the only confirmation they get; the card shows whether
    // it went (customer_notified, like the membership kinds). Copy is the
    // class_funnel block's, defaults otherwise. Best-effort: never fails the
    // approval, and a failure reads "NOT been emailed" on the card.
    try {
      const { sendManualBookingConfirmEmail } = await import('@/lib/manual-booking-confirm')
      manualNotified = await sendManualBookingConfirmEmail(db, {
        locationId: row.location_id,
        contact: manualContact,
        className: details?.class_name,
        startsAt: details?.starts_at,
        blocks: manualPage?.blocks,
        studioName: manualLocation?.name,
        address: manualLocation?.address,
        requestId: id,
      })
    } catch (e) {
      logWarn('agent-requests', 'manual booking: confirmation email threw', { requestId: id, err: e })
      manualNotified = { sent: false, channel: 'email', reason: 'send_error' }
    }
  }

  // AGENT-HANDS.1 — approving a drafted class booking executes it.
  if (executing && row.kind === 'class_booking' && !expiredBeforeExecution && !manualBooking) {
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, interpretBookingResult, GLOFOX_BOOKING_MODEL } =
      await import('@/lib/glofox')
    // PERSON-ACCT.9 — the row is FILED against the contact this booking
    // belongs to for attribution (the /start funnel row carries the ctwa_clid
    // and the phone the confirmation goes to), but the ACCOUNT the write runs
    // on may be a corroborated SIBLING's — the funnel reuses an existing
    // account rather than minting a duplicate. `details.executing_contact_id`
    // names that row; without honouring it the executor would read the funnel
    // row's empty glofox_member_id and answer NOT_EXECUTABLE on a booking
    // staff can see is ready to go. Same override the class_cancellation lane
    // above already makes, and it defaults to row.contact_id, so every row
    // written before this existed executes exactly as it did.
    const executingContactId = row.details?.executing_contact_id || row.contact_id
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', executingContactId)
      .maybeSingle()
    const creds = await glofoxCredentialsForLocation(db, row.location_id)
    // PERSON-ACCT.7 — the agent ELECTED one of this person's linked Glofox
    // accounts for the write and stamped it on the row. By the time staff
    // approve, the contact's link may have been repointed (a merge, a
    // re-sync, a manual fix in Glofox), so executing anyway would book a
    // class on an account nobody chose — silently, with a confirmation sent.
    // Refuse instead and land the row on 'failed', where the existing
    // Fix & retry lane picks it up once the operator has sorted the account.
    const electedMemberId = row.details?.elected_glofox_member_id || null
    const accountMismatch = !!electedMemberId
      && !!contact?.glofox_member_id
      && contact.glofox_member_id !== electedMemberId
    if (creds?.readError) {
      // REGISTRYREAD.1a: as above.
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'GLOFOX_SETTINGS_UNREADABLE' } }
    } else if (!contact?.glofox_member_id || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else if (accountMismatch) {
      executed = { ok: false, message_code: 'ACCOUNT_MISMATCH' }
      details = { ...details, result: executed }
      finalStatus = 'failed'
      console.warn(`[agent-requests] refused execution ${id}: elected account ${electedMemberId} no longer matches contact ${executingContactId}`)
    } else {
      // TRIALGRANT.1 — a needs_credit_grant card buys the trial BEFORE
      // booking, and the purchase is JUDGED (grantTrialBeforeBooking; Glofox
      // 200s with success:false). It used to be fire-and-forget: a trial that
      // did not take went straight on to createBooking and failed
      // YOU_HAVE_NO_CREDITS_LEFT (4 of 16 in 90 days), and Fix & retry bought
      // the trial again. Now a grant that did not happen lands the card on
      // 'failed' with its own reason (failureExplanation) and NOTHING is
      // booked or sent, like every other failed execution. The grant is
      // written ahead on details.trial_grant (below), so a retry does not buy
      // over a recorded grant, nor over a purchase whose answer was never
      // recorded unless credits show. glofoxFetch never re-sends the purchase
      // after a 5xx (GLOFOXPOSTRETRY.1): a 5xx is outcome_unknown, like no reply.
      let grantFailure = null
      if (approvalGrantsTrialCredit(details)) {
        const { grantTrialBeforeBooking } = await import('@/lib/agent/trial-grant')
        // Write-ahead (review of TRIALGRANT.1): the grant reaches the row
        // BEFORE the purchase ({ stage: 'purchasing' }) and again with its
        // outcome, before any booking, instead of only in the final update.
        // Guarded on THIS execution's started_at and judged on the row it
        // touched, so a write that lands nowhere is "not recorded" and the
        // helper buys nothing.
        const executionStartedAt = details?.execution?.started_at || null
        const recordTrialGrant = async (trialGrant) => {
          if (!executionStartedAt) return false
          const { data, error } = await db.from('agent_membership_requests')
            .update({ details: { ...details, trial_grant: trialGrant }, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('details->execution->>started_at', executionStartedAt)
            .select('id')
            .maybeSingle()
          if (error) {
            logWarn('agent-requests', 'trial grant record write failed', { requestId: id, err: error })
            return false
          }
          return !!data
        }
        const grant = await grantTrialBeforeBooking(db, {
          record: recordTrialGrant,
          creds,
          locationId: row.location_id,
          memberId: contact.glofox_member_id,
          priorGrant: details?.trial_grant || null,
          isRetry: isRetry || isFailedRetry,
          requestId: id,
          // The funnel block's own trial, stamped on the card by routeToReview.
          trialOverride: { membershipId: details?.trial_membership_id || null, planCode: details?.trial_plan_code || null },
        })
        details = { ...details, trial_grant: grant.grant }
        if (!grant.proceed) grantFailure = grant.failure
      }
      if (grantFailure) {
        executed = { ...grantFailure, trial_grant: details.trial_grant }
        details = { ...details, result: executed }
        finalStatus = 'failed'
      } else {
        const result = await createBooking(creds, {
          user_id: contact.glofox_member_id,
          model: GLOFOX_BOOKING_MODEL,
          model_id: details.event_id,
        })
        // Glofox can 200 with a failure body (YOU_HAVE_NO_CREDITS_LEFT) —
        // success needs the created booking id, not just HTTP ok. alreadyBooked
        // counts as success: the member IS in the class (MIA-BOOK.1 — staff may
        // have booked them manually before approving a fallback card).
        const { booked, bookingId, messageCode, alreadyBooked } = interpretBookingResult(result)
        const success = booked || alreadyBooked
        executed = {
          ok: success, status: result.status, message_code: messageCode, glofox_booking_id: bookingId,
          // GLOFOXPOSTRETRY.1 — Glofox answered 5xx and a read found the booking.
          ...(result.recovered ? { recovered: result.recovered } : {}),
          // TRIALGRANT.1 — the card's failure copy must know a trial was just
          // added: a no-credits refusal then means it starts later.
          ...(details.trial_grant ? { trial_grant: details.trial_grant } : {}),
        }
        details = { ...details, result: executed }
        finalStatus = success ? 'actioned' : 'failed'

        // Close the loop with the customer in-thread — best-effort.
        if (success && row.conversation_id) {
          try {
            const { sendAgentThreadMessage, buildBookingConfirmationText } = await import('@/lib/agent/notify')
            await sendAgentThreadMessage(db, {
              channel: row.channel,
              conversationId: row.conversation_id,
              text: buildBookingConfirmationText({
                className: details.class_name,
                classTime: details.class_time,
                template: await confirmationTemplate('booking'),
              }),
            })
          } catch (e) {
            console.warn(`[agent-requests] confirmation send error: ${e?.message || e}`)
          }
        }
      }
    }

    // /start-funnel class bookings: keep the class_booking_requests queue row in
    // sync (otherwise it's stuck in 'needs_review' forever) and — because these
    // public leads have no agent conversation thread — send them the public
    // booking_class_confirmed WhatsApp directly. Best-effort.
    if (details?.source === 'start_funnel') {
      try {
        const cbrStatus = finalStatus === 'actioned' ? 'booked' : 'failed'
        await db.from('class_booking_requests')
          .update({ status: cbrStatus, last_error: finalStatus === 'actioned' ? null : (executed?.message_code || 'approval_book_failed') })
          .eq('approval_request_id', id)
      } catch (e) { console.warn(`[agent-requests] cbr sync error: ${e?.message || e}`) }
      if (finalStatus === 'actioned' && !row.conversation_id) {
        try {
          const { data: c } = await db.from('contacts').select('id, first_name, name, phone, wa_phone').eq('id', row.contact_id).maybeSingle()
          if (c) {
            const { maybeSendBookingWhatsappConfirm, CLASS_CONFIRM_TEMPLATE } = await import('@/lib/automations/booking-whatsapp-confirm')
            const firstName = c.first_name || (c.name ? c.name.split(' ')[0] : '') || 'there'
            await maybeSendBookingWhatsappConfirm({ db, locationId: row.location_id, contact: c, templateName: CLASS_CONFIRM_TEMPLATE, bodyParams: [firstName, details.class_name || 'your class', details.class_time || ''] })
          }
        } catch (e) { console.warn(`[agent-requests] cbr confirm error: ${e?.message || e}`) }
      }
    }
  }

  // CANCEL-FORM.5 — approving a membership cancellation executes the Glofox
  // cancel when the location opted in. Result codes are explained on the
  // card (agent-request-why.js); a failure lands on 'failed' and rides the
  // same fix-&-retry lane as bookings (RETRYABLE_KINDS).
  let membershipContact = null
  if (executing && row.kind === 'cancellation') {
    const { executeMembershipCancellation } = await import('@/lib/agent/execute-membership-cancellation')
    const { glofoxCredentialsForLocation } = await import('@/lib/glofox')
    const { data: contact } = await db.from('contacts')
      .select('id, first_name, name, email, email_status, glofox_member_id, glofox_user_membership_id, glofox_membership_plan')
      .eq('id', row.contact_id)
      .maybeSingle()
    membershipContact = contact || null
    const creds = await glofoxCredentialsForLocation(db, row.location_id)
    const result = await executeMembershipCancellation(db, { ...row, details }, { contact: membershipContact, creds })
    executed = {
      ok: result.ok,
      status: result.status ?? null,
      message_code: result.message_code ?? null,
      local_planned_end_date: result.local_planned_end_date ?? null,
    }
    details = { ...details, result: executed }
    finalStatus = result.ok ? 'actioned' : 'failed'
  }

  // CANCEL-FORM.5 — tell the member what was decided, on the channel the
  // request arrived by. Approve / actioned / saved always; declined only for
  // an email-delivered row (thread rows keep the in-thread notice below).
  // Best-effort: the decision is already recorded, and the card shows
  // whether the member heard.
  let customerNotified = null
  const notifyMember = isMembershipKind && (
    ['approved', 'actioned', 'saved'].includes(finalStatus)
    || (finalStatus === 'declined' && !row.conversation_id && row.channel === 'email')
  )
  if (notifyMember) {
    try {
      const { sendMembershipOutcomeMessage } = await import('@/lib/cancellation-form/confirm')
      const { resolveCancellationFormCopy } = await import('@/lib/cancellation-form/copy')
      if (!membershipContact && row.contact_id) {
        const { data: contact } = await db.from('contacts')
          .select('id, first_name, name, email, email_status, glofox_member_id, glofox_user_membership_id, glofox_membership_plan')
          .eq('id', row.contact_id)
          .maybeSingle()
        membershipContact = contact || null
      }
      customerNotified = await sendMembershipOutcomeMessage(db, {
        row: { ...row, details },
        finalStatus,
        endDate: details?.result?.local_planned_end_date || details?.requested_end_date || null,
        contact: membershipContact,
        copy: resolveCancellationFormCopy(locationRow?.settings?.customer_agent?.cancellation_form),
        locationName: locationRow?.name || '',
        declineTemplate: finalStatus === 'declined' ? await confirmationTemplate('decline') : null,
      })
    } catch (e) {
      console.warn(`[agent-requests] membership outcome message error: ${e?.message || e}`)
      customerNotified = { sent: false, channel: row.channel || null, reason: 'send_error' }
    }
  } else if (isMembershipKind) {
    customerNotified = { sent: false, channel: row.channel || null, reason: finalStatus === 'failed' ? 'not_executed' : 'not_applicable' }
  }
  // MANUALCONFIRM.1 — the manual booking's email result rides the same field.
  if (manualNotified) customerNotified = manualNotified

  // APPROVALS-STUDIO.1 — a decline is never silence: tell the customer
  // in-thread (operator-editable approval_decline_text). Best-effort; only
  // for requests that came from a live conversation (funnel rows without a
  // thread have no message window to use).
  if (v.data.status === 'declined' && row.conversation_id) {
    try {
      const { sendAgentThreadMessage, buildDeclineNoticeText } = await import('@/lib/agent/notify')
      await sendAgentThreadMessage(db, {
        channel: row.channel,
        conversationId: row.conversation_id,
        text: buildDeclineNoticeText({ template: await confirmationTemplate('decline') }),
      })
    } catch (e) {
      console.warn(`[agent-requests] decline notice send error: ${e?.message || e}`)
    }
  }

  // The claim above owns decided_by/decided_at/decision_note; this only
  // persists the execution outcome (finalStatus === v.data.status when
  // nothing executed — harmless rewrite of the claimed value). The execution
  // marker is closed out here: a row still reading 'executing' after this
  // point is one whose request died mid-flight (MIA-REVIEW.3).
  const finishedIso = new Date().toISOString()
  const { data, error } = await db.from('agent_membership_requests').update({
    status: finalStatus,
    details: executing ? finishedMarker(details, { finishedAt: finishedIso }) : details,
    updated_at: finishedIso,
  }).eq('id', id).select('id, status, decided_at, decision_note, details').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  const plannedEndDate = isMembershipKind
    ? (details?.result?.local_planned_end_date || details?.requested_end_date || details?.end_date || null)
    : null
  return NextResponse.json({ success: true, request: data, executed, customer_notified: customerNotified, planned_end_date: plannedEndDate })
}
