// AGENT-HANDS.1 — agent-originated thread messages OUTSIDE the live
// reply loop. First user: the booking confirmation sent into the
// originating WhatsApp/Instagram thread when a staffer approves a
// drafted class booking (the approval executes the booking; this
// closes the loop with the customer so staff touch one button total).
//
// Mirrors the operator send routes' mechanics: WA respects the 24h
// window (requests are fresh so it's almost always open — a closed
// window returns sent:false and the staffer follows up manually);
// IG resolves the location connection. Both record the outbound
// message row so the thread history is complete. Fail-soft
// throughout — a send hiccup never breaks the approval.

import { stripEmDashes } from './core'

// HUMANIZE.1 — customer-visible copy: no em dashes, no emoji, low-key. Both
// texts are operator-editable (settings.customer_agent.booking_confirmation_text
// / .cancellation_confirmation_text, same settings-field-plus-default pattern as
// holding_message); these are the fallbacks. {class} is the only placeholder:
// it renders the class name + time, and when neither is known the "for {class}"
// clause is dropped rather than shipping a dangling "for .".
export const DEFAULT_BOOKING_CONFIRMATION_TEXT =
  "Good news, you're booked in for {class}. See you there."
export const DEFAULT_CANCELLATION_CONFIRMATION_TEXT =
  'All sorted, your booking for {class} has been cancelled. Hope to see you at another class soon.'

// MIA-BOOK.1 — what Mia tells the customer when Glofox rejects a booking for
// an account-shaped reason and the attempt becomes a pending approval.
// Operator-editable (settings.customer_agent.booking_issue_handoff_text).
export const DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT =
  "There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved."

// APPROVALS-STUDIO.1 — sent in-thread when staff decline a customer
// request, so a decline is never silence. Operator-editable
// (settings.customer_agent.approval_decline_text).
export const DEFAULT_APPROVAL_DECLINE_TEXT =
  "Sorry, we couldn't complete that request this time. The team will be in touch to help."

// MIA-BOARD.2 — sent when a pending booking outlives its class (the sweep
// expires it, or the execution guard refuses a past-start approval). Copy
// approved by Richard 2026-08-20; operator-editable
// (settings.customer_agent.booking_expired_text).
export const DEFAULT_BOOKING_EXPIRED_TEXT =
  "Sorry, we didn't get to confirm your booking for {class} in time. That one's on us. The team will be in touch to make it right."

/** In-thread apology once a pending booking expires past its class start. */
export function buildBookingExpiredText({ className, classTime, template } = {}) {
  return renderConfirmation(
    String(template || '').trim() || DEFAULT_BOOKING_EXPIRED_TEXT,
    className, classTime,
  )
}

/** In-thread text once staff decline a customer approval request. */
export function buildDeclineNoticeText({ template } = {}) {
  return stripEmDashes(String(template || '').trim() || DEFAULT_APPROVAL_DECLINE_TEXT).trim()
}

function renderConfirmation(template, className, classTime) {
  const what = [className, classTime].filter(Boolean).join(', ')
  const base = String(template || '').trim()
  const filled = what
    ? base.replace(/\{class\}/g, what)
    : base.replace(/\s*\bfor\s+\{class\}/gi, '').replace(/\s*\{class\}/g, '')
  return stripEmDashes(filled).trim()
}

/**
 * Friendly booking-confirmed text. Pure — unit-tested.
 * @param {{className?:string, classTime?:string, template?:string|null}} [args]
 *   template = the operator's booking_confirmation_text, if set.
 */
export function buildBookingConfirmationText({ className, classTime, template } = {}) {
  return renderConfirmation(
    String(template || '').trim() || DEFAULT_BOOKING_CONFIRMATION_TEXT,
    className, classTime,
  )
}

/** AGENT-CANCEL.1 — in-thread confirmation once an approved cancellation executes. */
export function buildCancellationConfirmationText({ className, classTime, template } = {}) {
  return renderConfirmation(
    String(template || '').trim() || DEFAULT_CANCELLATION_CONFIRMATION_TEXT,
    className, classTime,
  )
}

/**
 * The location's operator-set confirmation copy (null when unset → the
 * defaults above). Best-effort: a read failure just uses the defaults.
 * @returns {Promise<{booking: string|null, cancellation: string|null}>}
 */
export async function agentConfirmationTemplates(db, locationId) {
  if (!locationId) return { booking: null, cancellation: null, decline: null, expired: null }
  try {
    const { data } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    const s = data?.settings?.customer_agent || {}
    return {
      booking: String(s.booking_confirmation_text || '').trim() || null,
      cancellation: String(s.cancellation_confirmation_text || '').trim() || null,
      decline: String(s.approval_decline_text || '').trim() || null,
      expired: String(s.booking_expired_text || '').trim() || null,
    }
  } catch {
    return { booking: null, cancellation: null, decline: null, expired: null }
  }
}

/**
 * Send `text` into an agent conversation thread.
 * @returns {{ sent: boolean, reason?: string }}
 */
export async function sendAgentThreadMessage(db, { channel, conversationId, text: rawText }) {
  if (!conversationId || !rawText) return { sent: false, reason: 'missing_args' }
  // This path never goes through parseAgentResponse, so the em-dash scrub the
  // live reply loop relies on has to happen here — every customer-bound agent
  // message gets the same deterministic treatment.
  const text = stripEmDashes(rawText)
  try {
    if (channel === 'whatsapp') {
      const { data: conversation } = await db.from('whatsapp_conversations')
        .select('id, location_id, wa_phone, window_expires_at, contact_id, contacts!contact_id ( id, wa_phone )')
        .eq('id', conversationId)
        .maybeSingle()
      if (!conversation) return { sent: false, reason: 'conversation_not_found' }
      const phone = conversation.contacts?.wa_phone || conversation.wa_phone
      if (!phone) return { sent: false, reason: 'no_phone' }

      const { sendTextMessage, isWindowOpen } = await import('@/lib/whatsapp')
      if (!isWindowOpen(conversation)) return { sent: false, reason: 'window_closed' }

      const result = await sendTextMessage(phone, text, { locationId: conversation.location_id })
      // source='agent' (allowed since mig 259) so the agent sees this
      // confirmation in its own history and it counts toward the caps.
      const { error: insertError } = await db.from('whatsapp_messages').insert({
        conversation_id: conversationId,
        contact_id: conversation.contact_id || null,
        location_id: conversation.location_id,
        wa_message_id: result?.messageId || null,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        source: 'agent',
        sent_at: new Date().toISOString(),
      })
      if (insertError) console.error('[agent][notify] failed to record WhatsApp confirmation (history will be incomplete):', insertError.message)
      return { sent: true }
    }

    if (channel === 'instagram') {
      const { data: conversation } = await db.from('instagram_conversations')
        .select('id, location_id, ig_user_id, contact_id')
        .eq('id', conversationId)
        .maybeSingle()
      if (!conversation) return { sent: false, reason: 'conversation_not_found' }
      if (!conversation.ig_user_id) return { sent: false, reason: 'no_recipient' }

      const { resolveChannelConnection } = await import('./channels')
      const conn = await resolveChannelConnection(conversation.location_id, 'instagram', db)
      if (!conn?.access_token) return { sent: false, reason: 'no_connection' }

      const { sendInstagramMessage } = await import('./instagram')
      // Full row (not just the token) so the send uses the explicit account
      // id and stamps connection health (INTEG-A3).
      const result = await sendInstagramMessage(conversation.ig_user_id, text, {
        connection: conn,
      })
      const { error: insertError } = await db.from('instagram_messages').insert({
        conversation_id: conversationId,
        contact_id: conversation.contact_id || null,
        location_id: conversation.location_id,
        ig_message_id: result?.messageId || null,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        source: 'agent',
        sent_at: new Date().toISOString(),
      })
      if (insertError) console.error('[agent][notify] failed to record Instagram confirmation (history will be incomplete):', insertError.message)
      return { sent: true }
    }

    return { sent: false, reason: 'unknown_channel' }
  } catch (e) {
    console.warn(`[agent][notify] thread message failed: ${e?.message || e}`)
    return { sent: false, reason: 'send_error' }
  }
}
