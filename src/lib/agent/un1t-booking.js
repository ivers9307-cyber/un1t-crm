// MIAHATCH.5 — book_class at a un1t.online studio (Hatch Street) from chat,
// through spec D's `book` (src/lib/un1t-online-write-ops.js). Reached only in
// tool block 3b (`un1t_full`: WhatsApp, the studio's writes_enabled and its
// Mia switch un1t_chat_actions_enabled), after refuseToolForTurn has passed,
// and only for a `un1t:` event id (booking-tools.js dispatches, lazily).
//
// The steps (spec 6.4):
//   1 guards     verified; the studio's un1t.online account (none: not_linked,
//                with the studio's booking link); the class in the mirror at
//                that studio, scheduled, in the future and in the latest pull
//                (else class_unavailable: a class removed in un1t.online stays
//                'scheduled' in the mirror, #2137); the relayed starts_at
//                renders to the same label as the class in the studio's own
//                zone (Review Focus 4), else refused before anything is sent.
//   2 booked?    the live bookings (the mirror when the live read fails or
//                was cut short) already hold the class: booked, no write.
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
// Every card this files is a class_booking row with details.provider
// 'un1t_online' at the un1t.online studio, carrying the keys D's
// executeUn1tApproval reads (event_id bare, starts_at, class_name,
// executing_contact_id, un1t_user_id), so a staff approval runs D's executor.
import { book } from '@/lib/un1t-online-write-ops'
import { UN1T_WRITE_CODES } from '@/lib/un1t-online-write'
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
import { UN1T_BOOKED_STATUS, UN1T_EVENT_SCHEDULED_STATUS, zoneFor } from './un1t-tools'

const LOG_MODULE = 'mia-un1t'
const PROVIDER = 'un1t_online'
const C = UN1T_WRITE_CODES
const WRITES_OFF_CODES = new Set([C.WRITES_OFF, C.PERMISSION_MISSING])
// D's RETRYABLE set (un1t-online-write.js): nothing was sent, a later try is safe.
const RETRY_CODES = new Set([C.RATE_BUDGET, C.RATE_LIMITED, C.ATTEMPT_IN_FLIGHT, C.PERMISSIONS_UNREADABLE])

// ── pure ────────────────────────────────────────────────────────────

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
  const verdict = result?.verdict
  if (verdict === 'done') return 'booked'
  if (verdict !== 'refused') return 'card_unknown'
  const code = result.code ?? null
  if (WRITES_OFF_CODES.has(code)) return 'writes_off'
  if (result.retryable === true || RETRY_CODES.has(code)) return 'retry'
  const kind = classifyRefusal({ code, message: result.message ?? null })
  if (kind === 'class_full') return 'class_full'
  if (kind === 'no_credits') return 'no_credits'
  return 'card_rejected'
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const normLabel = (s) => String(s).toLowerCase().replace(/[,\s]+/g, ' ').trim()
const labelOf = (ms, zone) => formatClassTime(Math.floor(ms / 1000), zone)

/**
 * Does the class time the model relayed name this class? Both sides are
 * compared as formatClassTime labels in the studio's own zone: the relayed
 * label as given (case, spaces and commas aside), or an ISO instant rendered
 * in that zone. A label for another studio's class, or one rendered with the
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
  if (ISO_INSTANT.test(given)) {
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
})

const classUnavailable = (reason) => ({ booked: false, error: 'class_unavailable', reason, message: CLASS_UNAVAILABLE[reason] })

function handoffAnswer(reason, settings) {
  const text = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
  return {
    booked: false,
    handoff: true,
    reason,
    message: `${HANDOFF_LEAD[reason]} Tell the customer, staying close to this wording: "${text}". Never say the booking is confirmed.`,
  }
}

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

const bookedOn = (row, eventId) => {
  if (!row || String(row.status || '').toLowerCase() !== UN1T_BOOKED_STATUS) return false
  const ev = row.event_id ?? (row.event && typeof row.event === 'object' ? row.event.id : undefined)
  return ev != null && String(ev) === eventId
}

/**
 * Does the member already hold this class? true / false, or null when nothing
 * could say (then D's book arbitrates: its own done-check reads first).
 */
async function alreadyHolds(db, studio, eventId, reader) {
  let live
  try {
    live = await fetchLiveUn1tBookings(db, { locationId: studio.locationId, un1tUserId: studio.un1tUserId }, { reader })
  } catch (err) {
    logWarn(LOG_MODULE, 'live bookings read threw', { locationId: studio.locationId, op: 'book_bookings', status: null, errClass: err?.name })
    live = { ok: false }
  }
  if (live?.ok) {
    if (live.rows.some((r) => bookedOn(r, eventId))) return true
    if (!live.truncated) return false
  }
  // The live list failed or was cut short: the mirror answers (minutes behind).
  const { data, error } = await db.from('un1t_bookings')
    .select('un1t_id')
    .eq('location_id', studio.locationId)
    .eq('un1t_user_id', studio.un1tUserId)
    .eq('event_id', eventId)
    .eq('status', UN1T_BOOKED_STATUS)
    .limit(1)
  if (error) {
    logWarn(LOG_MODULE, 'mirror read failed', { locationId: studio.locationId, op: 'book_bookings_mirror', code: error.code ?? null })
    return null
  }
  return Array.isArray(data) && data.length > 0
}

/** An open (pending) card for this class and contact at the studio, or null. */
async function pendingCardId(db, studio, contactId, eventId) {
  const { data, error } = await db.from('agent_membership_requests')
    .select('id')
    .eq('location_id', studio.locationId)
    .eq('contact_id', contactId)
    .eq('kind', 'class_booking')
    .eq('status', 'pending')
    .contains('details', { provider: PROVIDER, event_id: eventId })
    .limit(1)
  if (error) {
    // A duplicate card is better than none: carry on and file one.
    logWarn(LOG_MODULE, 'pending card read failed', { locationId: studio.locationId, op: 'book_card_dedupe', code: error.code ?? null })
    return null
  }
  return data?.[0]?.id ?? null
}

/** Insert one class_booking row at the studio; its id, or null (logged). */
async function insertRequest(db, ctx, studio, { contactId, status, details }) {
  try {
    const { data, error } = await db.from('agent_membership_requests').insert({
      location_id: studio.locationId,
      contact_id: contactId,
      kind: 'class_booking',
      channel: ctx.channel || null,
      conversation_id: ctx.conversationId || null,
      details,
      status,
    }).select('id').single()
    if (error || !data?.id) {
      logError(LOG_MODULE, 'booking request row not written', { locationId: studio.locationId, op: 'book_request', status: null, code: error?.code ?? null })
      return null
    }
    return data.id
  } catch (err) {
    logError(LOG_MODULE, 'booking request row insert threw', { locationId: studio.locationId, op: 'book_request', status: null, errClass: err?.name })
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
      logError(LOG_MODULE, 'booking request row not finalised', { locationId: studio.locationId, op: 'book_request', requestId, status: null, code: error?.code ?? null })
    }
  } catch (err) {
    logError(LOG_MODULE, 'booking request row finalise threw', { locationId: studio.locationId, op: 'book_request', requestId, status: null, errClass: err?.name })
  }
}

async function alertStaff(db, ctx, studio, requestId, summary) {
  await notifyAgentApprovalRequest(db, {
    requestId, locationId: studio.locationId, kind: 'class_booking', customerName: ctx.nameHint || null, summary,
  })
}

/** File (or reuse) a pending card at the studio; its id or null. */
async function fileCard(db, ctx, studio, { contactId, eventId, details, summary }) {
  const existing = await pendingCardId(db, studio, contactId, eventId)
  if (existing) return existing
  const id = await insertRequest(db, ctx, studio, { contactId, status: 'pending', details })
  if (id) await alertStaff(db, ctx, studio, id, summary)
  return id
}

/** PR 5: no offer list yet (Task 19 plugs listPurchaseOptions in here). */
async function noOffers() {
  return { offers: [], trial_available: false }
}

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

/**
 * Which answerable un1t.online studio a class is at: the only one, or (with
 * several) the one whose mirror holds the event. null when none does or the
 * read failed (the caller's pre-flight then answers class_unavailable).
 *
 * @param {object} db
 * @param {object[]} studios the turn's answerable studios
 * @param {string} eventId bare un1t.online id
 */
export async function un1tStudioForEvent(db, studios, eventId) {
  const un1t = (Array.isArray(studios) ? studios : []).filter((s) => s?.providerKey === PROVIDER)
  if (un1t.length <= 1) return un1t[0] ?? null
  const { data, error } = await db.from('un1t_events')
    .select('location_id')
    .in('location_id', un1t.map((s) => s.locationId))
    .eq('un1t_id', eventId)
    .limit(1)
  if (error) {
    logWarn(LOG_MODULE, 'mirror read failed', { op: 'book_event_studio', code: error.code ?? null })
    return null
  }
  const loc = data?.[0]?.location_id
  return un1t.find((s) => s.locationId === loc) ?? null
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
  const { offersFor = noOffers, now = () => Date.now() } = deps
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
  const ids = Array.isArray(studio.contactIds) ? studio.contactIds.filter(Boolean) : []
  // The account's own contact runs the write (and is the card's contact):
  // the verified one when it holds the account, else the studio's first.
  const executingContactId = ids.includes(ctx.verifiedContactId) ? ctx.verifiedContactId : (ids[0] || ctx.verifiedContactId)
  const mode = settings ? (settings.booking_mode === 'draft' ? 'draft' : 'auto') : 'draft'
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
  let reader
  try {
    reader = await openUn1tMemberReader(db, studio.locationId)
  } catch (err) {
    logWarn(LOG_MODULE, 'reader open threw', { locationId: studio.locationId, op: 'book', status: null, errClass: err?.name })
    reader = { ok: false, reason: 'read_failed' }
  }
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
      contactId: executingContactId, eventId,
      details: details({ reason: 'no_credits' }),
      summary: summaryOf(className, classTime, 'no credits or membership in un1t.online, Mia handed over'),
    })
    return { ...NO_CREDITS }
  }

  // 4 draft at the action studio.
  if (mode === 'draft') {
    const id = await fileCard(db, ctx, studio, {
      contactId: executingContactId, eventId, details: details(),
      summary: summaryOf(className, classTime) || 'class booking to confirm',
    })
    return id ? { ...PENDING_APPROVAL } : { ...TRY_AGAIN }
  }

  // 5 auto: the write-ahead row, then D's book.
  const requestId = await insertRequest(db, ctx, studio, {
    contactId: executingContactId, status: 'pending', details: details({ stage: 'executing' }),
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

  const words = result?.message ? scrubMessage(result.message) : null
  const recorded = (extra = {}) => details({
    un1t_write_id: result?.ledgerId ?? null,
    result: {
      verdict: result?.verdict ?? null,
      code: result?.code ?? null,
      message: words,
      un1t_booking_id: result?.id ?? null,
      already_booked: result?.alreadyBooked === true,
      recovered: result?.recovered ?? null,
    },
    ...extra,
  })
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
    return {
      booked: false,
      handoff: true,
      reason: 'writes_off',
      chat_booking_unavailable: true,
      text: renderMiaCopy('chat_booking_unavailable_text', settings, { studio: studio.name, link: settings?.booking_url || null }),
    }
  }
  if (outcome === 'no_credits') {
    // A race after the pre-flight: the offer list, else this row is the card.
    const options = await purchaseOptions(offersFor, ctx, studio)
    if (options.offers.length) {
      await finishRequest(db, studio, requestId, { status: 'failed', details: recorded({ reason: 'no_credits' }) })
      return needsPurchase(options, settings, studio)
    }
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'no_credits' }) })
    await alertStaff(db, ctx, studio, requestId, summaryOf(className, classTime, 'no credits in un1t.online, Mia handed over'))
    return { ...NO_CREDITS }
  }
  if (outcome === 'card_rejected') {
    const quoted = words ? `: "${words}"` : ''
    const summary = `un1t.online refused this booking (${result?.code ?? 'no code'})${quoted}. Check the member in un1t.online, then Approve to try the booking again.`
    await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'booking_rejected', summary }) })
    await alertStaff(db, ctx, studio, requestId, summaryOf(className, classTime, 'un1t.online refused the booking'))
    return handoffAnswer('booking_rejected', settings)
  }
  // card_unknown: D's check read already ran and could not tell.
  const summary = 'un1t.online did not confirm whether this booking went through. Check the class in un1t.online; Approve books it only if it is not there already.'
  await finishRequest(db, studio, requestId, { status: 'pending', details: recorded({ reason: 'un1t_outcome_unknown', summary }) })
  await alertStaff(db, ctx, studio, requestId, summaryOf(className, classTime, 'booking not confirmed by un1t.online'))
  return handoffAnswer('un1t_outcome_unknown', settings)
}
