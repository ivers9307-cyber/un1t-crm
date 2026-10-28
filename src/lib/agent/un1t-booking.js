// MIAHATCH.5 — book_class, cancel_class_booking and request_refund at a
// un1t.online studio (Hatch Street) from chat, through spec D's `book` and
// `cancel` (src/lib/un1t-online-write-ops.js) and `fileRefundCard`
// (src/lib/un1t-online-approval.js). Reached only in tool block 3b
// (`un1t_full`: WhatsApp, the studio's writes_enabled and its Mia switch
// un1t_chat_actions_enabled), after refuseToolForTurn has passed, and for
// book/cancel only with a `un1t:` id (booking-tools.js dispatches, lazily).
//
// book_class (Task 16):
//
// The steps (spec 6.4):
//   1 guards     verified; the studio's un1t.online account (none: not_linked,
//                with the studio's booking link); the class in the mirror at
//                that studio, scheduled, in the future and in the latest pull
//                (else class_unavailable: a class removed in un1t.online stays
//                'scheduled' in the mirror, #2137); the relayed starts_at
//                renders to the same label as the class in the studio's own
//                zone (Review Focus 4), else refused before anything is sent.
//   2 booked?    the LIVE bookings hold the class: booked, no write. A failed
//                or cut-short live read is no verdict (never the stale
//                mirror); D's book then decides.
//   3 credits    fetchLiveEntitlement: live ledger balance > 0, unlimited (a
//                zero balance included, Review Focus 2) or a live
//                subscription in the mirror. Only an answer that CONFIRMS
//                nothing stops here; anything unreadable proceeds and
//                un1t.online arbitrates. Confirmed nothing: the offer list
//                (`needs_purchase`), or with no offers the no_credits card +
//                the deterministic handoff (auto-reply keys on `no_credits`).
//   4 draft      booking_mode 'draft' at THAT studio: a pending card.
//   5 auto       the write-ahead agent_membership_requests row, then D's book
//                with a bare event id, origin 'mia', originRef = the row id,
//                actor null; the row is finalised from D's verdict.
//
// MIAHATCH.6 (Task 20): the free trial (purchase-intents.js) shares steps 1
// and 5: prepareUn1tBooking is the class pre-flight, executeUn1tBook runs D's
// book on a write-ahead row, and the card helpers below file and close rows.
// needs_purchase carries trial_available from offersForBooking; a failed trial
// eligibility read is one un1t_trial_check_failed card + the handoff text.
// MIAHATCH.6 (Task 21): a PAID purchase intent's class runs the same execute
// step with afterPurchase, so a booking that did not go through is ONE staff
// card (reason paid_booking_failed), never an upsell.
//
// What the model may hear: `booked: true` only when D said done (an
// alreadyBooked or recovered done included) or step 2 found the booking.
// Never bypassCredit, never a refund or a charge endpoint. Customer text
// comes from operator-editable keys (renderMiaCopy, booking_issue_handoff_text);
// everything else here is a tool-result line the model reads.
//
// cancel_class_booking (Task 17): the booking must be in the member's LIVE
// bookings (a failed read, or a list that does not hold it, is
// CANCELLATION_UNCERTAIN and nothing is sent; a list the page cap cut short is
// no proof of absence, so D's cancel decides, as its own ownership checks
// do); draft mode files a card; auto writes the class_cancellation row ahead
// and runs D's cancel (an empty body, never forceRefund). A late cancellation
// (only via classifyRefusal) and a class already attended or missed
// (UN1T_ALREADY_HAPPENED) are relayed, never with a promised refund or credit.
//
// move_class_booking (UN1TMOVE.1): a reschedule at the studio in ONE D
// moveBooking call (POST /bookings/{id}/move), never a cancel then a book,
// which can lose the credit or the spot in between. The booking must be in
// the member's LIVE bookings (as for a cancel) and the target class passes
// book_class's pre-flight (prepareUn1tBooking). Inside the studio's
// cancellation window (the FEES.2 quote) the booking moves only to a class
// the same studio day (UN1TMOVE.2), and a booking moved that way can never be
// cancelled afterwards (un1tCancelBooking and D's cancel both refuse), so a
// move is never a way round a late-cancel fee. Draft
// mode files a card; auto writes the row ahead and runs D's moveBooking. Every
// move card is a class_booking row for the TARGET class carrying
// move_from_booking_id, so a staff approval runs D's executor's move branch.
//
// request_refund (Task 17): one record-only refund_request card through D's
// fileRefundCard (R2: nothing is refunded, no un1t.online call), answered with
// the operator's refund_request_text whether or not the card was filed.
//
// Every card this files is a class_booking or class_cancellation row with
// details.provider 'un1t_online' at the un1t.online studio, carrying the keys
// D's executeUn1tApproval reads (event_id or booking_id bare, starts_at,
// class_name, executing_contact_id, un1t_user_id), so a staff approval runs
// D's executor.
import { book, cancel, moveBooking } from '@/lib/un1t-online-write-ops'
import { UN1T_WRITE_CODES } from '@/lib/un1t-online-write'
import { fileRefundCard } from '@/lib/un1t-online-approval'
import { classifyRefusal, scrubMessage } from '@/lib/un1t-online-write-judge'
import { freshCutoff } from '@/lib/un1t-online-freshness'
import { logError, logWarn } from '@/lib/log'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { notifyAgentApprovalRequest } from './approval-notify'
import { UN1T_RETRY_CODES, actionSettings, executingContactOf, classTimeLabel, relayedStartMatches } from './un1t-action-studio'
import { renderMiaCopy } from './mia-copy'
import { parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO } from './tool-capability'
import { openUn1tMemberReader, fetchLiveUn1tBookings, fetchLiveEntitlement } from './un1t-member-read'
import { UN1T_BOOKED_STATUS, UN1T_EVENT_SCHEDULED_STATUS, zoneFor } from './un1t-tools'
import { lateCancelQuote, lateCancelWarning } from '@/lib/class-fees-quote'
import { sameStudioDay, wasMovedInLateWindow, UN1T_LATE_MOVE_CODES } from '@/lib/un1t-online-late-move'

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const C = UN1T_WRITE_CODES
const WRITES_OFF_CODES = new Set([C.WRITES_OFF, C.PERMISSION_MISSING])
const RETRY_CODES = UN1T_RETRY_CODES

// ── pure ────────────────────────────────────────────────────────────

// What any D write result means before the op's own refusals: 'done',
// 'card_unknown' (D's check read already ran and could not tell),
// 'writes_off', 'retry', or null for a refusal the op judges itself.
function writeOutcome(result) {
  const verdict = result?.verdict
  if (verdict === 'done') return 'done'
  if (verdict !== 'refused') return 'card_unknown'
  const code = result.code ?? null
  if (WRITES_OFF_CODES.has(code)) return 'writes_off'
  if (result.retryable === true || RETRY_CODES.has(code)) return 'retry'
  return null
}
const refusalKind = (result) => classifyRefusal({ code: result?.code ?? null, message: result?.message ?? null })

/**
 * What D's Un1tWriteResult means for Mia. done (alreadyBooked and recovered
 * included) is booked; a refusal is the writes switch or permission, a
 * retryable code, or what classifyRefusal makes of un1t.online's code and
 * words; unknown (D's check read already ran) is a staff card. A refusal
 * classified `already_booked` is a card too: the judge only trusts that kind
 * from its code table, and a table match is already a done, so a refused one
 * rests on words alone and is never a "booked" the model may relay. Pure.
 *
 * @param {object} result Un1tWriteResult
 * @returns {'booked'|'class_full'|'no_credits'|'card_rejected'|'card_unknown'|'writes_off'|'retry'}
 */
export function un1tBookOutcome(result) {
  const common = writeOutcome(result)
  if (common === 'done') return 'booked'
  if (common) return common
  const kind = refusalKind(result)
  if (kind === 'class_full') return 'class_full'
  if (kind === 'no_credits') return 'no_credits'
  return 'card_rejected'
}

/**
 * What D's cancel result means for Mia. done (an already-cancelled booking and
 * a recovered one included) is cancelled; UN1T_ALREADY_HAPPENED (attended or
 * a no-show, Ruling 22) and a refusal classifyRefusal calls `late_cancel` are
 * relayed to the member; the writes switch, a retryable code, an unknown and
 * any other refusal (another client's booking included) as for book. Pure.
 *
 * @param {object} result Un1tWriteResult
 * @returns {'cancelled'|'already_happened'|'late_cancel'|'card_rejected'|'card_unknown'|'writes_off'|'retry'}
 */
export function un1tCancelOutcome(result) {
  const common = writeOutcome(result)
  if (common === 'done') return 'cancelled'
  if (common) return common
  if (result.code === C.ALREADY_HAPPENED) return 'already_happened'
  // UN1TMOVE.2 — moved inside the late-cancel window: never cancelled.
  if (result.code === UN1T_LATE_MOVE_CODES.CANCEL_AFTER_LATE_MOVE) return 'moved_late'
  if (refusalKind(result) === 'late_cancel') return 'late_cancel'
  return 'card_rejected'
}

/**
 * UN1TMOVE.1 — what D's moveBooking result means for Mia. done (recovered
 * included) is moved; UN1T_ALREADY_HAPPENED, the same class, a full class and
 * a refusal classifyRefusal calls `late_cancel` (too late to move) are relayed;
 * the writes switch, a retryable code, an unknown and any other refusal as for
 * book. Pure.
 *
 * @param {object} result Un1tWriteResult
 * @returns {'moved'|'class_full'|'too_late'|'late_other_day'|'already_happened'|'same_class'|'card_rejected'|'card_unknown'|'writes_off'|'retry'}
 */
export function un1tMoveOutcome(result) {
  const common = writeOutcome(result)
  if (common === 'done') return 'moved'
  if (common) return common
  if (result.code === C.ALREADY_HAPPENED) return 'already_happened'
  if (result.code === MOVE_SAME_CLASS) return 'same_class'
  if (result.code === UN1T_LATE_MOVE_CODES.OTHER_DAY) return 'late_other_day'
  const kind = refusalKind(result)
  if (kind === 'class_full') return 'class_full'
  if (kind === 'late_cancel') return 'too_late'
  return 'card_rejected'
}
// D's code for "the booking is already for that class" (UN1T_MOVE_CODES.SAME_CLASS).
const MOVE_SAME_CLASS = 'move_same_class'

// relayedStartMatches lives in un1t-action-studio.js (purchase-intents.js checks a
// relayed class time too); re-exported here, where its callers and tests look.
export { relayedStartMatches }
const labelOf = classTimeLabel

// ── answers the model reads ─────────────────────────────────────────

const NOT_VERIFIED = Object.freeze({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
const TRY_AGAIN = Object.freeze({
  booked: false,
  try_again: true,
  message: 'The booking could not be made just now and nothing was booked. Tell the customer and ask them to try again in a few minutes, or offer to hand off to the team. Never say it is booked.',
})
const CLASS_UNAVAILABLE = Object.freeze({
  no_longer_available: 'That class is no longer on the timetable, so nothing was booked. Say so and offer another class from list_upcoming_classes.',
  already_started: 'That class has already started or finished, so nothing was booked. Say so and offer another class from list_upcoming_classes.',
  starts_at_mismatch: 'The class time you passed does not match this class, so nothing was booked. Call list_upcoming_classes again, confirm the class and its day and time with the customer, and pass its event_id and starts_at exactly as listed.',
  unknown_class: 'That is not a class id from list_upcoming_classes, so nothing was booked. Call list_upcoming_classes and pass the event_id exactly as listed.',
})
const CLASS_FULL = Object.freeze({
  booked: false,
  reason: 'class_full',
  message: 'That class is full, so nothing was booked. Say so honestly and offer the next class from list_upcoming_classes.',
})
const NO_CREDITS = Object.freeze({
  booked: false,
  no_credits: true,
  message: 'The customer has no class credits and no active membership, so this booking cannot proceed. The team has been alerted and is taking over this conversation now. Your reply will not be sent, so do not compose one.',
})
const PENDING_APPROVAL = Object.freeze({
  booked: false,
  pending_approval: true,
  message: 'Queued for the team to confirm. Tell the customer they will hear back shortly. Never say it is booked yet.',
})
/** The one wording for a failed trial eligibility read (purchase-intents.js uses it too). */
export const UN1T_TRIAL_CHECK_FAILED_LEAD = 'Whether they can have the free trial could not be checked just now, so no trial was offered or given and nothing was booked, and the team has been asked to help.'

const HANDOFF_LEAD = Object.freeze({
  booking_rejected: 'un1t.online did not accept this booking, and the team has been asked to sort it out.',
  un1t_outcome_unknown: 'un1t.online did not confirm whether this booking went through, and the team has been asked to check.',
  un1t_book_not_sent: 'The booking could not be sent just now, so nothing was booked.',
  // MIAHATCH.6 (Task 20) — whether they may have the free trial could not be read.
  un1t_trial_check_failed: UN1T_TRIAL_CHECK_FAILED_LEAD,
  // A trial was just given, but book still found no credits: never an upsell.
  un1t_trial_granted_no_credits: 'The free trial is on their account, but its credits did not show for this booking yet, so nothing was booked, and the team has been asked to book it.',
  cancel_rejected: 'un1t.online did not accept this cancellation, and the team has been asked to sort it out.',
  // UN1TMOVE.1
  move_rejected: 'un1t.online did not accept this move, so the booking is where it was, and the team has been asked to sort it out.',
  move_outcome_unknown: 'un1t.online did not confirm whether this booking was moved, and the team has been asked to check.',
  un1t_move_not_sent: 'The move could not be sent just now, so the booking is where it was.',
  cancel_outcome_unknown: 'un1t.online did not confirm whether this cancellation went through, and the team has been asked to check.',
  un1t_cancel_not_sent: 'The cancellation could not be sent just now, so nothing was cancelled.',
})
// The result flag each write answers on, and what the model must never claim.
const ACTIONS = Object.freeze({
  book: Object.freeze({ flag: 'booked', never: 'Never say the booking is confirmed.' }),
  cancel: Object.freeze({ flag: 'cancelled', never: 'Never say it is cancelled.' }),
  move: Object.freeze({ flag: 'moved', never: 'Never say it is moved.' }),
})

const CANCEL_TRY_AGAIN = Object.freeze({
  cancelled: false,
  try_again: true,
  message: 'The cancellation could not be made just now and nothing was cancelled. Tell the customer and ask them to try again in a few minutes, or offer to hand off to the team. Never say it is cancelled.',
})
const CANCEL_PENDING_APPROVAL = Object.freeze({
  cancelled: false,
  pending_approval: true,
  message: 'Queued for the team to confirm. Tell the customer the cancellation will be confirmed shortly. Never say it is cancelled yet.',
})
const CANCELLATION_UNCERTAIN = Object.freeze({
  not_found: 'That booking is not among this member\'s bookings, so nothing was cancelled. Call list_my_upcoming_bookings again and pass the booking_id exactly as listed; if it is not there, say you cannot find it and offer to hand off to the team.',
  read_failed: 'The member\'s bookings could not be checked just now, so nothing was cancelled. Do not say the booking does not exist: say you cannot check it right now, and ask them to try again in a few minutes or offer to hand off to the team.',
  // UN1TMOVE.2 — whether it was moved inside the late window could not be read.
  late_move_unreadable: 'Whether this booking can be cancelled could not be checked just now, so nothing was cancelled. Say you cannot cancel it right now, and ask them to try again in a few minutes or offer to hand off to the team.',
})
// UN1TMOVE.2 — the member-facing lines for the late-window move rule.
const MOVED_LATE_NO_CANCEL = 'This booking was moved to this class inside the studio\'s cancellation window, so it cannot be cancelled now and nothing was cancelled. Tell the customer plainly: they keep this class. If they cannot make it, offer to hand off to the team.'
const LATE_OTHER_DAY_TEXT = (from) => `${from} starts inside the studio's cancellation window, so it can only be moved to another class on the same day, and nothing was moved. Tell the customer plainly, and offer a class later that day from list_upcoming_classes, or to keep the booking.`
const NEVER_PROMISE = 'Never promise a refund or a credit back. If they ask for a refund, use request_refund: it only passes the request to the team.'

const classUnavailable = (reason) => ({ booked: false, error: 'class_unavailable', reason, message: CLASS_UNAVAILABLE[reason] })
const cancellationUncertain = (reason) => ({ cancelled: false, error: 'CANCELLATION_UNCERTAIN', reason, message: CANCELLATION_UNCERTAIN[reason] })

function handoffAnswer(reason, settings, action = 'book') {
  const text = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
  const { flag, never } = ACTIONS[action]
  return {
    [flag]: false,
    handoff: true,
    reason,
    message: `${HANDOFF_LEAD[reason]} Tell the customer, staying close to this wording: "${text}". ${never}`,
  }
}

/** UN1T_WRITES_OFF / UN1T_PERMISSION_MISSING: the studio's not-from-chat line. */
function writesOffAnswer(settings, studio, action) {
  return {
    [ACTIONS[action].flag]: false,
    handoff: true,
    reason: 'writes_off',
    chat_booking_unavailable: true,
    text: renderMiaCopy('chat_booking_unavailable_text', settings, { studio: studio.name, link: settings?.booking_url || null }),
  }
}

const cancelNotLinked = (studio) => ({
  cancelled: false,
  not_linked: true,
  message: `No account was found for this person at ${studio.name}, so nothing was cancelled. Offer to hand off to the team.`,
})

function notLinked(studio, settings) {
  const url = typeof settings?.booking_url === 'string' && settings.booking_url.trim() ? settings.booking_url.trim() : null
  return {
    booked: false,
    not_linked: true,
    booking_url: url,
    message: url
      ? `No account was found for this person at ${studio.name}, so nothing was booked. Send them the booking link (booking_url) or offer to hand off to the team.`
      : `No account was found for this person at ${studio.name}, so nothing was booked. Offer to hand off to the team.`,
  }
}

// ── IO ──────────────────────────────────────────────────────────────

/** The class at the studio, checked as the /start funnel checks it (UN1TBOOK.20). */
async function readEvent(db, studio, eventId, nowMs) {
  const { data, error } = await db.from('un1t_events')
    .select('un1t_id, title, starts_at, status, synced_at')
    .eq('location_id', studio.locationId)
    .eq('un1t_id', eventId)
    .maybeSingle()
  if (error) {
    logWarn(LOG_MODULE, 'mirror read failed', { locationId: studio.locationId, op: 'book_event', code: error.code ?? null })
    return { error: true }
  }
  const status = String(data?.status || '').toLowerCase()
  if (!data || status === 'cancelled' || status === 'canceled') return { unavailable: 'no_longer_available' }
  const startsMs = Date.parse(data.starts_at || '')
  if (status === 'completed' || (Number.isFinite(startsMs) && startsMs <= nowMs)) return { unavailable: 'already_started' }
  if (status !== UN1T_EVENT_SCHEDULED_STATUS || !Number.isFinite(startsMs)) return { unavailable: 'no_longer_available' }
  let cutoff
  try {
    cutoff = await freshCutoff(db, 'un1t_events', studio.locationId)
  } catch (err) {
    logWarn(LOG_MODULE, 'mirror freshness unreadable', { locationId: studio.locationId, op: 'book_event', errClass: err?.name })
    return { error: true }
  }
  // Not in the latest pull: removed in un1t.online (the mirror never deletes).
  if (cutoff && !(Date.parse(data.synced_at) >= Date.parse(cutoff))) return { unavailable: 'no_longer_available' }
  return { event: data, startsMs }
}

const BOOKING_KIND = 'class_booking'
const CANCEL_KIND = 'class_cancellation'
const OP_OF_KIND = Object.freeze({ [BOOKING_KIND]: 'book', [CANCEL_KIND]: 'cancel' })
// UN1TMOVE.1 — a move card is a class_booking row for the target class; this
// reason (and the late-window one) tells D's executor to move, not book.
const MOVE_REASON = 'mia_move'

/** One reader serves every live read of a turn's write; a failed open is a reader that says so. */
async function openReader(db, studio, op) {
  try {
    return await openUn1tMemberReader(db, studio.locationId)
  } catch (err) {
    logWarn(LOG_MODULE, 'reader open threw', { locationId: studio.locationId, op, status: null, errClass: err?.name })
    return { ok: false, reason: 'read_failed' }
  }
}

/**
 * The member's LIVE bookings at the studio ({ rows, truncated }), or null when
 * they could not be read. Never the mirror: it can be ~15 minutes behind, so a
 * class cancelled or booked in the app would read the wrong way round.
 */
async function liveBookings(db, studio, reader, op) {
  let live
  try {
    live = await fetchLiveUn1tBookings(db, { locationId: studio.locationId, un1tUserId: studio.un1tUserId }, { reader })
  } catch (err) {
    logWarn(LOG_MODULE, 'live bookings read threw', { locationId: studio.locationId, op, status: null, errClass: err?.name })
    return null
  }
  return live?.ok ? { rows: live.rows, truncated: live.truncated === true } : null
}

const liveEventId = (row) => row?.event_id ?? (row?.event && typeof row.event === 'object' ? row.event.id : undefined)
const bookedOn = (row, eventId) => {
  if (!row || String(row.status || '').toLowerCase() !== UN1T_BOOKED_STATUS) return false
  const ev = liveEventId(row)
  return ev != null && String(ev) === eventId
}

/**
 * Does the member already hold this class? true / false from the LIVE list
 * only, or null when it could not say (a failed read, or a list the page cap
 * cut that does not show the class). On null D's book decides (its own
 * done-check reads first; a refusal becomes a card).
 */
async function alreadyHolds(db, studio, eventId, reader) {
  const live = await liveBookings(db, studio, reader, 'book_bookings')
  if (!live) return null
  if (live.rows.some((r) => bookedOn(r, eventId))) return true
  return live.truncated ? null : false
}

/**
 * An open (pending) card of this kind for this contact at the studio matching
 * `match` in details, or null. `contains` matches a superset, so a plain
 * booking card for class X would also match a MOVE card into X (UN1TMOVE.1),
 * and approving that reused card would move the member's other booking
 * instead of adding one: a match without move_from_booking_id skips move cards.
 */
async function pendingCardId(db, studio, { kind, contactId, match }) {
  let query = db.from('agent_membership_requests')
    .select('id')
    .eq('location_id', studio.locationId)
    .eq('contact_id', contactId)
    .eq('kind', kind)
    .eq('status', 'pending')
    .contains('details', { provider: PROVIDER, ...match })
  if (!('move_from_booking_id' in match)) query = query.is('details->>move_from_booking_id', null)
  const { data, error } = await query.limit(1)
  if (error) {
    // A duplicate card is better than none: carry on and file one.
    logWarn(LOG_MODULE, 'pending card read failed', { locationId: studio.locationId, op: `${OP_OF_KIND[kind]}_card_dedupe`, code: error.code ?? null })
    return null
  }
  return data?.[0]?.id ?? null
}

/** Insert one request row of `kind` at the studio; its id, or null (logged). */
async function insertRequest(db, ctx, studio, { kind, contactId, status, details }) {
  const op = `${OP_OF_KIND[kind]}_request`
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: studio.locationId,
      contact_id: contactId,
      kind,
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      status,
    }).select('id').single()
    if (error || !data?.id) {
      logError(LOG_MODULE, 'request row not written', { locationId: studio.locationId, op, status: null, code: error?.code ?? null })
      return null
    }
    return data.id
  } catch (err) {
    logError(LOG_MODULE, 'request row insert threw', { locationId: studio.locationId, op, status: null, errClass: err?.name })
    return null
  }
}

/** Close out the write-ahead row; a failure is loud (a real write may be behind it). */
async function finishRequest(db, studio, requestId, { status, details }) {
  try {
    const { data, error } = await db.from('agent_membership_requests')
      .update({ status, details, updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .select('id')
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG_MODULE, 'request row not finalised', { locationId: studio.locationId, op: 'request_finalise', requestId, status: null, code: error?.code ?? null })
    }
  } catch (err) {
    logError(LOG_MODULE, 'request row finalise threw', { locationId: studio.locationId, op: 'request_finalise', requestId, status: null, errClass: err?.name })
  }
}

/** The team's push for a card. Best effort: a failed notify never aborts the filing or what follows it. */
async function alertStaff(db, ctx, studio, { kind, requestId, summary }) {
  try {
    await notifyAgentApprovalRequest(db, {
      requestId, locationId: studio.locationId, kind, customerName: ctx.nameHint || null, summary,
    })
  } catch (err) {
    logWarn(LOG_MODULE, 'card alert failed; the card stands', { locationId: studio.locationId, op: `${OP_OF_KIND[kind] ?? 'card'}_alert`, requestId, status: null, errClass: err?.name ?? null })
  }
}

/** File (or reuse) a pending card of `kind` at the studio: { id (or null), reused }. */
async function fileOrReuseCard(db, ctx, studio, { kind, contactId, match, details, summary }) {
  const existing = await pendingCardId(db, studio, { kind, contactId, match })
  if (existing) return { id: existing, reused: true }
  const id = await insertRequest(db, ctx, studio, { kind, contactId, status: 'pending', details })
  if (id) await alertStaff(db, ctx, studio, { kind, requestId: id, summary })
  return { id, reused: false }
}

/** File (or reuse) a pending card of `kind` at the studio; its id or null. */
async function fileCard(db, ctx, studio, card) {
  return (await fileOrReuseCard(db, ctx, studio, card)).id
}

/** What D's result recorded on the request row says (un1t.online's words scrubbed). */
function recordedResult(result) {
  return {
    verdict: result?.verdict ?? null,
    code: result?.code ?? null,
    message: result?.message ? scrubMessage(result.message) : null,
    un1t_booking_id: result?.id ?? null,
    already_booked: result?.alreadyBooked === true,
    recovered: result?.recovered ?? null,
  }
}

/** booking_mode at the action studio: 'draft' when its settings are unreadable (never an unsanctioned write). */
const modeOf = (settings) => (settings ? (settings.booking_mode === 'draft' ? 'draft' : 'auto') : 'draft')

// MIAHATCH.6 — the studio's offer list and whether the free trial may be
// offered (purchase-intents.js's offersForBooking). Loaded lazily: that module
// imports this one for the booking steps the trial shares.
async function defaultOffersFor(ctx, studio) {
  const { offersForBooking } = await import('./purchase-intents')
  return offersForBooking(ctx, studio)
}

async function purchaseOptions(offersFor, ctx, studio) {
  try {
    const r = await offersFor(ctx, studio)
    return {
      offers: Array.isArray(r?.offers) ? r.offers : [],
      trial_available: r?.trial_available === true,
      trial_check_failed: r?.trial_check_failed === true,
    }
  } catch (err) {
    logWarn(LOG_MODULE, 'offer list unreadable; the no-credits card instead', { locationId: studio.locationId, op: 'book_offers', errClass: err?.name })
    return { offers: [], trial_available: false, trial_check_failed: false }
  }
}

// The free trial is offered first, and only when the tool said so (spec R1).
const TRIAL_FIRST = 'They can have the free trial: offer it first, before the paid offers. To give it, get a clear yes, then call send_purchase_link with offer_id "trial" and this class. Never say the trial is on their account or that the class is booked until a tool says so.'

const hasSomethingToOffer = (options) => options.offers.length > 0 || options.trial_available

function needsPurchase(options, settings, studio) {
  return {
    booked: false,
    needs_purchase: true,
    offers: options.offers,
    trial_available: options.trial_available,
    wording: renderMiaCopy('purchase_offer_intro_text', settings, { studio: studio.name }),
    ...(options.trial_available ? { message: TRIAL_FIRST } : {}),
  }
}

const summaryOf = (...parts) => parts.filter(Boolean).join(' · ')

// Which answerable un1t.online studio a mirror row (an event or a booking)
// belongs to: the only one, or (with several) the one whose mirror holds it.
async function un1tStudioHolding(db, studios, table, un1tId, op) {
  const un1t = (Array.isArray(studios) ? studios : []).filter((s) => s?.providerKey === PROVIDER)
  if (un1t.length <= 1) return un1t[0] ?? null
  const { data, error } = await db.from(table)
    .select('location_id')
    .in('location_id', un1t.map((s) => s.locationId))
    .eq('un1t_id', un1tId)
    .limit(1)
  if (error) {
    logWarn(LOG_MODULE, 'mirror read failed', { op, code: error.code ?? null })
    return null
  }
  const loc = data?.[0]?.location_id
  return un1t.find((s) => s.locationId === loc) ?? null
}

/**
 * Which answerable un1t.online studio a class is at: the only one, or (with
 * several) the one whose mirror holds the event. null when none does or the
 * read failed (the caller's pre-flight then answers class_unavailable).
 *
 * @param {object} db
 * @param {object[]} studios the turn's answerable studios
 * @param {string} eventId bare un1t.online id
 */
export function un1tStudioForEvent(db, studios, eventId) {
  return un1tStudioHolding(db, studios, 'un1t_events', eventId, 'book_event_studio')
}

/**
 * Which answerable un1t.online studio a booking is at, as un1tStudioForEvent
 * does for a class (the mirror's un1t_bookings). null when none does or the
 * read failed.
 *
 * @param {object} db
 * @param {object[]} studios the turn's answerable studios
 * @param {string} bookingId bare un1t.online id
 */
export function un1tStudioForBooking(db, studios, bookingId) {
  return un1tStudioHolding(db, studios, 'un1t_bookings', bookingId, 'cancel_booking_studio')
}

// ── the booking steps the free trial shares (MIAHATCH.6, Task 20) ───

/**
 * A class_booking card of Mia's at the studio (Task 16's filer): an open one
 * for this contact matching `match` is reused, else one is filed and the team
 * alerted. Its id, or null.
 *
 * @param {object} ctx tool context
 * @param {object} studio the un1t.online studio
 * @param {{ contactId: string, match: object, details: object, summary: string }} card
 */
export function fileUn1tBookingCard(ctx, studio, { contactId, match, details, summary }) {
  return fileCard(ctx.db, ctx, studio, { kind: BOOKING_KIND, contactId, match, details, summary })
}

/**
 * As fileUn1tBookingCard, and says whether an open card (or a pending
 * write-ahead row) was reused: { id, reused }. A reused row is not alerted
 * again here; the caller decides.
 */
export function fileOrReuseUn1tBookingCard(ctx, studio, { contactId, match, details, summary }) {
  return fileOrReuseCard(ctx.db, ctx, studio, { kind: BOOKING_KIND, contactId, match, details, summary })
}

/** A write-ahead class_booking row (status pending) at the studio: its id, or null (logged). */
export function insertUn1tBookingRow(ctx, studio, { contactId, details }) {
  return insertRequest(ctx.db, ctx, studio, { kind: BOOKING_KIND, contactId, status: 'pending', details })
}

/** Close out a write-ahead class_booking row; a failure is logged loudly. */
export function finishUn1tBookingRow(ctx, studio, requestId, { status, details }) {
  return finishRequest(ctx.db, studio, requestId, { status, details })
}

/** Alert the team about a class_booking row that became a card. */
export function alertUn1tBookingCard(ctx, studio, { requestId, summary }) {
  return alertStaff(ctx.db, ctx, studio, { kind: BOOKING_KIND, requestId, summary })
}

/**
 * book_class's pre-flight for a `un1t:` event id (step 1, after the account
 * check): the class in the mirror at the studio, scheduled, in the future and
 * in the latest pull; the relayed starts_at names it in the studio's zone
 * (Review Focus 4). Nothing is written.
 *
 * @returns {Promise<{ answer: object } | { booking: { eventId: string, className: string,
 *   classTime: string, executingContactId: string, mode: 'auto'|'draft', details: (extra?: object) => object } }>}
 */
export async function prepareUn1tBooking(ctx, input, studio, settings, nowMs) {
  const parsed = parseAgentId(input?.event_id)
  if (parsed?.provider !== PROVIDER) return { answer: classUnavailable('unknown_class') }
  const eventId = parsed.id

  const ev = await readEvent(ctx.db, studio, eventId, nowMs)
  if (ev.error) return { answer: { ...TRY_AGAIN } }
  if (ev.unavailable) return { answer: classUnavailable(ev.unavailable) }
  const zone = await zoneFor(ctx, studio)
  if (!relayedStartMatches(ev.event.starts_at, input?.starts_at, zone)) {
    logWarn(LOG_MODULE, 'relayed class time does not match the class; nothing sent', {
      locationId: studio.locationId, op: 'book', relayed: typeof input?.starts_at === 'string' ? 'given' : 'missing',
    })
    return { answer: classUnavailable('starts_at_mismatch') }
  }
  const className = String(ev.event.title || '').trim() || String(input?.class_name || '').trim() || 'Class'
  const classTime = labelOf(ev.startsMs, zone)
  const executingContactId = executingContactOf(ctx, studio)
  const mode = modeOf(settings)
  const details = (extra = {}) => ({
    provider: PROVIDER,
    origin: 'mia',
    reason: 'mia_booking',
    event_id: eventId,
    un1t_user_id: studio.un1tUserId,
    executing_contact_id: executingContactId,
    starts_at: new Date(ev.startsMs).toISOString(),
    class_name: className,
    class_time: classTime,
    mode,
    ...extra,
  })
  return { booking: { eventId, className, classTime, executingContactId, mode, details } }
}

/**
 * book_class's step 5 once its write-ahead row exists: D's book with a bare
 * event id, origin 'mia', originRef = the row id, actor null, and the row
 * finalised from D's verdict (every outcome book_class answers). The free
 * trial (purchase-intents.js) runs it on its own write-ahead row after D's
 * grantTrial said granted.
 *
 * @param {object} ctx tool context
 * @param {object} studio the un1t.online studio
 * @param {object} booking prepareUn1tBooking's `booking`
 * @param {string} requestId the write-ahead class_booking row
 * @param {{ settings: object|null, offersFor?: Function, afterTrial?: boolean, afterPurchase?: boolean }} opts
 *   afterTrial: D just granted the free trial, so a no_credits answer is a
 *   staff card (un1t_trial_granted_no_credits), never the offer list.
 *   afterPurchase (MIAHATCH.6 Task 21): the member has just paid for this
 *   class through Mia's link, so anything but booked or class_full is this
 *   row as ONE staff card, reason 'paid_booking_failed' (never the offer
 *   list, a try-again or the not-from-chat line): see paidBookingCard.
 * @returns {Promise<object>} book_class's answer
 */
export async function executeUn1tBook(ctx, studio, booking, requestId, { settings, offersFor = defaultOffersFor, afterTrial = false, afterPurchase = false } = {}) {
  const db = ctx.db
  const { eventId, className, classTime, executingContactId, details } = booking
  let result
  try {
    result = await book(db, {
      locationId: studio.locationId,
      contactId: executingContactId,
      un1tUserId: studio.un1tUserId,
      eventId,
      origin: 'mia',
      originRef: requestId,
      actor: null,
    })
  } catch (err) {
    // D rejects only before anything was sent (settings or ledger read).
    logError(LOG_MODULE, 'book was not sent', { locationId: studio.locationId, op: 'book', requestId, status: null, code: err?.code ?? null, errClass: err?.name })
    if (afterPurchase) return paidBookingCard(ctx, studio, booking, requestId, { paidOutcome: 'un1t_book_not_sent', details: details() })
    await finishRequest(db, studio, requestId, { status: 'failed', details: details({ reason: 'un1t_book_not_sent' }) })
    return handoffAnswer('un1t_book_not_sent', settings)
  }

  const recorded = (extra = {}) => details({ un1t_write_id: result?.ledgerId ?? null, result: recordedResult(result), ...extra })
  const words = recordedResult(result).message
  const outcome = un1tBookOutcome(result)

  if (afterPurchase && outcome !== 'booked' && outcome !== 'class_full') {
    return paidBookingCard(ctx, studio, booking, requestId, { paidOutcome: outcome, details: recorded() })
  }

  if (outcome === 'booked') {
    await finishRequest(db, studio, requestId, { status: 'actioned', details: recorded() })
    return { booked: true, class_name: className, class_time: classTime }
  }
  if (outcome === 'class_full') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'class_full' }) })
    return { ...CLASS_FULL }
  }
  if (outcome === 'retry') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'un1t_retry' }) })
    return { ...TRY_AGAIN }
  }
  if (outcome === 'writes_off') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'writes_off' }) })
    return writesOffAnswer(settings, studio, 'book')
  }
  if (outcome === 'no_credits' && afterTrial) {
    // The free trial was just given: never an upsell after it. This row is the card.
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'un1t_trial_granted_no_credits' }) })
    await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(className, classTime, 'free trial given but no credits showed, Mia handed over') })
    return handoffAnswer('un1t_trial_granted_no_credits', settings)
  }
  if (outcome === 'no_credits') {
    // A race after the pre-flight: the offer list, else this row is the card.
    const options = await purchaseOptions(offersFor, ctx, studio)
    if (options.trial_check_failed) {
      // The trial check failed: this row is the one card, nothing offered.
      await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'un1t_trial_check_failed' }) })
      await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(className, classTime, 'free trial check failed, Mia handed over') })
      return handoffAnswer('un1t_trial_check_failed', settings)
    }
    if (hasSomethingToOffer(options)) {
      await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'no_credits' }) })
      return needsPurchase(options, settings, studio)
    }
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'no_credits' }) })
    await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(className, classTime, 'no credits in un1t.online, Mia handed over') })
    return { ...NO_CREDITS }
  }
  if (outcome === 'card_rejected') {
    const quoted = words ? `: "${words}"` : ''
    const summary = `un1t.online refused this booking (${result?.code ?? 'no code'})${quoted}. Check the member in un1t.online, then Approve to try the booking again.`
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'booking_rejected', summary }) })
    await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(className, classTime, 'un1t.online refused the booking') })
    return handoffAnswer('booking_rejected', settings)
  }
  // card_unknown: D's check read already ran and could not tell.
  const summary = 'un1t.online did not confirm whether this booking went through. Check the class in un1t.online; Approve books it only if it is not there already.'
  await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'un1t_outcome_unknown', summary }) })
  await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(className, classTime, 'booking not confirmed by un1t.online') })
  return handoffAnswer('un1t_outcome_unknown', settings)
}

const PAID_CARD_SUMMARY = Object.freeze({
  card_unknown: 'The member paid for this class through Mia\'s payment link, but un1t.online did not confirm whether the booking went through. Check the class in un1t.online; Approve books it only if it is not there already.',
  default: 'The member paid for this class through Mia\'s payment link, but the booking did not go through. Check the member in un1t.online, then Approve to book the class.',
})

/**
 * MIAHATCH.6 (Task 21) — a paid class that did not book: the write-ahead row
 * becomes ONE pending class_booking card, reason 'paid_booking_failed' (not
 * record-only, so Approve runs D's executor and books it), with what D said
 * kept as `paid_outcome`, and the team is alerted. The member is told by the
 * caller (purchase_paid_booking_failed_text); the answer is internal.
 */
async function paidBookingCard(ctx, studio, booking, requestId, { paidOutcome, details }) {
  const summary = PAID_CARD_SUMMARY[paidOutcome] || PAID_CARD_SUMMARY.default
  await finishRequest(ctx.db, studio, requestId, { status: 'pending', details: { ...details, reason: 'paid_booking_failed', paid_outcome: paidOutcome, summary } })
  await alertStaff(ctx.db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: summaryOf(booking.className, booking.classTime, 'paid, booking not made, Mia handed over') })
  logWarn(LOG_MODULE, 'paid class not booked; staff card', { locationId: studio.locationId, op: 'paid_book', requestId, status: null, code: paidOutcome })
  return { booked: false, handoff: true, reason: 'paid_booking_failed', paid_outcome: paidOutcome, request_id: requestId }
}

/**
 * book_class for a `un1t:` event id at one un1t.online studio.
 *
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone,
 *   settings, actionStudio, channel, conversationId, nameHint)
 * @param {{ event_id: string, class_name?: string, class_time?: string, starts_at?: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @param {{ offersFor?: (ctx: object, studio: object) => Promise<{ offers: object[], trial_available: boolean, trial_check_failed?: boolean }>,
 *   now?: () => number }} [deps]
 * @returns {Promise<object>} one of: { booked: true, class_name, class_time },
 *   { booked: true, already_booked: true, ... }, { booked: false, needs_purchase: true, offers, trial_available, wording },
 *   { booked: false, no_credits: true }, { booked: false, error: 'class_unavailable', reason },
 *   { booked: false, reason: 'class_full' }, { booked: false, not_linked: true, booking_url },
 *   { booked: false, pending_approval: true }, { booked: false, try_again: true },
 *   { booked: false, handoff: true, reason: 'booking_rejected'|'un1t_outcome_unknown'|'un1t_book_not_sent'|'un1t_trial_check_failed'|'writes_off' }
 */
export async function un1tBookClass(ctx, input, studio, deps = {}) {
  const { offersFor = defaultOffersFor, now = () => Date.now() } = deps
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }

  // 1 guards.
  const settings = await actionSettings(ctx, studio)
  if (!studio.un1tUserId) return notLinked(studio, settings)
  const prepared = await prepareUn1tBooking(ctx, input, studio, settings, now())
  if (prepared.answer) return prepared.answer
  const { booking } = prepared
  const { eventId, className, classTime, executingContactId, mode, details } = booking

  // 2 already booked. One reader serves this and the ledger read.
  const reader = await openReader(db, studio, 'book')
  if (await alreadyHolds(db, studio, eventId, reader) === true) {
    return { booked: true, already_booked: true, class_name: className, class_time: classTime }
  }

  // 3 entitlement: only a confirmed "nothing" stops here.
  const ent = await fetchLiveEntitlement(db, { locationId: studio.locationId, un1tUserId: studio.un1tUserId }, { reader })
  const confirmedNothing = ent?.ok === true && ent.unlimited !== true && !(Number(ent.balance) > 0)
    && Array.isArray(ent.liveSubscriptionIds) && ent.liveSubscriptionIds.length === 0
  if (confirmedNothing) {
    const options = await purchaseOptions(offersFor, ctx, studio)
    if (options.trial_check_failed) {
      // MIAHATCH.6 — the trial check failed: no trial offered, one card, the team takes over.
      await fileCard(db, ctx, studio, {
        kind: BOOKING_KIND, contactId: executingContactId, match: { event_id: eventId },
        details: details({ reason: 'un1t_trial_check_failed' }),
        summary: summaryOf(className, classTime, 'free trial check failed, Mia handed over'),
      })
      return handoffAnswer('un1t_trial_check_failed', settings)
    }
    if (hasSomethingToOffer(options)) return needsPurchase(options, settings, studio)
    await fileCard(db, ctx, studio, {
      kind: BOOKING_KIND, contactId: executingContactId, match: { event_id: eventId },
      details: details({ reason: 'no_credits' }),
      summary: summaryOf(className, classTime, 'no credits or membership in un1t.online, Mia handed over'),
    })
    return { ...NO_CREDITS }
  }

  // 4 draft at the action studio.
  if (mode === 'draft') {
    const id = await fileCard(db, ctx, studio, {
      kind: BOOKING_KIND, contactId: executingContactId, match: { event_id: eventId }, details: details(),
      summary: summaryOf(className, classTime) || 'class booking to confirm',
    })
    return id ? { ...PENDING_APPROVAL } : { ...TRY_AGAIN }
  }

  // 5 auto: the write-ahead row, then D's book.
  const requestId = await insertRequest(db, ctx, studio, {
    kind: BOOKING_KIND, contactId: executingContactId, status: 'pending', details: details({ stage: 'executing' }),
  })
  if (!requestId) return { ...TRY_AGAIN }
  return executeUn1tBook(ctx, studio, booking, requestId, { settings, offersFor })
}

// ── cancel_class_booking ────────────────────────────────────────────

const liveBookingId = (row) => {
  const v = row?.id ?? row?.un1t_id
  return v === null || v === undefined || v === '' ? null : String(v)
}

/**
 * The class a booking is for, for the answer and the row: the mirror's title
 * and start (in the studio's zone) when it holds the event, else the live
 * row's embedded event, else what the model relayed. Never fatal.
 */
async function classOfBooking(db, ctx, studio, row, input) {
  const relayedName = String(input?.class_name || '').trim()
  const relayedTime = String(input?.class_time || '').trim()
  const embedded = row?.event && typeof row.event === 'object' ? row.event : null
  let event = null
  const eventId = liveEventId(row)
  if (eventId != null) {
    const { data, error } = await db.from('un1t_events')
      .select('title, starts_at')
      .eq('location_id', studio.locationId)
      .eq('un1t_id', String(eventId))
      .maybeSingle()
    if (error) logWarn(LOG_MODULE, 'mirror read failed', { locationId: studio.locationId, op: 'cancel_event', code: error.code ?? null })
    else event = data
  }
  const title = String(event?.title || embedded?.title || '').trim()
  const startsMs = Date.parse(event?.starts_at || embedded?.starts_at || '')
  const zone = Number.isFinite(startsMs) ? await zoneFor(ctx, studio) : null
  return {
    className: title || relayedName || 'Class',
    classTime: Number.isFinite(startsMs) ? labelOf(startsMs, zone) : (relayedTime || null),
    startsAt: Number.isFinite(startsMs) ? new Date(startsMs).toISOString() : null,
  }
}

/**
 * FEES.2 — the late-cancel quote for one booking, or null when it could not
 * be worked out (a failed read never stops a cancellation).
 */
async function quoteLateCancel(db, studio, reader, row, bookingId, startsAt, contactId = null) {
  const readWindowHours = async () => {
    if (!reader?.ok || !reader.studioId) return null
    const s = await reader.getOne(`/studios/${encodeURIComponent(reader.studioId)}`)
    const h = Number(s?.default_cancelation_window_hours)
    return Number.isFinite(h) && h > 0 ? h : null
  }
  try {
    return await lateCancelQuote(db, {
      locationId: studio.locationId,
      un1tUserId: studio.un1tUserId,
      contactId,
      bookingId,
      eventId: row ? (liveEventId(row) ?? null) : null,
      startsAt,
      creditCharged: row?.credit_charged === true,
      readWindowHours,
    })
  } catch (err) {
    logWarn(LOG_MODULE, 'late-cancel quote failed; cancelling without a warning', { locationId: studio.locationId, op: 'cancel_quote', status: null, errClass: err?.name, code: err?.code ?? null })
    return null
  }
}

/**
 * cancel_class_booking for a `un1t:` booking id at one un1t.online studio.
 *
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone,
 *   settings, actionStudio, channel, conversationId, nameHint)
 * @param {{ booking_id: string, class_name?: string, class_time?: string, confirm_late_fee?: boolean }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @returns {Promise<object>} one of: { cancelled: true, class_name, class_time },
 *   { cancelled: false, needs_confirmation: 'late_cancel_fee', message } (FEES.2: nothing sent),
 *   { cancelled: false, error: 'CANCELLATION_UNCERTAIN', reason: 'not_found'|'read_failed' },
 *   { cancelled: false, refused: 'late_cancel'|'already_happened', message },
 *   { cancelled: false, pending_approval: true }, { cancelled: false, try_again: true },
 *   { cancelled: false, not_linked: true },
 *   { cancelled: false, handoff: true, reason: 'cancel_rejected'|'cancel_outcome_unknown'|'un1t_cancel_not_sent'|'writes_off' }
 */
export async function un1tCancelBooking(ctx, input, studio) {
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }

  // 1 guards.
  const settings = await actionSettings(ctx, studio)
  if (!studio.un1tUserId) return cancelNotLinked(studio)
  const parsed = parseAgentId(input?.booking_id)
  if (parsed?.provider !== PROVIDER) return cancellationUncertain('not_found')
  const bookingId = parsed.id

  // 2 the booking is the member's: the LIVE list only. A failed read, or one
  // that does not hold it, sends nothing; a list the page cap cut short is no
  // proof of absence, so D's cancel decides (its mirror and answer checks
  // refuse another client's booking).
  const reader = await openReader(db, studio, 'cancel')
  const live = await liveBookings(db, studio, reader, 'cancel_bookings')
  if (!live) return cancellationUncertain('read_failed')
  const row = live.rows.find((r) => liveBookingId(r) === bookingId) ?? null
  if (!row && !live.truncated) {
    logWarn(LOG_MODULE, 'booking not among the member\'s live bookings; nothing sent', { locationId: studio.locationId, op: 'cancel', status: null })
    return cancellationUncertain('not_found')
  }

  const { className, classTime, startsAt } = await classOfBooking(db, ctx, studio, row, input)

  // UN1TMOVE.2 — a booking moved inside the late-cancel window is never
  // cancelled, by any path (no card either: staff could not approve it). A
  // failed read refuses (fail closed): a cancel not made can be done by staff
  // in the un1t.online console, a dodged late-cancel fee cannot be undone.
  let movedLate
  try {
    movedLate = await wasMovedInLateWindow(db, { locationId: studio.locationId, bookingId })
  } catch (err) {
    logWarn(LOG_MODULE, 'late-move read failed; nothing cancelled', { locationId: studio.locationId, op: 'cancel', status: null, code: err?.code ?? null })
    return cancellationUncertain('late_move_unreadable')
  }
  if (movedLate) return { cancelled: false, refused: 'moved_late', class_name: className, class_time: classTime, message: MOVED_LATE_NO_CANCEL }

  // FEES.2 — inside the studio's window, a fee (or the credit) is lost: the
  // member hears it first, and Mia cancels only on an explicit second call
  // with confirm_late_fee. An unreadable quote never blocks the cancel.
  if (input?.confirm_late_fee !== true) {
    const quote = await quoteLateCancel(db, studio, reader, row, bookingId, startsAt, executingContactOf(ctx, studio))
    if (quote?.applies) {
      return { cancelled: false, needs_confirmation: 'late_cancel_fee', class_name: className, class_time: classTime, message: lateCancelWarning(quote) }
    }
  }
  const executingContactId = executingContactOf(ctx, studio)
  const mode = modeOf(settings)
  const details = (extra = {}) => ({
    provider: PROVIDER,
    origin: 'mia',
    reason: 'mia_cancellation',
    booking_id: bookingId,
    un1t_user_id: studio.un1tUserId,
    executing_contact_id: executingContactId,
    starts_at: startsAt,
    class_name: className,
    class_time: classTime,
    mode,
    ...extra,
  })
  const card = { kind: CANCEL_KIND, contactId: executingContactId, match: { booking_id: bookingId } }

  // 3 draft at the action studio.
  if (mode === 'draft') {
    const id = await fileCard(db, ctx, studio, {
      ...card, details: details(), summary: summaryOf(className, classTime) || 'class cancellation to confirm',
    })
    return id ? { ...CANCEL_PENDING_APPROVAL } : { ...CANCEL_TRY_AGAIN }
  }

  // 4 auto: the write-ahead row, then D's cancel (an empty body, D's own).
  const requestId = await insertRequest(db, ctx, studio, {
    kind: CANCEL_KIND, contactId: executingContactId, status: 'pending', details: details({ stage: 'executing' }),
  })
  if (!requestId) return { ...CANCEL_TRY_AGAIN }

  let result
  try {
    result = await cancel(db, {
      locationId: studio.locationId,
      contactId: executingContactId,
      un1tUserId: studio.un1tUserId,
      bookingId,
      origin: 'mia',
      originRef: requestId,
      actor: null,
    })
  } catch (err) {
    // D rejects only before anything was sent (settings or mirror read).
    logError(LOG_MODULE, 'cancel was not sent', { locationId: studio.locationId, op: 'cancel', requestId, status: null, code: err?.code ?? null, errClass: err?.name })
    await finishRequest(db, studio, requestId, { status: 'failed', details: details({ reason: 'un1t_cancel_not_sent' }) })
    return handoffAnswer('un1t_cancel_not_sent', settings, 'cancel')
  }

  const recorded = (extra = {}) => details({ un1t_write_id: result?.ledgerId ?? null, result: recordedResult(result), ...extra })
  const words = recordedResult(result).message
  const quoted = words ? ` un1t.online said: "${words}".` : ''
  const outcome = un1tCancelOutcome(result)

  if (outcome === 'cancelled') {
    await finishRequest(db, studio, requestId, { status: 'actioned', details: recorded() })
    return { cancelled: true, class_name: className, class_time: classTime }
  }
  if (outcome === 'moved_late') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'moved_late' }) })
    return { cancelled: false, refused: 'moved_late', message: MOVED_LATE_NO_CANCEL }
  }
  if (outcome === 'late_cancel') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'late_cancel' }) })
    return {
      cancelled: false,
      refused: 'late_cancel',
      message: `un1t.online refused this cancellation as too late, so the booking is still in place.${quoted} Tell the customer honestly, using its reason. ${NEVER_PROMISE}`,
    }
  }
  if (outcome === 'already_happened') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'already_happened' }) })
    return {
      cancelled: false,
      refused: 'already_happened',
      message: `That class has already happened (attended or marked a no-show), so the booking was not cancelled. Tell the customer honestly. ${NEVER_PROMISE}`,
    }
  }
  if (outcome === 'retry') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'un1t_retry' }) })
    return { ...CANCEL_TRY_AGAIN }
  }
  if (outcome === 'writes_off') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'writes_off' }) })
    return writesOffAnswer(settings, studio, 'cancel')
  }
  if (outcome === 'card_rejected') {
    const summary = `un1t.online refused this cancellation (${result?.code ?? 'no code'})${words ? `: "${words}"` : ''}. Check the booking in un1t.online, then Approve to try the cancellation again.`
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'cancel_rejected', summary }) })
    await alertStaff(db, ctx, studio, { kind: CANCEL_KIND, requestId, summary: summaryOf(className, classTime, 'un1t.online refused the cancellation') })
    return handoffAnswer('cancel_rejected', settings, 'cancel')
  }
  // card_unknown: D's check read already ran and could not tell.
  const summary = 'un1t.online did not confirm whether this cancellation went through. Check the booking in un1t.online; Approve cancels it only if it is still booked.'
  await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'cancel_outcome_unknown', summary }) })
  await alertStaff(db, ctx, studio, { kind: CANCEL_KIND, requestId, summary: summaryOf(className, classTime, 'cancellation not confirmed by un1t.online') })
  return handoffAnswer('cancel_outcome_unknown', settings, 'cancel')
}

// ── move_class_booking ──────────────────────────────────────────────

const MOVE_TRY_AGAIN = Object.freeze({
  moved: false,
  try_again: true,
  message: 'The booking could not be moved just now and nothing was changed. Tell the customer and ask them to try again in a few minutes, or offer to hand off to the team. Never say it is moved.',
})
const MOVE_PENDING_APPROVAL = Object.freeze({
  moved: false,
  pending_approval: true,
  message: 'Queued for the team to confirm. Tell the customer the team will confirm the change shortly and they are still booked into their original class until then. Never say it is moved yet.',
})
const MOVE_UNCERTAIN = Object.freeze({
  not_found: 'That booking is not among this member\'s bookings, so nothing was moved. Call list_my_upcoming_bookings again and pass the booking_id exactly as listed; if it is not there, say you cannot find it and offer to hand off to the team.',
  read_failed: 'The member\'s bookings could not be checked just now, so nothing was moved. Say you cannot check it right now, and ask them to try again in a few minutes or offer to hand off to the team.',
})
const moveUncertain = (reason) => ({ moved: false, error: 'MOVE_UNCERTAIN', reason, message: MOVE_UNCERTAIN[reason] })
const moveNotLinked = (studio) => ({
  moved: false,
  not_linked: true,
  message: `No account was found for this person at ${studio.name}, so nothing was moved. Offer to hand off to the team.`,
})
// prepareUn1tBooking answers in book_class's words (`booked: false`); a move says `moved`.
function asMoveAnswer(answer) {
  const { booked: _booked, ...rest } = answer || {}
  const message = typeof rest.message === 'string' ? rest.message.replace(/nothing was booked/g, 'nothing was moved') : rest.message
  return { moved: false, ...rest, ...(message !== undefined ? { message } : {}) }
}

/**
 * move_class_booking for a `un1t:` booking id and a `un1t:` event id at one
 * un1t.online studio: ONE D moveBooking call (never a cancel then a book).
 *
 * @param {object} ctx tool context
 * @param {{ booking_id: string, event_id: string, starts_at: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @param {{ now?: () => number }} [deps]
 * @returns {Promise<object>} one of: { moved: true, class_name, class_time, from_class_name, from_class_time },
 *   { moved: false, reason: 'class_full'|'same_class'|'already_booked', message },
 *   { moved: false, refused: 'too_late'|'already_happened', message },
 *   { moved: false, error: 'MOVE_UNCERTAIN'|'class_unavailable', reason },
 *   { moved: false, pending_approval: true }, { moved: false, try_again: true }, { moved: false, not_linked: true },
 *   { moved: false, handoff: true, reason: 'move_rejected'|'move_outcome_unknown'|'un1t_move_not_sent'|'writes_off' }
 */
export async function un1tMoveBooking(ctx, input, studio, deps = {}) {
  const { now = () => Date.now() } = deps
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }

  // 1 guards: the account, the booking id, the target class (book_class's pre-flight).
  const settings = await actionSettings(ctx, studio)
  if (!studio.un1tUserId) return moveNotLinked(studio)
  const parsed = parseAgentId(input?.booking_id)
  if (parsed?.provider !== PROVIDER) return moveUncertain('not_found')
  const bookingId = parsed.id
  const prepared = await prepareUn1tBooking(ctx, { event_id: input?.event_id, starts_at: input?.starts_at, class_name: input?.class_name }, studio, settings, now())
  if (prepared.answer) return asMoveAnswer(prepared.answer)
  const { eventId, className, classTime, executingContactId, mode, details: targetDetails } = prepared.booking

  // 2 the booking is the member's: the LIVE list only, as for a cancel. A
  // truncated list without it is no proof of absence: D's ownership checks decide.
  const reader = await openReader(db, studio, 'move')
  const live = await liveBookings(db, studio, reader, 'move_bookings')
  if (!live) return moveUncertain('read_failed')
  const row = live.rows.find((r) => liveBookingId(r) === bookingId) ?? null
  if (!row && !live.truncated) {
    logWarn(LOG_MODULE, 'booking not among the member\'s live bookings; nothing sent', { locationId: studio.locationId, op: 'move', status: null })
    return moveUncertain('not_found')
  }
  const from = await classOfBooking(db, ctx, studio, row, {})
  const fromEventId = row ? (liveEventId(row) != null ? String(liveEventId(row)) : null) : null
  if (fromEventId === eventId) {
    return { moved: false, reason: 'same_class', message: `That booking is already for ${className} at ${classTime}, so nothing was changed. Tell the customer.` }
  }
  if (live.rows.some((r) => liveBookingId(r) !== bookingId && bookedOn(r, eventId))) {
    return { moved: false, reason: 'already_booked', message: `They are already booked into ${className} at ${classTime} in another booking, so nothing was moved. Ask whether they want to cancel the other one instead.` }
  }

  const details = (extra = {}) => targetDetails({
    reason: MOVE_REASON,
    move_from_booking_id: bookingId,
    move_from_event_id: fromEventId,
    move_from_class_name: from.className,
    move_from_class_time: from.classTime,
    summary: `Move from ${summaryOf(from.className, from.classTime)} to ${summaryOf(className, classTime)}`,
    ...extra,
  })
  const card = { kind: BOOKING_KIND, contactId: executingContactId, match: { event_id: eventId, move_from_booking_id: bookingId } }
  const cardSummary = summaryOf(className, classTime, `move from ${summaryOf(from.className, from.classTime)}`)

  // 3 UN1TMOVE.2 — inside the studio's cancellation window, only a class the
  // same studio day. An unreadable quote is no verdict here: D's moveBooking
  // works the window out again and refuses (nothing sent) when it cannot.
  const quote = await quoteLateCancel(db, studio, reader, row, bookingId, from.startsAt, executingContactId)
  if (quote?.applies) {
    const zone = await zoneFor(ctx, studio)
    const targetStarts = targetDetails().starts_at
    if (!sameStudioDay(from.startsAt, targetStarts, zone)) {
      return { moved: false, refused: 'late_other_day', message: LATE_OTHER_DAY_TEXT(summaryOf(from.className, from.classTime) || 'Their class') }
    }
  }

  // 4 draft at the action studio.
  if (mode === 'draft') {
    const id = await fileCard(db, ctx, studio, { ...card, details: details(), summary: cardSummary })
    return id ? { ...MOVE_PENDING_APPROVAL } : { ...MOVE_TRY_AGAIN }
  }

  // 5 auto: the write-ahead row, then D's move (one call).
  const requestId = await insertRequest(db, ctx, studio, {
    kind: BOOKING_KIND, contactId: executingContactId, status: 'pending', details: details({ stage: 'executing' }),
  })
  if (!requestId) return { ...MOVE_TRY_AGAIN }

  let result
  try {
    result = await moveBooking(db, {
      locationId: studio.locationId,
      contactId: executingContactId,
      un1tUserId: studio.un1tUserId,
      bookingId,
      eventId,
      fromEventId,
      origin: 'mia',
      originRef: requestId,
      actor: null,
    })
  } catch (err) {
    // D rejects only before anything was sent (settings, mirror or ledger read).
    logError(LOG_MODULE, 'move was not sent', { locationId: studio.locationId, op: 'move', requestId, status: null, code: err?.code ?? null, errClass: err?.name })
    await finishRequest(db, studio, requestId, { status: 'failed', details: details({ reason: 'un1t_move_not_sent' }) })
    return handoffAnswer('un1t_move_not_sent', settings, 'move')
  }

  const recorded = (extra = {}) => details({ un1t_write_id: result?.ledgerId ?? null, result: recordedResult(result), ...extra })
  const words = recordedResult(result).message
  const quoted = words ? ` un1t.online said: "${words}".` : ''
  const stays = `They are still booked into ${from.className}${from.classTime ? ` at ${from.classTime}` : ''}.`
  const outcome = un1tMoveOutcome(result)

  if (outcome === 'moved') {
    await finishRequest(db, studio, requestId, { status: 'actioned', details: recorded() })
    return { moved: true, class_name: className, class_time: classTime, from_class_name: from.className, from_class_time: from.classTime }
  }
  if (outcome === 'class_full') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'class_full' }) })
    return { moved: false, reason: 'class_full', message: `That class is full, so the booking was not moved. ${stays} Say so honestly and offer another class from list_upcoming_classes.` }
  }
  if (outcome === 'same_class') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'same_class' }) })
    return { moved: false, reason: 'same_class', message: `That booking is already for ${className}, so nothing was changed. Tell the customer.` }
  }
  if (outcome === 'late_other_day') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'late_other_day' }) })
    return { moved: false, refused: 'late_other_day', message: LATE_OTHER_DAY_TEXT(summaryOf(from.className, from.classTime) || 'Their class') }
  }
  if (outcome === 'too_late' || outcome === 'already_happened') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: outcome }) })
    const lead = outcome === 'too_late'
      ? `un1t.online refused this move as too late, so the booking was not moved.${quoted}`
      : 'That class has already happened (attended or marked a no-show), so the booking was not moved.'
    return { moved: false, refused: outcome, message: `${lead} ${stays} Tell the customer honestly. ${NEVER_PROMISE}` }
  }
  if (outcome === 'retry') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'un1t_retry' }) })
    return { ...MOVE_TRY_AGAIN }
  }
  if (outcome === 'writes_off') {
    await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'writes_off' }) })
    return writesOffAnswer(settings, studio, 'move')
  }
  if (outcome === 'card_rejected') {
    const summary = `un1t.online refused this move (${result?.code ?? 'no code'})${words ? `: "${words}"` : ''}. Check the booking in un1t.online, then Approve to try the move again.`
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'move_rejected', summary }) })
    await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: `${cardSummary}, un1t.online refused the move` })
    return handoffAnswer('move_rejected', settings, 'move')
  }
  // card_unknown: D's check read already ran and could not tell.
  const summary = 'un1t.online did not confirm whether this booking was moved. Check the booking in un1t.online; Approve moves it only if it is still in the original class.'
  await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'move_outcome_unknown', summary }) })
  await alertStaff(db, ctx, studio, { kind: BOOKING_KIND, requestId, summary: `${cardSummary}, move not confirmed by un1t.online` })
  return handoffAnswer('move_outcome_unknown', settings, 'move')
}

// ── request_refund ──────────────────────────────────────────────────

/**
 * The originRef of a Mia refund card (Ruling 27). D's fileRefundCard dedupes
 * pending cards on details->>origin_ref, so the ref is keyed per booking:
 * `<conversationId>:<bare booking id | none>`. A repeat about the same
 * booking in the same chat reuses the card; another booking files its own.
 * Never null (a null ref would match any staff or funnel card with none):
 * with no conversation it is `mia-noconv:<contact or un1t user>:<booking | none>`,
 * a prefix no other filer uses. Pure.
 *
 * @param {{ conversationId?: string|null, contactId?: string|null, un1tUserId?: string|null, bookingId?: string|null }} args
 * @returns {string}
 */
export function refundOriginRef({ conversationId = null, contactId = null, un1tUserId = null, bookingId = null } = {}) {
  const booking = bookingId || 'none'
  if (conversationId) return `${conversationId}:${booking}`
  return `mia-noconv:${contactId || un1tUserId || 'unknown'}:${booking}`
}

/**
 * request_refund at one un1t.online studio: one record-only refund_request
 * card (D's fileRefundCard, reason 'member_request', origin 'mia', originRef
 * from refundOriginRef: one card per booking per chat).
 * No un1t.online call and nothing refunded (R2). The member's own words
 * (input.reason) are not stored or logged: fileRefundCard has no field for
 * free text, and they may hold personal details. The answer is the studio's
 * refund_request_text either way: a card that could not be filed is logged
 * (ids only), never a louder failure to the member.
 *
 * @param {object} ctx tool context
 * @param {{ reason?: string, booking_id?: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @returns {Promise<{ filed: boolean, text: string }|object>}
 */
export async function requestRefund(ctx, input, studio) {
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }
  const settings = await actionSettings(ctx, studio)
  const parsed = parseAgentId(input?.booking_id)
  const conversationId = ctx.conversationId || null
  const contactId = executingContactOf(ctx, studio)
  const un1tUserId = studio.un1tUserId || null
  const bookingId = parsed?.provider === PROVIDER ? parsed.id : null
  let approvalId = null
  let errClass = null
  try {
    ({ approvalId = null } = await fileRefundCard(db, {
      locationId: studio.locationId,
      contactId,
      un1tUserId,
      reason: 'member_request',
      bookingId,
      origin: 'mia',
      originRef: refundOriginRef({ conversationId, contactId, un1tUserId, bookingId }),
      conversationId,
      channel: 'whatsapp',
    }) || {})
  } catch (err) {
    approvalId = null
    errClass = err?.name ?? 'Error'
  }
  if (!approvalId) {
    logError(LOG_MODULE, 'refund request card not filed; the member was told it was passed on', { locationId: studio.locationId, op: 'refund_request', conversationId, status: null, errClass })
  }
  return { filed: approvalId != null, text: renderMiaCopy('refund_request_text', settings, { studio: studio.name }) }
}
