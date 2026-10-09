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
import { formatMoneyMinor } from '@/lib/money-format'

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

// MIA-EXPIRY-QUIET.1 (2026-08-31) — there is deliberately NO expired-booking
// text here. A booking that outlived its class expires silently to the
// member: the sweep and the past-start guard alert staff and stop. The old
// DEFAULT_BOOKING_EXPIRED_TEXT / buildBookingExpiredText pair and the
// booking_expired_text setting that overrode it were removed with the send.

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

// EVENT-MOVE.7 — in-thread texts once staff decide Mia's event_move request.
// Operator-editable (settings.customer_agent.event_move_confirmation_text /
// .event_move_failed_text); these are the fallbacks. {event} renders the new
// event, date and time; {reason} a plain reason. Two sentences are added by
// code, not the template, because they depend on what happened: the tickets
// line only when the moved email went, and the difference line only when the
// new date costs more (the team sends a link for it: EVENT-MOVE.5). A cheaper
// date is never mentioned (a move never refunds). Never a count.
export const DEFAULT_EVENT_MOVE_CONFIRMATION_TEXT = 'Done, your entry is now on {event}.'
export const DEFAULT_EVENT_MOVE_FAILED_TEXT = 'We could not move your entry: {reason}. The team will be in touch.'

// MOVE_ERRORS (registration-entry.js) in the customer's words. The staff
// copy (MOVE_ERROR_MESSAGES) talks about wave selects and reloading; this
// never names a number.
export const EVENT_MOVE_FAILURE_REASONS = Object.freeze({
  not_found: 'we could not find the entry',
  not_active: 'the entry is no longer active',
  checked_in: 'the entry has already been checked in',
  same_event: 'the entry is already on that date',
  target_unavailable: 'that date is no longer available',
  different_payee: 'that date is no longer available',
  already_entered: 'there is already an entry for you on that date',
  headcount_not_allowed: 'that date does not take an entry of this size',
  wave_required: 'that date needs a time picked',
  wrong_event: 'that time is no longer available',
  wave_full: 'that time is now full',
  load_failed: 'something went wrong on our side',
  write_failed: 'something went wrong on our side',
  conflict: 'the entry changed in the meantime',
  pending_payment: 'the entry needs to be paid first',
})
const EVENT_MOVE_FALLBACK_REASON = 'something went wrong on our side'

/** Confirmation once an approved event move went through. Pure. */
export function buildEventMoveConfirmationText({ eventName, dateLabel, timeLabel, notified, priceGapCents, currency = 'EUR', template } = {}) {
  const when = [dateLabel, timeLabel].filter(Boolean).join(' at ')
  const what = [eventName, when].filter(Boolean).join(', ') || 'the new date'
  const base = String(template || '').trim() || DEFAULT_EVENT_MOVE_CONFIRMATION_TEXT
  const parts = [base.replace(/\{event\}/g, what)]
  if (notified) parts.push('New tickets are on their way by email.')
  const gap = Number(priceGapCents) || 0
  if (gap > 0) parts.push(`The team will send a link for the ${formatMoneyMinor(gap, currency || 'EUR')} difference.`)
  return stripEmDashes(parts.join(' ')).trim()
}

/** In-thread text when an approved event move was refused. Pure. */
export function buildEventMoveFailedText({ error, template } = {}) {
  const reason = EVENT_MOVE_FAILURE_REASONS[error] || EVENT_MOVE_FALLBACK_REASON
  const base = String(template || '').trim() || DEFAULT_EVENT_MOVE_FAILED_TEXT
  return stripEmDashes(base.replace(/\{reason\}/g, reason)).trim()
}

/**
 * The location's operator-set confirmation copy (null when unset → the
 * defaults above). Best-effort: a read failure just uses the defaults.
 * @returns {Promise<{booking: string|null, cancellation: string|null, decline: string|null, eventMove: string|null, eventMoveFailed: string|null}>}
 */
export async function agentConfirmationTemplates(db, locationId) {
  const none = { booking: null, cancellation: null, decline: null, eventMove: null, eventMoveFailed: null }
  if (!locationId) return none
  try {
    const { data } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    const s = data?.settings?.customer_agent || {}
    return {
      booking: String(s.booking_confirmation_text || '').trim() || null,
      cancellation: String(s.cancellation_confirmation_text || '').trim() || null,
      decline: String(s.approval_decline_text || '').trim() || null,
      eventMove: String(s.event_move_confirmation_text || '').trim() || null,
      eventMoveFailed: String(s.event_move_failed_text || '').trim() || null,
    }
  } catch {
    return none
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

      // WAREPLYNUMBER.1 (C86) — from the number this thread was written to.
      const result = await sendTextMessage(phone, text, { locationId: conversation.location_id, replyInConversation: conversation.id })
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
