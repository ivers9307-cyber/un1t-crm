// EMAIL-DELIVERY.1 — correlate a Postmark delivery event back to the outbound
// ticket message it belongs to, and record the outcome.
//
// Spec + column reasoning: supabase/migrations/498_email_message_delivery_status.sql
//
// THE CORRELATION KEY, AND WHY IT CANNOT COLLIDE WITH MARKETING
// Postmark mints one globally-unique MessageID per accepted message and returns
// it from the send call. The ticket reply and compose routes have written that
// value onto email_inbox_messages.postmark_message_id since mig 394, under a
// UNIQUE partial index. So the match is exact and one-directional in both
// senses that matter:
//
//   • A CAMPAIGN event can never touch a ticket message. Its MessageID was
//     minted for a campaign send and was never written onto any
//     email_inbox_messages row, so the UPDATE below matches ZERO rows. That is
//     a no-op, not an error — which is also the required behaviour for an
//     invoice email, a booking confirmation, a BCA submission, or any other
//     send that shares this webhook firehose.
//   • A TICKET event can never touch a campaign row, because this module only
//     ever writes to email_inbox_messages. The pre-existing handlers in
//     postmark-webhook-processor.js still own email_sends / campaign_recipients
//     and are untouched — including all suppression and auto-unsubscribe
//     behaviour, which this module deliberately does not participate in.
//
// `direction = 'outbound'` is on the UPDATE as a structural guard, not a
// nicety. Inbound messages ALSO carry a postmark_message_id (the inbound
// payload's own MessageID), and a delivery outcome is meaningless on mail we
// received. Internal notes cannot match at all — nothing is sent, so their
// postmark_message_id is NULL and `.eq()` never matches NULL.
//
// NEVER-THROWING, AND NEVER FATAL TO THE EVENT
// POSTMARK-DLQ.1 exists because bounces went silently missing when queue rows
// burned their retry budget. Failing the whole event over a DISPLAY column
// would recreate that hole from the other end: the load-bearing half of a
// Bounce (hard-bounce suppression) and of a SpamComplaint (auto-unsubscribe)
// runs in the processor's own switch, and dead-lettering the event because a
// thread marker would not write is a strictly worse trade. Worse still, a
// column that does not exist yet (code deployed ahead of its migration) would
// fail EVERY event and dead-letter the lot. So this returns a verdict, logs
// loudly on failure, and never throws.

import { logError } from './log.js'

/**
 * Severity lattice. An absent value ranks 0.
 *
 * bounced outranks complained because they answer the operator's actual
 * question differently: a complaint means the member GOT the answer and
 * disliked it, a bounce means they never saw it and someone has to act. In
 * practice the two never race for one message; the ordering is here so the
 * rule is total rather than situational.
 */
export const DELIVERY_STATUS_RANK = Object.freeze({
  delivered: 1,
  complained: 2,
  bounced: 3,
})

/** The three Postmark record types that say something about OUR outbound mail. */
export const DELIVERY_RECORD_TYPES = Object.freeze({
  Delivery: 'delivered',
  Bounce: 'bounced',
  SpamComplaint: 'complained',
})

/** Postmark's Description + Details can be long; the thread shows a sentence, not a log. */
export const DETAIL_MAX_CHARS = 500

/** The stored status a record type maps to, or null for every other event. */
export function deliveryStatusForRecordType(recordType) {
  return DELIVERY_RECORD_TYPES[recordType] || null
}

/**
 * Would an event of `next` status be allowed to overwrite a stored `current`?
 *
 * STRICTLY greater, so a repeat of the same event is a no-op and equal-severity
 * events keep the FIRST timestamp — the one nearer to when it actually
 * happened.
 */
export function shouldApplyDeliveryEvent(current, next) {
  const nextRank = DELIVERY_STATUS_RANK[next] || 0
  if (!nextRank) return false
  return nextRank > (DELIVERY_STATUS_RANK[current] || 0)
}

/**
 * The stored values a `status` event is allowed to replace, sorted for a stable
 * query string. NULL is handled separately (it is not a value).
 */
export function overwritableStatuses(status) {
  const rank = DELIVERY_STATUS_RANK[status] || 0
  if (!rank) return []
  return Object.keys(DELIVERY_STATUS_RANK)
    .filter(s => DELIVERY_STATUS_RANK[s] < rank)
    .sort()
}

/**
 * The PostgREST `or=` expression that enforces the lattice IN THE DATABASE.
 *
 * The rule is stated twice on purpose: once in shouldApplyDeliveryEvent (pure,
 * unit-tested, the readable statement of intent) and once here, as a filter the
 * UPDATE carries. A read-then-write would be a race — the QStash worker and the
 * drain cron process different queue rows at the same time by design, so a
 * Delivery and a Bounce for one message can genuinely be in flight together.
 * Expressing it as a WHERE clause makes the check and the write one statement.
 */
export function overwritableFilter(status) {
  const lower = overwritableStatuses(status)
  const clauses = ['delivery_status.is.null']
  if (lower.length) {
    clauses.push(`delivery_status.in.(${lower.map(s => `"${s}"`).join(',')})`)
  }
  return clauses.join(',')
}

/**
 * hard | soft | transient — the SAME mapping postmark-webhook-processor.js
 * applies to email_sends.bounce_type. Duplicating the shape rather than
 * importing it is deliberate: that mapping is wired into suppression, which
 * this task must not touch, and a shared helper would invite someone to "fix"
 * one and move both.
 */
export function normalizeBounceType(type) {
  if (type === 'HardBounce') return 'hard'
  if (type === 'SoftBounce') return 'soft'
  return 'transient'
}

/**
 * Postmark's own words about what went wrong.
 *
 * Description is the human sentence ("The server was unable to deliver your
 * message (ex: unknown user, mailbox not found)"); Details is usually the raw
 * SMTP response ("smtp;550 5.1.1 <x@y> User unknown"), which is where the
 * mailbox-full-vs-no-such-address distinction is actually stated in full. Both,
 * joined, because staff need the sentence and the evidence. Name is the last
 * resort so an event with neither still says something ("Blocked", "DNS error").
 */
export function bounceDetail(body) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '')
  const parts = [text(body?.Description), text(body?.Details)].filter(Boolean)
  const joined = parts.length ? parts.join(' ') : text(body?.Name)
  return joined ? joined.slice(0, DETAIL_MAX_CHARS) : null
}

/** An ISO string we are willing to store, or null if Postmark sent nonsense. */
function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Read a raw Postmark webhook payload into the event this module records, or
 * null when the payload says nothing about outbound delivery (Open, Click,
 * SubscriptionChange, an inbound message, anything unrecognised).
 *
 * `occurredAt` prefers the provider's own stamp — DeliveredAt for a delivery,
 * BouncedAt for a bounce or a complaint — and falls back to `now` only when
 * that is missing or unparseable, so the thread shows when it happened rather
 * than when the queue got round to it.
 */
export function deliveryEventFromPayload(body, now = new Date()) {
  const status = deliveryStatusForRecordType(body?.RecordType)
  if (!status) return null
  const messageId = body?.MessageID
  if (!messageId || typeof messageId !== 'string') return null

  const occurredAt = isoOrNull(status === 'delivered' ? body?.DeliveredAt : body?.BouncedAt)
    || new Date(now).toISOString()

  return {
    messageId,
    status,
    occurredAt,
    // A plain delivery carries no explanation and needs none.
    detail: status === 'delivered' ? null : bounceDetail(body),
    bounceType: status === 'bounced' ? normalizeBounceType(body?.Type) : null,
  }
}

/**
 * Stamp a Postmark delivery event onto the outbound ticket message it belongs
 * to, if that message is ours.
 *
 * All four columns are written together so the row is always a consistent
 * tuple — a Delivery only ever applies over NULL, so clearing detail and
 * bounce_type there is describing the state, not erasing evidence.
 *
 * @param {SupabaseClient} db service-role client
 * @param {object} body raw Postmark webhook payload
 * @returns {Promise<{ok: boolean, applied: boolean, reason?: string, error?: string}>}
 *   `applied: false` with `ok: true` is the NORMAL answer for a marketing send,
 *   an invoice email, or a duplicate/out-of-order event. It is not a failure.
 */
export async function recordTicketMessageDelivery(db, body) {
  try {
    const event = deliveryEventFromPayload(body)
    if (!event) return { ok: true, applied: false, reason: 'not_a_delivery_event' }

    const { data, error } = await db.from('email_inbox_messages')
      .update({
        delivery_status: event.status,
        delivery_status_at: event.occurredAt,
        delivery_detail: event.detail,
        delivery_bounce_type: event.bounceType,
      })
      .eq('postmark_message_id', event.messageId)
      // See the header: inbound rows carry a postmark_message_id too.
      .eq('direction', 'outbound')
      // The lattice, enforced atomically.
      .or(overwritableFilter(event.status))
      .select('id')

    if (error) {
      // Loud, but NOT fatal — see the header. The caller keeps going and the
      // event is still marked processed, because the suppression half of a
      // Bounce/SpamComplaint has its own path and must not be retried into the
      // dead-letter queue over a display column.
      logError('email-delivery-status', 'delivery stamp failed', {
        messageId: event.messageId,
        status: event.status,
        err: error.message || String(error),
      })
      return { ok: false, applied: false, error: error.message || String(error) }
    }

    // Zero rows is the common, correct case: this event belonged to a campaign,
    // an invoice, a booking confirmation — or it was a duplicate / out-of-order
    // event the lattice correctly refused. Nothing to say about it.
    return { ok: true, applied: (data?.length || 0) > 0 }
  } catch (e) {
    logError('email-delivery-status', 'delivery stamp threw', {
      messageId: body?.MessageID,
      recordType: body?.RecordType,
      err: e?.message || String(e),
    })
    return { ok: false, applied: false, error: e?.message || String(e) }
  }
}
