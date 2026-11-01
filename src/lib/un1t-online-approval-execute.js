// UN1TWRITE.23 — executeUn1tApproval: approving a un1t.online funnel card
// (agent_membership_requests, kind class_booking or class_cancellation,
// details.provider 'un1t_online').
//
// Kept OUT of un1t-online-approval.js on purpose: that module holds the
// record-only refund card, and tests/un1t-online-write-guard.test.js proves it
// reaches no write module. This one is the write side.
//
// What approving does, by details.reason:
//   record-only reasons (UN1T_RECORD_ONLY_REASONS: identity problems, the
//     trial-used follow-up, the funnel switched off, a class gone, no email):
//     nothing is executed; staff did it by hand in un1t.online, so the queue
//     row is recorded booked.
//   un1t_trial_unverified: books only if the credits show; never buys.
//   anything else (un1t_trial_failed:*, un1t_outcome_unknown,
//     un1t_booking_failed:*, processing_error, ...): the processor's steps
//     again from the ledger (every primitive runs its check read before it
//     sends anything again), origin 'approval', the approver as actor. A
//     failed trial is granted at most once more (grantTrial re-checks A's
//     eligibility itself).
// UN1TMOVE.1 — a class_booking card carrying details.move_from_booking_id
// (Mia's move_class_booking files these for the TARGET class) runs ONE
// moveBooking from the ledger (its check read before any re-send), origin
// 'approval', the approver as actor: never a book, a trial or an email.
// A confirmed booking sends the step-7 emails and syncs the queue row. The
// past-start guard is the route's; no WhatsApp is sent here (E's in-thread
// confirmation wraps this for Mia's cards).
//
// Rejects only on a database error before anything was written or sent (the
// route answers 500 and the card stays as claimed, on the retry lane).

import { UN1T_RECORD_ONLY_REASONS } from './un1t-online-approval.js'
import { createUn1tWriter, UN1T_WRITE_CODES } from './un1t-online-write.js'
import { cancel as cancelOp, moveBooking as moveOp } from './un1t-online-write-ops.js'
import { readUn1tWriteSettings } from './un1t-online-settings.js'
import { un1tEventIdOf } from './manual-timetable.js'
import { un1tBookOnce, un1tAfterBooking, readStudioContextForApproval } from './un1t-online-booking-processor.js'
import { UN1T_STAFF_COPY } from './un1t-staff-booking-copy.js'
import { UN1T_LATE_MOVE_CODES as L } from './un1t-online-late-move.js'
import { logWarn } from './log'

const C = UN1T_WRITE_CODES
const LOG = 'un1t-approval'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Staff-facing words for the result codes a card can end on. */
export const UN1T_APPROVAL_COPY = Object.freeze({
  [C.ALREADY_HAPPENED]: 'This class has already happened in un1t.online (attended or a no-show), so nothing was changed.',
  [C.ALREADY_BOOKED_UNVERIFIED]: UN1T_STAFF_COPY.alreadyBookedUnverified,
  un1t_outcome_unknown: UN1T_STAFF_COPY.unknown,
  un1t_trial_unverified: 'The trial could not be confirmed: no credits show in un1t.online. Check the person in un1t.online; nothing was bought.',
  un1t_trial_used: 'They have had the free trial before, so nothing was booked. Offer them a pack or a membership.',
  // UN1TMOVE.2 — the late-window move rule (D's cancel and move enforce it).
  [L.OTHER_DAY]: UN1T_STAFF_COPY.moveLateOtherDay,
  [L.CANCEL_AFTER_LATE_MOVE]: UN1T_STAFF_COPY.cancelAfterLateMove,
  [L.WINDOW_UNREADABLE]: UN1T_STAFF_COPY.lateCheckUnreadable,
  [L.CANCEL_CHECK_UNREADABLE]: UN1T_STAFF_COPY.lateCheckUnreadable,
})

const reasonOf = (details) => (typeof details?.reason === 'string' ? details.reason : '')
// A card id, bare: `un1t:<id>` or the id itself; null for anything else.
function bareUn1tId(v) {
  const raw = typeof v === 'string' ? v.trim() : ''
  if (!raw) return null
  const id = un1tEventIdOf(raw) ?? raw
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : null
}

async function syncQueueRow(db, approvalId, fields) {
  try {
    const { error } = await db.from('class_booking_requests').update(fields).eq('approval_request_id', approvalId)
    if (error) logWarn(LOG, 'queue row sync failed', { requestId: approvalId, err: error })
  } catch (err) {
    logWarn(LOG, 'queue row sync threw', { requestId: approvalId, err })
  }
}

/**
 * @param {object} db
 * @param {{ row: { id: string, location_id: string, kind: 'class_booking'|'class_cancellation', status?: string,
 *   details: object, contact_id: string, channel?: string|null, conversation_id?: string|null },
 *   actor: { id: string }, now?: Date }} args
 * @returns {Promise<{ finalStatus: 'actioned'|'failed', details: object, executed: object,
 *   customerNotified: { sent: boolean, channel: 'email', reason?: string } | null }>}
 */
export async function executeUn1tApproval(db, { row, actor }, deps = {}) {
  const {
    writerFactory = createUn1tWriter,
    readSettings = readUn1tWriteSettings,
    bookOnce = un1tBookOnce,
    afterBooking = un1tAfterBooking,
    studioContext = readStudioContextForApproval,
    cancel = cancelOp,
    move = moveOp,
  } = deps
  const details = row.details || {}
  const reason = reasonOf(details)
  const fromFunnel = details.source === 'start_funnel'
  const done = (executed, finalStatus, notified = null) => ({ finalStatus, details: { ...details, result: executed }, executed, customerNotified: notified })

  // Record-only: staff did it in un1t.online by hand; approving records it.
  if (row.kind === 'class_booking' && UN1T_RECORD_ONLY_REASONS.has(reason)) {
    if (fromFunnel) await syncQueueRow(db, row.id, { status: 'booked', last_error: null })
    return done({ ok: true, record_only: true }, 'actioned')
  }

  const ctx = await readSettings(db, row.location_id)
  const writer = await writerFactory(db, row.location_id)
  const executingContactId = details.executing_contact_id || row.contact_id
  const { data: contact, error: cErr } = await db.from('contacts')
    .select('id, organization_id, first_name, last_name, name, email, phone, un1t_user_id, ctwa_clid')
    .eq('id', executingContactId).maybeSingle()
  if (cErr) throw Object.assign(new Error(`contact read failed (${cErr.code ?? 'no code'})`), { code: cErr.code ?? null })
  if (!contact) return done({ ok: false, code: 'contact_missing', message: 'The contact on this card no longer exists.' }, 'failed')

  // A cancellation (E files these): the booking, the person's account.
  if (row.kind === 'class_cancellation') {
    const un1tUserId = details.un1t_user_id || contact.un1t_user_id
    const r = await cancel(db, {
      locationId: row.location_id, contactId: contact.id, un1tUserId, bookingId: details.booking_id,
      origin: 'approval', originRef: row.id, actor,
    }, { writerFactory: async () => writer })
    const ok = r.verdict === 'done'
    return done({
      ok, verdict: r.verdict, code: r.code ?? null, message: UN1T_APPROVAL_COPY[r.code] ?? r.message ?? null,
      un1t_booking_id: ok ? (r.id ?? details.booking_id ?? null) : null, ledger_id: r.ledgerId ?? null,
    }, ok ? 'actioned' : 'failed')
  }

  // A move (UN1TMOVE.1): the booking to the card's class, in one call.
  const moveFrom = bareUn1tId(details.move_from_booking_id)
  if (row.kind === 'class_booking' && moveFrom) {
    const un1tUserId = details.un1t_user_id || contact.un1t_user_id
    const eventId = bareUn1tId(details.event_id)
    if (!eventId) return done({ ok: false, code: 'class_unavailable', message: 'This card names no un1t.online class.' }, 'failed')
    const r = await move(db, {
      locationId: row.location_id, contactId: contact.id, un1tUserId, bookingId: moveFrom, eventId,
      fromEventId: bareUn1tId(details.move_from_event_id), origin: 'approval', originRef: row.id, actor,
    }, { writerFactory: async () => writer })
    const ok = r.verdict === 'done'
    return done({
      ok, verdict: r.verdict, moved: ok, code: r.code ?? null, message: UN1T_APPROVAL_COPY[r.code] ?? r.message ?? null,
      un1t_booking_id: ok ? (r.id ?? moveFrom) : null, ledger_id: r.ledgerId ?? null,
    }, ok ? 'actioned' : 'failed')
  }

  // A booking: the queue row carries the request's terms and class.
  let request = null
  if (fromFunnel) {
    const { data: q, error: qErr } = await db.from('class_booking_requests')
      .select('id, location_id, contact_id, glofox_event_id, class_name, starts_at, terms_accepted_at, terms_source, terms_version, page_id, funded_by')
      .eq('approval_request_id', row.id).limit(1).maybeSingle()
    if (qErr) throw Object.assign(new Error(`queue row read failed (${qErr.code ?? 'no code'})`), { code: qErr.code ?? null })
    request = q
  }
  request = request || {
    id: null, location_id: row.location_id, contact_id: row.contact_id, glofox_event_id: details.event_id,
    class_name: details.class_name, starts_at: details.starts_at, terms_accepted_at: null,
  }
  const rawId = String(details.event_id || request.glofox_event_id || '')
  const eventId = un1tEventIdOf(rawId) ?? (UUID_RE.test(rawId) ? rawId : null)
  if (!eventId) return done({ ok: false, code: 'class_unavailable', message: 'This card names no un1t.online class.' }, 'failed')

  // CLASSFIRST.1 — a funded row (a paid trial or a promo claim put the credits
  // on the account) never buys a trial from an approval either: no credits is
  // the funded_no_balance card again, as the card's copy promises.
  const funded = Boolean(request?.funded_by) || reason === 'funded_no_balance'
  const once = await bookOnce(db, {
    request, contact, organizationId: ctx.organizationId, eventId, origin: 'approval', originRef: row.id, actor, writer,
    trialMode: funded ? 'funded' : reason === 'un1t_trial_unverified' ? 'credits_only' : 'normal',
  })
  if (once.kind !== 'booked') {
    const code = once.kind === 'card' ? once.reason : once.kind === 'retry' ? once.code : 'un1t_trial_used'
    const message = UN1T_APPROVAL_COPY[code] ?? UN1T_APPROVAL_COPY[once.booking?.code] ?? once.booking?.message ?? null
    if (fromFunnel) await syncQueueRow(db, row.id, { status: 'failed', last_error: code, un1t_steps: once.steps })
    return done({ ok: false, verdict: once.booking?.verdict ?? null, code, message, retryable: once.kind === 'retry', ledger_id: once.booking?.ledgerId ?? null }, 'failed', { sent: false, channel: 'email', reason: 'not_executed' })
  }

  const b = once.booking
  const bookingRef = b.id ? `un1t:${b.id}` : null
  if (fromFunnel) await syncQueueRow(db, row.id, { status: 'booked', last_error: null, glofox_booking_id: bookingRef })
  const studio = await studioContext(db, row.location_id, request.page_id ?? null)
  const after = await afterBooking(db, {
    request, contact, account: once.account, settings: ctx.settings,
    studio: { ...studio, studioName: studio.studioName || ctx.studioName }, origin: 'approval', writer,
  })
  if (fromFunnel) await syncQueueRow(db, row.id, { un1t_steps: { ...once.steps, ...after } })
  const notified = after.confirmation
    ? { sent: after.confirmation === 'sent', channel: 'email', ...(after.confirmation === 'sent' ? {} : { reason: after.confirmation }) }
    : after.explanation
      ? { sent: after.explanation === 'sent', channel: 'email', ...(after.explanation === 'sent' ? {} : { reason: after.explanation }) }
      : null
  return done({
    ok: true, verdict: 'done', code: b.code ?? null, message: b.alreadyBooked ? UN1T_STAFF_COPY.alreadyBooked : null,
    un1t_booking_id: b.id ?? null, ledger_id: b.ledgerId ?? null,
  }, 'actioned', notified)
}
