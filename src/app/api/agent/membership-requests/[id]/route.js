import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

// PATCH /api/agent/membership-requests/[id] — manager decides a queued
// agent request. 'approved' + 'declined' apply to every kind; 'saved'
// is the retention outcome on a cancellation (member kept).
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

const DecisionSchema = z.object({
  status: z.enum(['approved', 'declined', 'saved', 'actioned']),
  decision_note: z.string().max(2000).nullable().optional(),
})

export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()

  // Confirm the request belongs to a location this manager can act on.
  const { data: row } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, status, details, contact_id, channel, conversation_id')
    .eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // null = master
  if (allowed !== null && !allowed.includes(row.location_id)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const v = await validateBody(request, DecisionSchema)
  if (!v.ok) return v.response

  let finalStatus = v.data.status
  let details = row.details || {}
  let executed = null

  // AGENT-EVENTS.3 — approving a drafted PAID-entry cancellation
  // executes it. The refund (if any) stays a human decision processed
  // manually in Revolut Business — this only frees the spot.
  if (v.data.status === 'approved' && row.kind === 'event_cancellation' && row.status === 'pending') {
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
          text: buildCancellationConfirmationText({ className: details.event_name, classTime: details.event_date }),
        })
      } catch (e) {
        console.warn(`[agent-requests] event cancellation confirmation send error: ${e?.message || e}`)
      }
    }
  }

  // AGENT-EVENTS.2 — approving a drafted event booking executes it.
  if (v.data.status === 'approved' && row.kind === 'event_booking' && row.status === 'pending') {
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
            text: buildBookingConfirmationText({ className: details.event_name, classTime: details.event_date }),
          })
        } catch (e) {
          console.warn(`[agent-requests] event confirmation send error: ${e?.message || e}`)
        }
      }
    }
  }

  // AGENT-CANCEL.1 — approving a drafted cancellation executes it.
  if (v.data.status === 'approved' && row.kind === 'class_cancellation' && row.status === 'pending') {
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, cancelBooking } =
      await import('@/lib/glofox')
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', row.contact_id)
      .maybeSingle()
    const creds = await glofoxCredentialsForLocation(db, row.location_id)
    if (!contact?.glofox_member_id || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else {
      const result = await cancelBooking(creds, details.booking_id, contact.glofox_member_id)
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
            }),
          })
        } catch (e) {
          console.warn(`[agent-requests] cancellation confirmation send error: ${e?.message || e}`)
        }
      }
    }
  }

  // AGENT-HANDS.1 — approving a drafted class booking executes it.
  if (v.data.status === 'approved' && row.kind === 'class_booking' && row.status === 'pending') {
    const { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, createBooking, GLOFOX_BOOKING_MODEL } =
      await import('@/lib/glofox')
    const { data: contact } = await db.from('contacts')
      .select('glofox_member_id')
      .eq('id', row.contact_id)
      .maybeSingle()
    const creds = await glofoxCredentialsForLocation(db, row.location_id)
    if (!contact?.glofox_member_id || !creds || missingGlofoxCredentialsForLocation(creds).length) {
      finalStatus = 'failed'
      details = { ...details, result: { ok: false, message_code: 'NOT_EXECUTABLE' } }
    } else {
      const result = await createBooking(creds, {
        user_id: contact.glofox_member_id,
        model: GLOFOX_BOOKING_MODEL,
        model_id: details.event_id,
      })
      const messageCode = result?.body?.message_code || result?.body?.message || null
      executed = { ok: result.ok, status: result.status, message_code: messageCode }
      details = { ...details, result: executed }
      finalStatus = result.ok ? 'actioned' : 'failed'

      // Close the loop with the customer in-thread — best-effort.
      if (result.ok && row.conversation_id) {
        try {
          const { sendAgentThreadMessage, buildBookingConfirmationText } = await import('@/lib/agent/notify')
          await sendAgentThreadMessage(db, {
            channel: row.channel,
            conversationId: row.conversation_id,
            text: buildBookingConfirmationText({
              className: details.class_name,
              classTime: details.class_time,
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
            const { maybeSendBookingWhatsappConfirm } = await import('@/lib/automations/booking-whatsapp-confirm')
            const firstName = c.first_name || (c.name ? c.name.split(' ')[0] : '') || 'there'
            await maybeSendBookingWhatsappConfirm({ db, locationId: row.location_id, contact: c, templateName: 'booking_class_confirmed', bodyParams: [firstName, details.class_name || 'your class', details.class_time || ''] })
          }
        } catch (e) { console.warn(`[agent-requests] cbr confirm error: ${e?.message || e}`) }
      }
    }
  }

  const { data, error } = await db.from('agent_membership_requests').update({
    status: finalStatus,
    details,
    decision_note: v.data.decision_note?.trim() || null,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select('id, status, decided_at, decision_note, details').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, request: data, executed })
}
