import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { hasPermissionForLocation } from '@/lib/permissions'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import {
  EXECUTING_KINDS,
  stuckExecutionStartedAt,
  isRetryableFailure,
  executingMarker,
  finishedMarker,
} from '@/lib/agent/request-recovery'

// PATCH /api/agent/membership-requests/[id] — staff decides a queued
// agent request. Decision rights follow the comms surface (any staff
// at the request's location — INBOX-APPROVALS, Richard 2026-07-03).
// 'approved' + 'declined' apply to every kind; 'saved' is the
// retention outcome on a cancellation (member kept).
//
// Pause/cancel: the actual Glofox change is made by staff manually
// after approving (the Glofox API can't fully automate those yet).
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
})

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
  const executing = v.data.status === 'approved' && EXECUTING_KINDS.has(row.kind)
  const claimPatch = {
    status: v.data.status,
    decision_note: v.data.decision_note?.trim() || null,
    decided_by: user.id,
    decided_at: nowIso,
    updated_at: nowIso,
  }
  if (executing) claimPatch.details = executingMarker(row.details, { startedAt: nowIso, by: user.id })

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
    if (!executingMemberId || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else {
      const result = await cancelBooking(creds, details.booking_id, executingMemberId)
      const messageCode = result?.body?.message_code || result?.body?.message || null
      executed = { ok: result.ok, status: result.status, message_code: messageCode }
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
  // funnel rows always have one, legacy Mia-thread rows may not.
  let expiredBeforeExecution = false
  if (executing && row.kind === 'class_booking') {
    const startsAtMs = Date.parse(row.details?.starts_at || '')
    if (Number.isFinite(startsAtMs) && startsAtMs < Date.now()) {
      expiredBeforeExecution = true
      finalStatus = 'expired'
      details = { ...details, result: { ok: false, reason: 'CLASS_ALREADY_STARTED' } }
      executed = { ok: false, reason: 'CLASS_ALREADY_STARTED' }
      // The customer hears the apology, not silence — best-effort, threaded
      // requests only (funnel rows without a conversation have no window).
      if (row.conversation_id) {
        try {
          const { sendAgentThreadMessage, buildBookingExpiredText } = await import('@/lib/agent/notify')
          await sendAgentThreadMessage(db, {
            channel: row.channel,
            conversationId: row.conversation_id,
            text: buildBookingExpiredText({
              className: details.class_name,
              classTime: details.class_time,
              template: await confirmationTemplate('expired'),
            }),
          })
        } catch (e) {
          console.warn(`[agent-requests] expiry notice send error: ${e?.message || e}`)
        }
      }
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

  // AGENT-HANDS.1 — approving a drafted class booking executes it.
  if (executing && row.kind === 'class_booking' && !expiredBeforeExecution) {
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, interpretBookingResult, GLOFOX_BOOKING_MODEL } =
      await import('@/lib/glofox')
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', row.contact_id)
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
    if (!contact?.glofox_member_id || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else if (accountMismatch) {
      executed = { ok: false, message_code: 'ACCOUNT_MISMATCH' }
      details = { ...details, result: executed }
      finalStatus = 'failed'
      console.warn(`[agent-requests] refused execution ${id}: elected account ${electedMemberId} no longer matches contact ${row.contact_id}`)
    } else {
      // If the processor sent this for a credit grant (existing account with no
      // live credits), grant the trial class credit BEFORE booking — otherwise
      // Glofox rejects on no-credits and staff could never complete it.
      if (details?.reason === 'needs_credit_grant') {
        try {
          const { purchaseGlofoxMembership } = await import('@/lib/glofox')
          const { getGlofoxConfig } = await import('@/lib/connection-registry')
          // INTEG-A2 dual-read: registry config first, legacy settings.glofox otherwise.
          const g = await getGlofoxConfig(db, row.location_id)
          if (g.trial_membership_id && g.trial_plan_code) {
            await purchaseGlofoxMembership(creds, contact.glofox_member_id, g.trial_membership_id, g.trial_plan_code)
          }
        } catch (e) { console.warn(`[agent-requests] trial grant error: ${e?.message || e}`) }
      }
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
      executed = { ok: success, status: result.status, message_code: messageCode, glofox_booking_id: bookingId }
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
  return NextResponse.json({ success: true, request: data, executed })
}
