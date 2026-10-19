// UN1TWRITE.21 — the seam spec E (Mia at Hatch) fills; MIAHATCH.6 (Task 25)
// fills it. The funnel processor calls trialUsedHandoff when a person asked
// for a class but has already had the free trial, and the trial-used email
// asks trialUsedOptionsText for its {options}. D's signatures are unchanged.
//
//   trialUsedOptionsText   the studio's sellable offers, one "{title},
//                          {price_label}" line each, in staff order: exactly
//                          what Mia offers (listPurchaseOptions, so an
//                          inactive or €0 product is skipped as she skips
//                          it). Never capacity, never a link. Null when there
//                          are none or they cannot be read (D's email then
//                          says DEFAULT_TRIAL_USED_OPTIONS).
//   trialUsedHandoff       Mia's upsell on the person's WhatsApp thread
//                          instead of the email, only when every gate holds
//                          (see the function). Anything unreadable, refused
//                          or thrown is { handled: false }: D sends its
//                          email, so the person always hears something.
//
// Every Mia module is imported lazily: the funnel processor imports this file,
// and some of them import the processor (un1t-approval-branch.js).
import { logWarn } from '@/lib/log'

const LOG_MODULE = 'mia-un1t'
const NOT_HANDLED = Object.freeze({ handled: false })

// A product title is staff-typed in un1t.online: its em and en dashes become
// hyphens (Richard's rule for anything a customer reads).
const noDashes = (s) => String(s ?? '').replace(/[–—]/g, '-')

/** "{title}, {price_label}" per offer, in the order given. Pure. */
function offerLines(offers) {
  return (Array.isArray(offers) ? offers : [])
    .map((o) => [o?.title, o?.price_label].map((v) => noDashes(v).trim()).filter(Boolean).join(', '))
    .filter(Boolean)
}

// The studio's sellable offer lines. Throws when they cannot be read.
async function sellableOfferLines(db, locationId) {
  const { listPurchaseOptions } = await import('@/lib/agent/purchase-intents')
  const { offers } = await listPurchaseOptions(db, locationId)
  return offerLines(offers)
}

/**
 * The studio's offer list for the trial-used email, one product per line
 * (title and price, never capacity, never a link), in staff order.
 * @returns {Promise<string|null>} null when there are none or they cannot be read
 */
export async function trialUsedOptionsText(db, locationId) {
  try {
    const lines = await sellableOfferLines(db, locationId)
    return lines.length ? lines.join('\n') : null
  } catch (err) {
    logWarn(LOG_MODULE, 'trial-used offer list unreadable; the email says the default words', {
      locationId, op: 'trial_used_options', status: null, code: err?.code ?? null, errClass: err?.name ?? null,
    })
    return null
  }
}

/**
 * Hand a trial-used person to Mia's upsell in their WhatsApp thread instead
 * of the email (E 6.5). Handled only when ALL hold, checked in this order:
 *   1. the studio's resolved Mia settings read, and its studio-only switch
 *      un1t_chat_actions_enabled is true (Ruling 25; default off, and with it
 *      off nothing else is read);
 *   2. its locations.settings.un1t_online.writes_enabled is on;
 *   3. the request came through the WhatsApp Flow (findFlowThread: the Flow
 *      submission that queued it; a website request has none);
 *   4. that thread is this contact's, at this studio, Mia is not paused or
 *      off on it, and its 24h customer-service window is open (isWindowOpen);
 *   5. Mia is on for that sender at this studio (isAgentOnForSender: enabled,
 *      or test mode with the sender on test_phones; enabled + test_mode is
 *      everyone);
 *   6. the studio has at least one sellable offer.
 * Then trial_used_text and the offer lines go on the thread
 * (sendAgentThreadMessage, which records the message as Mia's own, so her
 * next turn sees it in the history) and the requested class is recorded on
 * the conversation's decision log. A send that did not go (window_closed
 * included), any failed read and any throw are { handled: false }: D sends
 * its email. Never throws.
 * @returns {Promise<{ handled: boolean }>}
 */
export async function trialUsedHandoff(db, { request, contact, locationId } = {}) {
  const requestId = request?.id ?? null
  if (!db || !locationId || !request || !contact?.id) return NOT_HANDLED
  if (request.location_id && request.location_id !== locationId) return NOT_HANDLED
  try {
    // 1-2. The studio's switches, from one read of its row.
    const { resolveAgentSettings } = await import('@/lib/agent/settings-resolve')
    const resolved = await resolveAgentSettings(db, locationId)
    if (!resolved?.ok) {
      logWarn(LOG_MODULE, 'trial-used hand-off: studio Mia settings unreadable; the email goes', { locationId, requestId, reason: resolved?.reason ?? null })
      return NOT_HANDLED
    }
    const settings = resolved.settings || {}
    if (settings.un1t_chat_actions_enabled !== true) return NOT_HANDLED
    const { un1tWriteSettingsFrom } = await import('@/lib/un1t-online-settings')
    if (un1tWriteSettingsFrom(resolved.location?.settings).writesEnabled !== true) return NOT_HANDLED

    // 3. Through the WhatsApp Flow, and which thread.
    const { findFlowThread } = await import('@/lib/whatsapp-flow/booking-notice')
    const flow = await findFlowThread(db, request)
    if (!flow?.conversationId) return NOT_HANDLED
    const conversationId = flow.conversationId

    // 4. The thread: this contact's, this studio's, Mia not paused, window open.
    const { data: conv, error } = await db.from('whatsapp_conversations')
      .select('id, location_id, contact_id, wa_phone, window_expires_at, agent_active, agent_paused_at, contacts!contact_id ( id, wa_phone )')
      .eq('id', conversationId)
      .maybeSingle()
    if (error) {
      logWarn(LOG_MODULE, 'trial-used hand-off: thread unreadable; the email goes', { locationId, requestId, conversationId, status: null, code: error.code ?? null })
      return NOT_HANDLED
    }
    if (!conv || conv.location_id !== locationId || conv.contact_id !== contact.id) return NOT_HANDLED
    if (conv.agent_active === false || conv.agent_paused_at) return NOT_HANDLED
    const { isWindowOpen } = await import('@/lib/whatsapp')
    if (!isWindowOpen(conv)) return NOT_HANDLED

    // 5. Mia on for this sender here.
    const { isAgentOnForSender } = await import('@/lib/agent/member-studios')
    if (!isAgentOnForSender(settings, conv.contacts?.wa_phone || conv.wa_phone)) return NOT_HANDLED

    // 6. Something to sell (an unreadable list throws to the catch below).
    const lines = await sellableOfferLines(db, locationId)
    if (!lines.length) return NOT_HANDLED

    const { renderMiaCopy } = await import('@/lib/agent/mia-copy')
    const text = [renderMiaCopy('trial_used_text', settings), ...lines].filter(Boolean).join('\n')
    const { sendAgentThreadMessage } = await import('@/lib/agent/notify')
    const sent = await sendAgentThreadMessage(db, { channel: 'whatsapp', conversationId, text })
    if (sent?.sent !== true) {
      logWarn(LOG_MODULE, 'trial-used hand-off not sent; the email goes', { locationId, requestId, conversationId, reason: sent?.reason || 'not_sent' })
      return NOT_HANDLED
    }

    // The requested class, for the upsell's next turn and the staff trace.
    // Shaped as compactDecisionMeta's tool trace (meta.tools[].name/input, the
    // shape booking-tools.js reads earlier turns' listings from). Ids, the
    // class name and its time only. Best-effort: the message already went.
    const { recordAgentDecision, compactDecisionMeta } = await import('@/lib/agent/decision-log')
    await recordAgentDecision(db, {
      channel: 'whatsapp', conversationId, contactId: contact.id, locationId,
      decision: 'reply', reason: 'trial_used_handoff',
      meta: compactDecisionMeta({
        tools: [{
          name: 'trial_used_handoff',
          input: { event_id: request.glofox_event_id ?? null, starts_at: request.starts_at ?? null, class_name: request.class_name ?? null, request_id: requestId },
        }],
      }),
    })
    return { handled: true }
  } catch (err) {
    logWarn(LOG_MODULE, 'trial-used hand-off failed; the email goes', { locationId, requestId, status: null, code: err?.code ?? null, errClass: err?.name ?? null })
    return NOT_HANDLED
  }
}
