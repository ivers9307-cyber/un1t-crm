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
// request_refund (Task 17): one record-only refund_request card through D's
// fileRefundCard (R2: nothing is refunded, no un1t.online call), answered with
// the operator's refund_request_text whether or not the card was filed.
//
// Every card this files is a class_booking or class_cancellation row with
// details.provider 'un1t_online' at the un1t.online studio, carrying the keys
// D's executeUn1tApproval reads (event_id or booking_id bare, starts_at,
// class_name, executing_contact_id, un1t_user_id), so a staff approval runs
// D's executor.
import { book, cancel } from '@/lib/un1t-online-write-ops'
import { UN1T_WRITE_CODES } from '@/lib/un1t-online-write'
import { fileRefundCard } from '@/lib/un1t-online-approval'
import { classifyRefusal, scrubMessage } from '@/lib/un1t-online-write-judge'
import { freshCutoff } from '@/lib/un1t-online-freshness'
import { logError, logWarn } from '@/lib/log'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { notifyAgentApprovalRequest } from './approval-notify'
import { formatClassTime } from './dublin-format'
import { renderMiaCopy } from './mia-copy'
import { parseAgentId } from './studio-ids'
import { TOOL_NOT_AT_THIS_STUDIO } from './tool-capability'
import { openUn1tMemberReader, fetchLiveUn1tBookings, fetchLiveEntitlement } from './un1t-member-read'
// MIAHATCH.6 — the studio's offer list (listPurchaseOptions) for needs_purchase.
import { offersForBooking } from './purchase-intents'
import { UN1T_BOOKED_STATUS, UN1T_EVENT_SCHEDULED_STATUS, zoneFor } from './un1t-tools'

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const C = UN1T_WRITE_CODES
const WRITES_OFF_CODES = new Set([C.WRITES_OFF, C.PERMISSION_MISSING])
// D's RETRYABLE set (un1t-online-write.js): nothing was sent, a later try is safe.
const RETRY_CODES = new Set([C.RATE_BUDGET, C.RATE_LIMITED, C.ATTEMPT_IN_FLIGHT, C.PERMISSIONS_UNREADABLE])

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
  if (refusalKind(result) === 'late_cancel') return 'late_cancel'
  return 'card_rejected'
}

// An ISO-looking relay, and one that names its offset (Z or ±hh:mm). An
// offset-less one would be read in the host's zone by Date.parse (CLAUDE.md
// forbids), so it is refused as no match.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const normLabel = (s) => String(s).toLowerCase().replace(/[,\s]+/g, ' ').trim()
const labelOf = (ms, zone) => formatClassTime(Math.floor(ms / 1000), zone)

/**
 * Does the class time the model relayed name this class? Both sides are
 * compared as formatClassTime labels in the studio's own zone: the relayed
 * label as given (case, spaces and commas aside), or an ISO instant WITH an
 * offset (Z or ±hh:mm) rendered in that zone; an offset-less ISO is no match. A label for another studio's class, or one rendered with the
 * wrong offset across a DST change, does not match. Missing is no match. Pure.
 *
 * @param {string} eventStartsAtIso the class's starts_at (mirror)
 * @param {string|null|undefined} relayed the starts_at the model passed
 * @param {string} zone the studio's IANA zone
 */
export function relayedStartMatches(eventStartsAtIso, relayed, zone) {
  const eventMs = Date.parse(eventStartsAtIso || '')
  if (!Number.isFinite(eventMs) || typeof relayed !== 'string' || !relayed.trim()) return false
  const want = labelOf(eventMs, zone)
  const given = relayed.trim()
  if (ISO_LIKE.test(given)) {
    if (!ISO_WITH_OFFSET.test(given)) return false
    const givenMs = Date.parse(given)
    return Number.isFinite(givenMs) && labelOf(givenMs, zone) === want
  }
  return normLabel(given) === normLabel(want)
}

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
const HANDOFF_LEAD = Object.freeze({
  booking_rejected: 'un1t.online did not accept this booking, and the team has been asked to sort it out.',
  un1t_outcome_unknown: 'un1t.online did not confirm whether this booking went through, and the team has been asked to check.',
  un1t_book_not_sent: 'The booking could not be sent just now, so nothing was booked.',
  cancel_rejected: 'un1t.online did not accept this cancellation, and the team has been asked to sort it out.',
  cancel_outcome_unknown: 'un1t.online did not confirm whether this cancellation went through, and the team has been asked to check.',
  un1t_cancel_not_sent: 'The cancellation could not be sent just now, so nothing was cancelled.',
})
// The result flag each write answers on, and what the model must never claim.
const ACTIONS = Object.freeze({
  book: Object.freeze({ flag: 'booked', never: 'Never say the booking is confirmed.' }),
  cancel: Object.freeze({ flag: 'cancelled', never: 'Never say it is cancelled.' }),
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
})
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

/** The action studio's resolved Mia settings (booking_mode, booking_url, copy), or null. */
async function actionSettings(ctx, studio) {
  let settings = null
  try {
    settings = typeof ctx.actionStudio === 'function' ? await ctx.actionStudio(studio.locationId) : null
  } catch {
    settings = null
  }
  if (!settings && studio.locationId === ctx.locationId) settings = ctx.settings || null
  return settings
}

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

/** An open (pending) card of this kind for this contact at the studio matching `match` in details, or null. */
async function pendingCardId(db, studio, { kind, contactId, match }) {
  const { data, error } = await db.from('agent_membership_requests')
    .select('id')
    .eq('location_id', studio.locationId)
    .eq('contact_id', contactId)
    .eq('kind', kind)
    .eq('status', 'pending')
    .contains('details', { provider: PROVIDER, ...match })
    .limit(1)
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

async function alertStaff(db, ctx, studio, { kind, requestId, summary }) {
  await notifyAgentApprovalRequest(db, {
    requestId, locationId: studio.locationId, kind, customerName: ctx.nameHint || null, summary,
  })
}

/** File (or reuse) a pending card of `kind` at the studio; its id or null. */
async function fileCard(db, ctx, studio, { kind, contactId, match, details, summary }) {
  const existing = await pendingCardId(db, studio, { kind, contactId, match })
  if (existing) return existing
  const id = await insertRequest(db, ctx, studio, { kind, contactId, status: 'pending', details })
  if (id) await alertStaff(db, ctx, studio, { kind, requestId: id, summary })
  return id
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

/** The account's own contact runs a write (and is its card's contact): the verified one when it holds the account, else the studio's first. */
function executingContactOf(ctx, studio) {
  const ids = Array.isArray(studio.contactIds) ? studio.contactIds.filter(Boolean) : []
  return ids.includes(ctx.verifiedContactId) ? ctx.verifiedContactId : (ids[0] || ctx.verifiedContactId)
}

/** booking_mode at the action studio: 'draft' when its settings are unreadable (never an unsanctioned write). */
const modeOf = (settings) => (settings ? (settings.booking_mode === 'draft' ? 'draft' : 'auto') : 'draft')

async function purchaseOptions(offersFor, ctx, studio) {
  try {
    const r = await offersFor(ctx, studio)
    return { offers: Array.isArray(r?.offers) ? r.offers : [], trial_available: r?.trial_available === true }
  } catch (err) {
    logWarn(LOG_MODULE, 'offer list unreadable; the no-credits card instead', { locationId: studio.locationId, op: 'book_offers', errClass: err?.name })
    return { offers: [], trial_available: false }
  }
}

const needsPurchase = (options, settings, studio) => ({
  booked: false,
  needs_purchase: true,
  offers: options.offers,
  trial_available: options.trial_available,
  wording: renderMiaCopy('purchase_offer_intro_text', settings, { studio: studio.name }),
})

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

/**
 * book_class for a `un1t:` event id at one un1t.online studio.
 *
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone,
 *   settings, actionStudio, channel, conversationId, nameHint)
 * @param {{ event_id: string, class_name?: string, class_time?: string, starts_at?: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @param {{ offersFor?: (ctx: object, studio: object) => Promise<{ offers: object[], trial_available: boolean }>,
 *   now?: () => number }} [deps]
 * @returns {Promise<object>} one of: { booked: true, class_name, class_time },
 *   { booked: true, already_booked: true, ... }, { booked: false, needs_purchase: true, offers, trial_available, wording },
 *   { booked: false, no_credits: true }, { booked: false, error: 'class_unavailable', reason },
 *   { booked: false, reason: 'class_full' }, { booked: false, not_linked: true, booking_url },
 *   { booked: false, pending_approval: true }, { booked: false, try_again: true },
 *   { booked: false, handoff: true, reason: 'booking_rejected'|'un1t_outcome_unknown'|'un1t_book_not_sent'|'writes_off' }
 */
export async function un1tBookClass(ctx, input, studio, deps = {}) {
  const { offersFor = offersForBooking, now = () => Date.now() } = deps
  const db = ctx?.db
  if (!ctx?.verifiedContactId) return { ...NOT_VERIFIED }
  if (!studio || studio.providerKey !== PROVIDER) return { ...TOOL_NOT_AT_THIS_STUDIO }

  // 1 guards.
  const settings = await actionSettings(ctx, studio)
  if (!studio.un1tUserId) return notLinked(studio, settings)
  const parsed = parseAgentId(input?.event_id)
  if (parsed?.provider !== PROVIDER) return classUnavailable('unknown_class')
  const eventId = parsed.id

  const ev = await readEvent(db, studio, eventId, now())
  if (ev.error) return { ...TRY_AGAIN }
  if (ev.unavailable) return classUnavailable(ev.unavailable)
  const zone = await zoneFor(ctx, studio)
  if (!relayedStartMatches(ev.event.starts_at, input?.starts_at, zone)) {
    logWarn(LOG_MODULE, 'relayed class time does not match the class; nothing sent', {
      locationId: studio.locationId, op: 'book', relayed: typeof input?.starts_at === 'string' ? 'given' : 'missing',
    })
    return classUnavailable('starts_at_mismatch')
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
    if (options.offers.length) return needsPurchase(options, settings, studio)
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
    await finishRequest(db, studio, requestId, { status: 'failed', details: details({ reason: 'un1t_book_not_sent' }) })
    return handoffAnswer('un1t_book_not_sent', settings)
  }

  const recorded = (extra = {}) => details({ un1t_write_id: result?.ledgerId ?? null, result: recordedResult(result), ...extra })
  const words = recordedResult(result).message
  const outcome = un1tBookOutcome(result)

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
  if (outcome === 'no_credits') {
    // A race after the pre-flight: the offer list, else this row is the card.
    const options = await purchaseOptions(offersFor, ctx, studio)
    if (options.offers.length) {
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
 * cancel_class_booking for a `un1t:` booking id at one un1t.online studio.
 *
 * @param {object} ctx tool context (db, verifiedContactId, locationId, zone,
 *   settings, actionStudio, channel, conversationId, nameHint)
 * @param {{ booking_id: string, class_name?: string, class_time?: string }} input
 * @param {import('./member-studios').MemberStudio} studio the answerable un1t.online studio
 * @returns {Promise<object>} one of: { cancelled: true, class_name, class_time },
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
