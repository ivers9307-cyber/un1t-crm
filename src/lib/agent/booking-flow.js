// MIAFLOW.1 — Mia sends the studio's booking Flow instead of a link.
//
// At a studio where Mia cannot book classes in chat (un1t.online at Hatch
// Street outside tool block 3b, or no booking system) and whose WhatsApp
// booking Flow is switched on
// (locations.settings.whatsapp_flow: enabled true and a flow_id), a WhatsApp
// turn with a linked contact is OFFERED send_booking_flow (bookingFlowOffered;
// auto-reply.js picks the block's Flow variant). Calling it drops the same
// in-session interactive Flow message the staff inbox "Send booking flow"
// route sends (sendFlowMessage, from the number this thread was written to),
// with THE flow_token (flowTokenFor(contactId, locationId)), so the Flow's
// data-exchange endpoint resolves the contact and the studio exactly as for
// the webhook and the paid-ad welcome.
//
// The result is the truth about the send, never a guess: sent true only once
// Meta accepted it. Every other outcome sends nothing and hands the model the
// booking link (today's behaviour): not offered this turn, no contact on the
// thread, the 24h window closed, a Flow already sent on this thread in the
// last 10 minutes (then the model points back to it), an unreadable read, or
// a failed send (logged structurally). A Glofox studio (Stillorgan, where Mia
// books in chat) is never offered the tool, so its request is unchanged, and
// neither is block 3b (`un1t_full`, Ruling 24): there a known Hatch member
// books in chat; leads, unknown senders, members with no un1t.online account
// and the Mia switch off keep the Flow.
//
// The line on the Flow message is operator-editable copy (booking_flow_text,
// default in default-copy.js); no em or en dashes anywhere a customer reads.
import { flowTokenFor } from '@/lib/whatsapp-flow/config'
import { logError } from '@/lib/log'
import { renderMiaCopy } from './mia-copy'
import { AGENT_MESSAGE_SOURCE } from './core'
import { BOOKING_FLOW_PROMPT_SECTION } from './prompt'

const LOG = 'mia-booking-flow'

export const SEND_BOOKING_FLOW_TOOL_NAME = 'send_booking_flow'

/** A Flow sent on the thread inside this span is not sent again. */
export const RECENT_FLOW_MS = 10 * 60 * 1000

export const SEND_BOOKING_FLOW_TOOL = Object.freeze({
  name: SEND_BOOKING_FLOW_TOOL_NAME,
  description:
    "Send this studio's booking form into the WhatsApp chat: a message with a button that opens the form, " +
    'where the customer picks a class and books it themselves. Use it whenever someone wants to book a class at ' +
    'this studio, instead of sending the booking link. It takes no input. The result says whether the form was ' +
    'really sent. sent true: it is in the chat now, so reply in one short line telling them to tap the button to ' +
    'pick a class and book it, with no link. already_sent true: a form was sent in this chat a few minutes ago, so ' +
    'point them back to it and send nothing else. sent false: nothing was sent, so never say it was, and follow ' +
    'your booking rules instead (the booking link, or the team).',
  input_schema: Object.freeze({ type: 'object', properties: Object.freeze({}) }),
})

// The prompt section that goes with the tool lives in prompt.js (a leaf
// module with no imports); re-exported here beside the tool it describes.
export { BOOKING_FLOW_PROMPT_SECTION }

/**
 * Is send_booking_flow offered on this turn? WhatsApp only (a Flow is a
 * WhatsApp message), only where Mia cannot book in chat (`canBook` false: the
 * thread's studio takes no bookings through her tools), never in the Glofox
 * block nor in block 3b (`un1t_full`, Ruling 24: the member books in chat),
 * only where the studio's Flow is switched on with an id, and only with a
 * contact on the thread (the token books against it). Pure.
 */
export function bookingFlowOffered({ channel, canBook, block, flowConfig, contactId } = {}) {
  return channel === 'whatsapp'
    && canBook === false
    && block !== 'glofox'
    && block !== 'un1t_full'
    && flowConfig?.enabled === true
    && !!String(flowConfig?.flow_id || '').trim()
    && !!contactId
}

function notSent(reason, settings) {
  const link = String(settings?.booking_url || '').trim() || null
  return {
    sent: false,
    reason,
    link,
    message: link
      ? `The booking form was not sent, so never say it was. Send the studio's booking link instead: ${link}`
      : 'The booking form was not sent, so never say it was. Hand the customer to the team to book.',
  }
}

/**
 * Execute send_booking_flow. ctx: { db, conversationId, locationId, channel,
 * settings (Mia's resolved settings), bookingFlow: { offered, config } }.
 * Never throws: every failure is a sent:false result.
 */
export async function executeSendBookingFlow(ctx) {
  const { db, conversationId, locationId, settings } = ctx || {}
  const config = ctx?.bookingFlow?.config || null
  if (ctx?.channel !== 'whatsapp' || ctx?.bookingFlow?.offered !== true || !config?.flow_id) {
    return notSent('not_available', settings)
  }

  let conversation
  try {
    const { data, error } = await db.from('whatsapp_conversations')
      .select('id, location_id, contact_id, wa_phone, window_expires_at')
      .eq('id', conversationId)
      .maybeSingle()
    if (error) {
      logError(LOG, 'conversation read failed; no Flow sent', { conversationId, locationId, err: error.message })
      return notSent('conversation_unreadable', settings)
    }
    conversation = data
  } catch (err) {
    logError(LOG, 'conversation read threw; no Flow sent', { conversationId, locationId, err: err?.message })
    return notSent('conversation_unreadable', settings)
  }
  if (!conversation) return notSent('conversation_not_found', settings)

  // The token books against the thread's contact, as the staff route does.
  const flowToken = flowTokenFor(conversation.contact_id, locationId)
  if (!flowToken) return notSent('no_contact', settings)
  if (!conversation.wa_phone) return notSent('no_phone', settings)
  // Same rule as isWindowOpen (src/lib/whatsapp.js): an interactive message is
  // a session message, refused outside the 24h window.
  const expiresMs = Date.parse(conversation.window_expires_at || '')
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return notSent('window_closed', settings)

  // One Flow per thread per RECENT_FLOW_MS, whoever sent it (Mia or staff). An
  // unreadable answer is never "none": the customer still gets the link.
  try {
    const { data: recent, error } = await db.from('whatsapp_messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('direction', 'outbound')
      .eq('message_type', 'flow')
      .gte('sent_at', new Date(Date.now() - RECENT_FLOW_MS).toISOString())
      .limit(1)
    if (error) {
      logError(LOG, 'recent Flow read failed; no Flow sent', { conversationId, locationId, err: error.message })
      return notSent('recent_check_failed', settings)
    }
    if (Array.isArray(recent) && recent.length > 0) {
      return {
        sent: false,
        already_sent: true,
        message: 'A booking form was already sent in this chat a few minutes ago, so nothing new was sent. ' +
          'Point them back to it (the button just above) and do not send the booking link.',
      }
    }
  } catch (err) {
    logError(LOG, 'recent Flow read threw; no Flow sent', { conversationId, locationId, err: err?.message })
    return notSent('recent_check_failed', settings)
  }

  const text = renderMiaCopy('booking_flow_text', settings)
  let sendResult
  try {
    const { sendFlowMessage } = await import('@/lib/whatsapp')
    sendResult = await sendFlowMessage(conversation.wa_phone, {
      locationId,
      // WAREPLYNUMBER.1 (C86) — from the number this thread was written to.
      replyInConversation: conversation.id,
      flowId: config.flow_id,
      flowToken,
      flowCta: config.cta_text || undefined,
      bodyText: text,
    })
  } catch (err) {
    // WACONFIGFALLBACK.1 — a studio with no number switched on refuses here too.
    logError(LOG, 'Flow send failed; Mia falls back to the booking link', {
      conversationId, locationId, errClass: err?.name || null, err: err?.message || String(err),
    })
    return notSent('send_failed', settings)
  }

  // Meta accepted it: the customer has it. A lost thread row never un-sends it
  // (CLAUDE.md: a silent failure must never become a louder one); logged.
  try {
    const { error } = await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      location_id: locationId,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'flow',
      body: `[Booking Flow] ${text}`,
      status: 'sent',
      source: AGENT_MESSAGE_SOURCE,
      sent_at: new Date().toISOString(),
    })
    if (error) {
      logError(LOG, 'thread row insert failed after Meta accepted the Flow', {
        conversationId, locationId, waMessageId: sendResult?.messageId || null, err: error.message,
      })
    }
  } catch (err) {
    logError(LOG, 'thread row insert threw after Meta accepted the Flow', {
      conversationId, locationId, waMessageId: sendResult?.messageId || null, err: err?.message,
    })
  }

  return {
    sent: true,
    text,
    message: `The booking form is in the chat now, with the line "${text}" above its button. ` +
      'Reply in one short line telling them to tap the button to pick a class and book it. Do not send the booking link.',
  }
}
