// FLOWACK.1 — what a customer who books through the WhatsApp booking Flow is
// told, and when. Never Mia: the webhook used to hand the submission to her as
// an `interactive` message, and she told a Hatch Street customer "you're all
// set for your first visit" 4 seconds after the booking had failed (19 Oct
// 2026; the same blind reply had run at Stillorgan since July).
//
//   on submit (webhook)   a class request: ONE acknowledgement ("we're booking
//                         your spot now"); a consultation is booked on submit,
//                         so it gets its booking confirmation instead
//   booked (processors)   the booking confirmation on the thread, unless the
//                         class_confirmed template already went (Glofox path)
//   to staff (routeToReview) / failed
//                         the holding line, and the staff card is linked to
//                         the thread (conversation_id + channel 'whatsapp') so
//                         the approve/decline notices reach the customer
//
// Every text is operator-editable with a code default: flow_booking_ack_text,
// flow_booking_holding_text (default-copy.js) and the existing
// booking_confirmation_text (notify.js), all settings.customer_agent fields.
// Every send goes through sendAgentThreadMessage (the thread's own number,
// inside the open 24h window, logged to the thread; tests/whatsapp-config-
// callers.test.js row for notify.js). Nothing here ever throws: a notice that
// could not be sent is logged structurally and the booking stands.
//
// How a queue row is known to come from the Flow without a column for it: the
// webhook stores the submission as an inbound `interactive` message whose body
// is FLOW_SUBMISSION_BODY BEFORE it queues the row (route.js), so the row's
// contact + studio + time find that message and its thread. A website /start
// row has no such message near it. A failed lookup is "not known to be a Flow
// request", which is exactly the behaviour before FLOWACK.1.
import { DEFAULT_FLOW_BOOKING_ACK_TEXT, DEFAULT_FLOW_BOOKING_HOLDING_TEXT, DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT } from '@/lib/agent/default-copy'
import { logError, logWarn } from '@/lib/log'

export const FLOW_SUBMISSION_BODY = '[Booking submitted via WhatsApp Flow]'
// FLOWACK.1 review — a submission that was NOT booked or queued is stored with
// this body instead, so neither Mia (prompt.js) nor findFlowThread can mistake
// it for a request in progress.
export const FLOW_UNPROCESSED_BODY = '[Booking form submitted but could not be processed]'

// The submission is stored a moment before its row is queued; a row created
// more than this after the newest submission is not that submission's.
const FLOW_THREAD_LOOKBACK_MS = 15 * 60_000
// Database clock vs itself: a small allowance the other way.
const FLOW_THREAD_SKEW_MS = 60_000
const LOG = 'flow-booking-notice'

/**
 * The thread of the Flow submission that created this queue row, or null (a
 * website request, an unreadable lookup, or nothing to prove it with).
 * @returns {Promise<{ conversationId: string } | null>}
 */
export async function findFlowThread(db, request) {
  const createdMs = Date.parse(request?.created_at || '')
  if (!request?.contact_id || !request?.location_id || !Number.isFinite(createdMs)) return null
  try {
    const { data, error } = await db.from('whatsapp_messages')
      .select('conversation_id, created_at')
      .eq('contact_id', request.contact_id)
      .eq('location_id', request.location_id)
      .eq('direction', 'inbound')
      .eq('message_type', 'interactive')
      .eq('body', FLOW_SUBMISSION_BODY)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) {
      logWarn(LOG, 'flow thread lookup failed; treated as not a Flow request', { requestId: request.id ?? null, err: error })
      return null
    }
    for (const row of Array.isArray(data) ? data : []) {
      const at = Date.parse(row?.created_at || '')
      if (!row?.conversation_id || !Number.isFinite(at)) continue
      if (at <= createdMs + FLOW_THREAD_SKEW_MS && at >= createdMs - FLOW_THREAD_LOOKBACK_MS) {
        return { conversationId: row.conversation_id }
      }
    }
    return null
  } catch (err) {
    logWarn(LOG, 'flow thread lookup threw; treated as not a Flow request', { requestId: request?.id ?? null, err })
    return null
  }
}

// The studio's resolved Mia settings (org layer included) and zone. Unreadable
// → the code defaults, never a lost message.
async function studioCopy(db, locationId) {
  try {
    const { resolveAgentSettings } = await import('@/lib/agent/settings-resolve')
    const resolved = await resolveAgentSettings(db, locationId)
    if (resolved?.ok) return { settings: resolved.settings || {}, timezone: resolved.location?.timezone ?? null }
  } catch (err) {
    logWarn(LOG, 'studio settings unreadable; defaults used', { locationId, err })
  }
  return { settings: {}, timezone: null }
}

const operatorText = (settings, key) => (typeof settings?.[key] === 'string' ? settings[key].trim() : '')

/** PAIDTRIALONLY.1 — the studio's paid trial reply could not be read. The queue retries it. */
export class PaidTrialReplyReadError extends Error {
  constructor(reason) {
    super(`paid trial reply unreadable (${reason})`)
    this.name = 'PaidTrialReplyReadError'
    this.code = 'paid_trial_reply_unreadable'
  }
}

// PAGETRIAL.1 — a page whose own offer is a free class. Staff pick the offer
// per page, so one studio can run a free trial for one audience (/50plus) and
// sell the paid trial to another (/trial, its studio page) at the same time.
export const FREE_TRIAL_PAGE_OFFERS = Object.freeze(['one_class', 'class_funnel'])

/**
 * PAIDTRIALONLY.1 — the studio's flow_paid_trial_text, or null when it is not
 * set (new people are booked with the free trial, as before). Unlike
 * studioCopy this never falls back: an unreadable setting THROWS, so the
 * queue retries rather than give a free trial the studio may have retired.
 *
 * PAGETRIAL.1 — with `pageId` (the queue row's page_id), a booking from a
 * page whose offer is a free class is null too: the page's offer wins over
 * the studio default. A row with no page (the WhatsApp Flow, Mia), a paid
 * trial page, or a page since deleted keeps the studio's setting. The page is
 * read only when the studio sells a paid trial, and a failed read THROWS for
 * the same reason the setting does.
 * @returns {Promise<string|null>}
 * @throws {PaidTrialReplyReadError}
 */
export async function readPaidTrialReply(db, locationId, { pageId = null } = {}) {
  const { resolveAgentSettings } = await import('@/lib/agent/settings-resolve')
  const resolved = await resolveAgentSettings(db, locationId)
  if (!resolved?.ok) throw new PaidTrialReplyReadError(resolved?.reason || 'unknown')
  const text = operatorText(resolved.settings, 'flow_paid_trial_text')
  if (!text) return null
  if (pageId && (await pageOffersFreeTrial(db, pageId, locationId))) return null
  const { stripEmDashes } = await import('@/lib/agent/core')
  return stripEmDashes(text).trim() || null
}

// The page must also be THIS studio's: its own studio (a one-studio page) or
// switched on for it (an all-studio page's landing_page_studios row). The
// route already sets page_id from the page it served, so this is a second
// fence: a page of another studio is "no page", and the paid trial applies.
async function pageOffersFreeTrial(db, pageId, locationId) {
  const page = await readOrThrow(() => db.from('landing_pages')
    .select('offer_type, scope, primary_location_id').eq('id', pageId).maybeSingle())
  if (!page || !FREE_TRIAL_PAGE_OFFERS.includes(page.offer_type)) return false
  if (page.scope === 'one') return page.primary_location_id === locationId
  const studio = await readOrThrow(() => db.from('landing_page_studios')
    .select('enabled').eq('page_id', pageId).eq('location_id', locationId).maybeSingle())
  return studio?.enabled === true
}

async function readOrThrow(query) {
  let res
  try {
    res = await query()
  } catch {
    throw new PaidTrialReplyReadError('page_unreadable')
  }
  if (res?.error) throw new PaidTrialReplyReadError('page_unreadable')
  return res?.data ?? null
}

async function confirmationText(settings, { className, classTime }) {
  const { buildBookingConfirmationText } = await import('@/lib/agent/notify')
  return buildBookingConfirmationText({ className, classTime, template: operatorText(settings, 'booking_confirmation_text') || null })
}

async function zoneFor(locationId, timezone) {
  const { zoneOfLocation } = await import('@/lib/location-time')
  return zoneOfLocation({ id: locationId, timezone })
}

// One send on the thread. Never throws; a refusal is logged with its reason.
async function sendOnThread(db, { conversationId, text, log }) {
  try {
    const { sendAgentThreadMessage } = await import('@/lib/agent/notify')
    const r = await sendAgentThreadMessage(db, { channel: 'whatsapp', conversationId, text })
    if (r?.sent === true) return { sent: true }
    const reason = r?.reason || 'not_sent'
    logError(LOG, 'customer notice not sent', { ...log, conversationId, reason })
    return { sent: false, reason }
  } catch (err) {
    logError(LOG, 'customer notice threw', { ...log, conversationId, reason: 'send_error', err })
    return { sent: false, reason: 'send_error' }
  }
}

/**
 * The webhook's one reply to a HANDLED Flow submission (handleFlowCompletion's
 * result), sent instead of a Mia turn. Never throws.
 * @param {{ conversationId: string, locationId: string, completion: { kind: 'class'|'consult', date?: string, startTime?: string } }} args
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendFlowSubmissionReply(db, { conversationId, locationId, completion }) {
  try {
    const { settings, timezone } = await studioCopy(db, locationId)
    let text
    if (completion?.kind === 'class' && completion.duplicate === true && completion.existingStatus === 'booked') {
      // Re-sent for a class already booked: say it is booked.
      const zone = await zoneFor(locationId, timezone)
      const { classLabel } = await import('@/lib/class-booking-processor')
      text = await confirmationText(settings, { className: completion.className || 'your class', classTime: classLabel(completion.startsAt, zone) })
    } else if (completion?.kind === 'class' && completion.duplicate === true) {
      // Re-sent while the first request is still being booked: nothing new is booked.
      const { stripEmDashes } = await import('@/lib/agent/core')
      text = stripEmDashes(operatorText(settings, 'flow_booking_duplicate_text') || DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT).trim()
    } else if (completion?.kind === 'consult') {
      // Booked on submit (createEventBooking): say so, with the slot on the studio's clock.
      let classTime = null
      if (completion.date && completion.startTime) {
        const zone = await zoneFor(locationId, timezone)
        const { zonedWallClockToInstant } = await import('@/lib/location-time')
        const { classLabel } = await import('@/lib/class-booking-processor')
        classTime = classLabel(zonedWallClockToInstant(completion.date, completion.startTime, zone), zone)
      }
      text = await confirmationText(settings, { className: 'your consultation', classTime })
    } else {
      const { stripEmDashes } = await import('@/lib/agent/core')
      text = stripEmDashes(operatorText(settings, 'flow_booking_ack_text') || DEFAULT_FLOW_BOOKING_ACK_TEXT).trim()
    }
    return await sendOnThread(db, { conversationId, text, log: { locationId, kind: completion?.kind ?? null, step: 'submission' } })
  } catch (err) {
    logError(LOG, 'flow submission reply failed', { conversationId, locationId, reason: 'error', err })
    return { sent: false, reason: 'error' }
  }
}

// Link the staff card to the thread, judged on the rows it touched: only an
// unlinked card is written; one already linked to this thread counts; one
// linked to ANOTHER thread is left as it is (its own conversation keeps its
// notices) and logged; a missing or unreadable card is logged at error.
async function linkCardToThread(db, { approvalId, conversationId, log }) {
  const lost = 'approve/decline will not message the customer'
  try {
    const { data, error } = await db.from('agent_membership_requests')
      .update({ conversation_id: conversationId, channel: 'whatsapp' })
      .eq('id', approvalId)
      .is('conversation_id', null)
      .select('id')
    if (error) {
      logError(LOG, `staff card not linked to the WhatsApp thread (${lost})`, { ...log, approvalId, conversationId, err: error })
      return false
    }
    if (Array.isArray(data) && data.length > 0) return true
    const { data: card, error: readErr } = await db.from('agent_membership_requests')
      .select('id, conversation_id')
      .eq('id', approvalId)
      .maybeSingle()
    if (readErr || !card) {
      logError(LOG, `staff card link touched no row and the card could not be read (${lost})`, { ...log, approvalId, conversationId, err: readErr ?? null })
      return false
    }
    if (card.conversation_id === conversationId) return true
    logWarn(LOG, 'staff card already linked to another thread; left as it is', { ...log, approvalId, conversationId, linkedConversationId: card.conversation_id ?? null })
    return false
  } catch (err) {
    logError(LOG, `staff card link threw (${lost})`, { ...log, approvalId, conversationId, err })
    return false
  }
}

/**
 * Tell a Flow customer the outcome of their queued class request. A row that
 * did not come from the Flow sends nothing. Never throws.
 *   booked        the booking confirmation (classTime: the label, or computed)
 *   needs_review  link the staff card (approvalId) to the thread, then the
 *                 holding line
 *   failed        the holding line; with no card behind it, logged at error
 *   paid_trial    PAIDTRIALONLY.1: `text` (the studio's paid trial reply);
 *                 nothing was booked and there is no card
 * @returns {Promise<{ flow: boolean, sent: boolean, stamped?: boolean, reason?: string }>}
 */
export async function notifyFlowBookingOutcome(db, request, { outcome, approvalId = null, classTime = null, text: givenText = null } = {}) {
  const log = { requestId: request?.id ?? null, locationId: request?.location_id ?? null, outcome }
  try {
    const thread = await findFlowThread(db, request)
    if (!thread) return { flow: false, sent: false }
    const { conversationId } = thread

    // Link the card first: a lost holding line must not also lose the
    // approve/decline notices, and a lost stamp must not lose the line.
    let stamped
    if (approvalId) stamped = await linkCardToThread(db, { approvalId, conversationId, log })
    else if (outcome !== 'booked' && outcome !== 'paid_trial') {
      logError(LOG, 'Flow booking ended with no staff card; the customer is told the team will confirm', { ...log, conversationId })
    }

    const { settings, timezone } = await studioCopy(db, request.location_id)
    let text
    if (outcome === 'paid_trial') {
      text = String(givenText || '').trim()
      if (!text) {
        logError(LOG, 'paid trial outcome with no text; nothing sent', { ...log, conversationId })
        return { flow: true, sent: false, reason: 'no_text' }
      }
    } else if (outcome === 'booked') {
      let label = classTime
      if (!label) {
        const { classLabel } = await import('@/lib/class-booking-processor')
        label = classLabel(request.starts_at, await zoneFor(request.location_id, timezone))
      }
      text = await confirmationText(settings, { className: request.class_name || 'your class', classTime: label })
    } else {
      const { stripEmDashes } = await import('@/lib/agent/core')
      text = stripEmDashes(operatorText(settings, 'flow_booking_holding_text') || DEFAULT_FLOW_BOOKING_HOLDING_TEXT).trim()
    }
    const sent = await sendOnThread(db, { conversationId, text, log })
    return { flow: true, ...sent, ...(stamped === undefined ? {} : { stamped }) }
  } catch (err) {
    logError(LOG, 'Flow outcome notice failed', { ...log, reason: 'error', err })
    return { flow: false, sent: false, reason: 'error' }
  }
}
