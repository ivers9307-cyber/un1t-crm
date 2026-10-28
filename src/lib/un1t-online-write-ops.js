// UN1TWRITE.6 — the un1t.online write primitives: book, cancel, moveBooking
// (UN1TMOVE.1), createClient, forgotPassword, createCheckoutLink, grantTrial
// (UN1TWRITE.10; with its one-off credit re-grant, regrantTrialCredits,
// TRIALREGRANT.1), chargeClassFee (FEES.1) and grantCompCredits (staff's
// complimentary credits, UN1TCOMP.1). Split out of un1t-online-write.js (the transport), which they
// call ONLY through createUn1tWriter, plus the ledger and the mirror
// (un1t-online-mirror-write.js).

import { randomBytes } from 'node:crypto'
import {
  createUn1tWriter,
  Un1tWriteRefused,
  Un1tWriteUnknown,
  UN1T_WRITE_CODES,
  phoneForms,
  _un1tWriteInternals,
} from './un1t-online-write.js'
import { scrubMessage, classifyRefusal } from './un1t-online-write-judge.js'
import { Un1tSettingsReadError, readUn1tWriteSettings } from './un1t-online-settings.js'
import { finishAttempt, findDone, ledgerKey, listResetAttempts, resetAttemptNo, UN1T_IN_FLIGHT_MS } from './un1t-online-write-ledger.js'
import { applyUn1tWriteToMirror } from './un1t-online-mirror-write.js'
import { lateCancelQuote } from './class-fees-quote.js'
import { getLocationZone } from './location-time.js'
import { sameStudioDay, wasMovedInLateWindow, UN1T_LATE_MOVE_CODES } from './un1t-online-late-move.js'
import { un1tOnlineReads } from './membership/reads/un1t-online.js'
import { resolveCustomerBaseUrl } from './tenant-host.js'
import { COMP_CREDIT_LIMITS, COMP_CREDIT_REASON_KEYS, compNoteProblem, isDateKey } from './un1t-comp-credits.js'
import { logError, logInfo, logWarn } from './log'

const LOG_MODULE = 'un1t-online-write'
const C = UN1T_WRITE_CODES
const { result, refusalResult, withLedger, pickBooking, pickCompBatch, logFields: fields } = _un1tWriteInternals
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

//
// Each one: writer.ensureOp → writer.assertAllowed → (a done row on the
// ledger that settles it, read first) → writer.openAttempt → writer.send →
// finishAttempt → the mirror on done. Throw contract (book, cancel,
// createClient, forgotPassword): every un1t.online outcome and every switch,
// permission and budget refusal RESOLVES as a Un1tWriteResult; the promise
// rejects only with Un1tSettingsReadError or a ledger database error raised
// before anything was sent (so a retry is safe), or a TypeError for a
// programming error. createCheckoutLink rejects Un1tWriteRefused /
// Un1tWriteUnknown instead (spec 6.7).
//
// The ledger stage a result is recorded as:
//   done → done; unknown → unknown;
//   refused with nothing sent → refused (the key is free again);
//   refused by the transport itself (budget, throttle, token) AFTER something
//   went out in this call → unknown, so the next attempt runs the check read
//   before it sends anything.

/** A booking "created since the send" may be stamped this much before our clock. */
export const UN1T_LANDED_SKEW_MS = 2 * 60_000

const IN_DOUBT_AFTER_SEND = new Set([C.RATE_BUDGET, C.RATE_LIMITED, C.AUTH])
const TERMS_NOT_ACCEPTED = 'terms_not_accepted'
const TERMS_TEXT = "This person has not accepted un1t.online's terms and liability waiver, so no account was created and nothing was sent."
const CHECKOUT_TEXT = {
  not_a_customer_url: "A checkout return page must be an https page on this studio's own customer site, so no checkout was opened.",
  no_client_at_studio: 'This person has no un1t.online account at this studio, so no checkout was opened.',
  product_not_sellable: 'That product is not on sale at this studio in un1t.online, so no checkout was opened.',
  free_product_not_via_checkout: 'That product is free; a free product is never sold through a checkout link.',
}
// The ledger shows a done book, and the check read could not say it still
// stands: nothing is sent (only an `absent` check may re-send).
const PRIOR_BOOK_UNVERIFIED_TEXT = 'The CRM booked this class before, and un1t.online could not confirm the booking still stands, so nothing was sent. Check the class in un1t.online.'
const NOT_THIS_CLIENT_TEXT = 'That booking belongs to another un1t.online client, so it was not cancelled.'
const NOT_THIS_CLIENT_MOVE_TEXT = 'That booking belongs to another un1t.online client, so it was not moved.'
const NOT_THIS_CLIENT_UNKNOWN_TEXT = "un1t.online's answer named another client's booking. Check the booking in un1t.online."
const UNKNOWN_CHECKOUT_TEXT = 'un1t.online did not answer clearly, so no checkout link can be given. Try again in a minute.'

/** UN1TMOVE.1 — moveBooking's own codes (the transport's are UN1T_WRITE_CODES). */
export const UN1T_MOVE_CODES = Object.freeze({
  // The booking is already for that class: nothing to move, nothing sent.
  SAME_CLASS: 'move_same_class',
  // A done move on the ledger the check read could not confirm: nothing sent.
  PRIOR_MOVE_UNVERIFIED: 'move_unverified',
})
const SAME_CLASS_TEXT = 'This booking is already for that class, so nothing was moved.'
const L = UN1T_LATE_MOVE_CODES
const LATE_OTHER_DAY_TEXT = "This class starts inside the studio's late-cancel window, so the booking can only move to another class the same day. Nothing was moved."
const WINDOW_UNREADABLE_TEXT = "Whether this class is inside the studio's late-cancel window could not be checked just now, so nothing was moved. Try again in a minute."
const CANCEL_AFTER_LATE_MOVE_TEXT = "This booking was moved inside the studio's late-cancel window, so it cannot be cancelled. Nothing was sent."
const CANCEL_CHECK_UNREADABLE_TEXT = 'Whether this booking was moved late could not be checked just now, so it was not cancelled. Try again in a minute.'
const PRIOR_MOVE_UNVERIFIED_TEXT = 'The CRM moved this booking to that class before, and un1t.online could not confirm it is still there, so nothing was sent. Check the booking in un1t.online.'

const statusOf = (row) => String(row?.status ?? '').trim().toLowerCase()
const isCancelledStatus = (s) => s === 'cancelled' || s === 'canceled'
const idText = (v) => ((typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim() : null)
const sameIdText = (a, b) => idText(a) != null && idText(a).toLowerCase() === String(idText(b) ?? '').toLowerCase()
const plainText = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const actorIdOf = (actor) => (isObj(actor) && typeof actor.id === 'string' && actor.id ? actor.id : null)
const msOf = (v) => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Date.parse(v)
  return NaN
}

function requireText(fn, name, v) {
  if (typeof v !== 'string' || v.trim() === '') throw new TypeError(`${fn}: '${name}' is required`)
}
// A bare un1t.online id: never the CRM's 'un1t:' namespace.
function requireBareId(fn, name, v) {
  requireText(fn, name, v)
  if (/^un1t:/i.test(v)) throw new TypeError(`${fn}: '${name}' must be the bare un1t.online id, without 'un1t:'`)
}

// ── Dedupe reads ───────────────────────────────────────────────────────────

/**
 * Did a book land? `GET /users/{id}/bookings`, every page. A booked or
 * attended row for this event created since the send, or an older booked
 * one, is landed; no live row (only cancelled ones, or none) is absent;
 * anything else (an older attended row, a waitlist entry) or a failed read is
 * unknown. Never throws.
 * @param {{ readAll: Function, locationId: string }} writer
 * @param {{ un1tUserId: string, eventId: string, sentAt?: number|string|Date }} args
 * @returns {Promise<{ state: 'landed'|'absent'|'unknown', id: string|null, row: object|null }>}
 *   row is the picked booking (no embedded user, no guest details).
 */
export async function findLandedBooking(writer, { un1tUserId, eventId, sentAt } = {}) {
  let rows
  try {
    rows = await writer.readAll(`/users/${encodeURIComponent(un1tUserId)}/bookings`)
  } catch (err) {
    logWarn(LOG_MODULE, 'booking check read failed; treated as unknown', fields({ locationId: writer.locationId, op: 'book', code: err?.code ?? 'check_failed' }))
    return { state: 'unknown', id: null, row: null }
  }
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!isObj(r)) return false
    const event = r.event_id ?? (isObj(r.event) ? r.event.id : undefined)
    const user = r.user_id ?? (isObj(r.user) ? r.user.id : undefined)
    return sameIdText(event, eventId) && (user == null || sameIdText(user, un1tUserId))
  })
  const live = mine.filter((r) => !isCancelledStatus(statusOf(r)))
  if (live.length === 0) return { state: 'absent', id: null, row: null }
  const since = msOf(sentAt)
  const fresh = Number.isFinite(since)
    ? live.find((r) => ['booked', 'attended'].includes(statusOf(r)) && msOf(r.created_at) >= since - UN1T_LANDED_SKEW_MS)
    : null
  const hit = fresh ?? live.find((r) => statusOf(r) === 'booked')
  if (hit && idText(hit.id)) return { state: 'landed', id: idText(hit.id), row: pickBooking(hit) }
  return { state: 'unknown', id: null, row: null }
}

/**
 * Where a cancel stands: `GET /bookings/{id}`. cancelled → landed (whoever
 * cancelled it); booked → absent; attended / no_show → already_happened;
 * anything else, another booking, another client's booking (when
 * un1tUserId is given) or a failed read → unknown. Never throws.
 * @returns {Promise<'landed'|'absent'|'already_happened'|'unknown'>}
 */
export async function findCancelState(writer, { bookingId, un1tUserId } = {}) {
  let row
  try {
    row = await writer.read(`/bookings/${encodeURIComponent(bookingId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'cancel check read failed; treated as unknown', fields({ locationId: writer.locationId, op: 'cancel', code: err?.code ?? 'check_failed' }))
    return 'unknown'
  }
  if (!isObj(row) || (row.id != null && !sameIdText(row.id, bookingId))) return 'unknown'
  // Another client's booking is never ours to call landed or to re-send onto.
  const owner = row.user_id ?? (isObj(row.user) ? row.user.id : undefined)
  if (un1tUserId && owner != null && !sameIdText(owner, un1tUserId)) return 'unknown'
  const s = statusOf(row)
  if (isCancelledStatus(s)) return 'landed'
  if (s === 'booked') return 'absent'
  if (s === 'attended' || s === 'no_show' || s === 'no-show') return 'already_happened'
  return 'unknown'
}

/**
 * UN1TMOVE.1 — where a move stands: `GET /bookings/{id}`. The booking at the
 * target event and booked → landed; still at the original event (when it is
 * known) and booked → absent; attended / no_show → already_happened; anything
 * else (cancelled, a third event, a waitlist, another booking or another
 * client's, a failed read, no known original event) → unknown. Never throws.
 * @returns {Promise<{ state: 'landed'|'absent'|'already_happened'|'unknown', id: string|null, row: object|null }>}
 *   row is the picked booking on landed (no embedded user, no guest details).
 */
export async function findMoveState(writer, { bookingId, un1tUserId, eventId, fromEventId = null } = {}) {
  const unknown = { state: 'unknown', id: null, row: null }
  let row
  try {
    row = await writer.read(`/bookings/${encodeURIComponent(bookingId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'move check read failed; treated as unknown', fields({ locationId: writer.locationId, op: 'move', code: err?.code ?? 'check_failed' }))
    return unknown
  }
  if (!isObj(row) || (row.id != null && !sameIdText(row.id, bookingId))) return unknown
  const owner = row.user_id ?? (isObj(row.user) ? row.user.id : undefined)
  if (un1tUserId && owner != null && !sameIdText(owner, un1tUserId)) return unknown
  const event = row.event_id ?? (isObj(row.event) ? row.event.id : undefined)
  const s = statusOf(row)
  if (s === 'attended' || s === 'no_show' || s === 'no-show') return { state: 'already_happened', id: null, row: null }
  if (s !== 'booked') return unknown
  if (sameIdText(event, eventId)) return { state: 'landed', id: bookingId, row: pickBooking({ ...row, id: row.id ?? bookingId }) }
  if (fromEventId && sameIdText(event, fromEventId)) return { state: 'absent', id: null, row: null }
  return unknown
}

/**
 * The most pages an email walk of `GET /users/clients` may read (100 clients
 * a page, one budget slot each): Hatch has two pages today, and an unbounded
 * walk could spend the studio's whole 30/min write budget (UN1TWRITE.20).
 */
export const UN1T_CLIENT_WALK_MAX_PAGES = 8

/**
 * Every un1t.online client whose email is this one: a walk of
 * `GET /users/clients` (the address never goes in a URL: un1t.online's
 * undocumented `q` filter would put it there), compared trimmed, lower-cased
 * and exact, at most UN1T_CLIENT_WALK_MAX_PAGES pages. Throws when the walk
 * fails or is cut short (code 'truncated'): "could not look" is never "no
 * match".
 *
 * `createdSince` (UN1TINCR.1): only clients created since then (the list is
 * newest first, so the walk stops there and stays a page or two however big
 * the studio grows). A caller passes it only when every older client is
 * already answered elsewhere: the account flow's mirror steps after a sync,
 * or a create's check read, whose account is the newest.
 * @returns {Promise<{ matches: string[] }>}
 */
export async function findClientByEmail(writer, email, { maxPages = UN1T_CLIENT_WALK_MAX_PAGES, createdSince = null } = {}) {
  const want = normEmail(email)
  if (!want) throw new TypeError('findClientByEmail: email is required')
  const rows = await writer.readAll('/users/clients', createdSince ? { maxPages, newerThan: createdSince } : { maxPages })
  const matches = new Set()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (isObj(r) && normEmail(r.email) === want && idText(r.id)) matches.add(idText(r.id))
  }
  return { matches: [...matches] }
}

/**
 * The latest done book on the ledger for this person and class, unless a done
 * cancel of that booking came after it (a done book alone is not "booked":
 * findDone(book) cannot see the cancel). null when none. Throws on a database
 * error. A done book with no booking id (an already-booked answer) is returned
 * as is; the caller's check read decides.
 */
export async function findDoneBooking(db, { locationId, un1tUserId, eventId }) {
  const done = await findDone(db, { key: ledgerKey.book(locationId, un1tUserId, eventId) })
  if (!done) return null
  const bookingId = idText(done.un1t_ref)
  if (!bookingId) return done
  const cancelled = await findDone(db, { key: ledgerKey.cancel(locationId, bookingId) })
  // Booking ids are never reused, so a done cancel of this one undid it.
  return cancelled ? null : done
}

/**
 * The done trial for this person and product, by EITHER method (the €0 charge
 * or the free checkout): their keys differ, so findDone on one key misses the
 * other (mig 744 one_trial is per person and product). null when none.
 * Throws on a database error: an unreadable history is never "no trial".
 */
export async function findDoneTrial(db, { locationId, un1tUserId, productId }) {
  if (!locationId || !un1tUserId || !productId) throw new TypeError('findDoneTrial: locationId, un1tUserId and productId are required')
  const { data, error } = await db
    .from('un1t_write_events')
    .select('id, method, un1t_ref, created_at')
    .eq('location_id', locationId)
    .eq('op', 'trial')
    .eq('un1t_user_id', un1tUserId)
    .eq('target', productId)
    .eq('stage', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`un1t_write_events trial read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
  return data ?? null
}

// ── The shared run ─────────────────────────────────────────────────────────

// ensureOp's refusal as the result to return; anything else rethrows.
async function opRefusal(writer, op) {
  try {
    await writer.ensureOp(op)
    return null
  } catch (err) {
    if (err instanceof Un1tWriteRefused && err.result) return err.result
    throw err
  }
}

function ledgerStageOf(r) {
  if (r.verdict === 'done') return 'done'
  if (r.verdict === 'unknown') return 'unknown'
  return r.sent && IN_DOUBT_AFTER_SEND.has(r.code) ? 'unknown' : 'refused'
}

// The mirror never changes the verdict, even when it throws.
async function safely(fn, meta) {
  try {
    return (await fn()) ?? {}
  } catch {
    logError(LOG_MODULE, 'mirror threw after a done write; the next sync repairs it', fields({ ...meta, code: 'mirror_threw' }))
    return {}
  }
}

/**
 * openAttempt → send → finishAttempt → onDone. `send(row)` is the primitive's
 * own writer.send call (each states its policy literally). `onDone(result)`
 * returns fields to merge into a done result (data, conflict). `finishExtra(result)`
 * returns op-specific ledger fields for finishAttempt (UN1TCOMP.1: the expiry).
 */
async function attemptWrite(db, writer, { attempt, policy, verify, send, secrets = [], onDone, finishExtra }) {
  const meta = { locationId: writer.locationId, op: attempt.op, origin: attempt.origin }
  const opened = await writer.openAttempt(attempt, { policy, verify })
  if (opened.result) {
    const r = opened.result
    if (r.verdict !== 'done' || !onDone) return r
    return { ...r, ...(await safely(() => onDone(r), { ...meta, ledgerId: r.ledgerId })) }
  }
  const { row } = opened
  let r
  try {
    r = await send(row)
  } catch (err) {
    // A programming error after the write-ahead row: free the key, then fail loudly.
    await finishAttempt(db, row.id, { stage: 'refused', code: 'not_sent' })
    throw err
  }
  const isCheckout = attempt.op === 'checkout'
  await finishAttempt(db, row.id, {
    stage: ledgerStageOf(r),
    // A checkout's id IS its URL: it goes in checkout_url, never un1t_ref.
    un1tRef: !isCheckout && r.id ? r.id : undefined,
    checkoutUrl: isCheckout && r.verdict === 'done' ? r.id : undefined,
    code: r.code ?? null,
    message: r.message == null ? null : scrubMessage(r.message, secrets) || null,
    recovered: r.recovered ?? null,
    ...(finishExtra ? finishExtra(r) : {}),
  })
  const out = withLedger(r, row.id)
  if (r.verdict !== 'done' || !onDone) return out
  return { ...out, ...(await safely(() => onDone(out), { ...meta, ledgerId: row.id })) }
}

const mirrorDeps = (writer, now) => ({ read: (path) => writer.read(path), now })

// ── book ───────────────────────────────────────────────────────────────────

/**
 * Book a un1t.online class for a client.
 * @param {object} db
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, eventId: string,
 *   origin: 'staff'|'funnel'|'approval'|'mia'|'test_account', originRef?: string|null, actor?: { id: string }|null }} args
 *   eventId is the bare un1t.online uuid (no 'un1t:').
 * @param {{ writerFactory?: typeof createUn1tWriter, now?: () => Date }} [deps]
 * @returns {Promise<object>} Un1tWriteResult. done: id = the booking id (from
 *   the answer, or from the check read when the answer only said "already
 *   booked"; null when nothing named it), data = the un1t_bookings row.
 */
export async function book(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date() } = deps
  const { locationId, contactId = null, un1tUserId, eventId, origin, originRef = null, actor = null } = args
  requireBareId('book', 'un1tUserId', un1tUserId)
  requireBareId('book', 'eventId', eventId)
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'book')
  if (refused) return refused
  const body = { eventId, userId: un1tUserId }
  writer.assertAllowed('book', 'POST', '/bookings', body)

  // Set just before the send; NaN on a resume (the old send time is not ours
  // to know), so only an older `booked` row counts as landed there.
  let sentAt = NaN
  let landedRow = null
  const verify = async () => {
    const chk = await findLandedBooking(writer, { un1tUserId, eventId, sentAt })
    if (chk.state === 'landed') landedRow = chk.row
    return chk
  }
  const mirror = async (r) => {
    const data = r.data ?? landedRow
    if (!data) return { data: null }
    const m = await applyUn1tWriteToMirror(db, {
      op: 'book', locationId, contactId, un1tUserId, studioId: writer.studioId, data,
      requestedAt: Number.isFinite(sentAt) ? new Date(sentAt).toISOString() : null, ledgerId: r.ledgerId,
    }, mirrorDeps(writer, now))
    return { data: m.row ?? null }
  }

  // A live done book on the ledger: confirm it is still there before sending
  // again (a member can cancel in the app, which the ledger never sees).
  const prior = await findDoneBooking(db, { locationId, un1tUserId, eventId })
  if (prior) {
    const chk = await verify()
    if (chk.state === 'landed') {
      const r = withLedger(result('done', { id: chk.id, alreadyBooked: true }), prior.id)
      return { ...r, ...(await safely(() => mirror(r), { locationId, op: 'book', origin, ledgerId: prior.id })) }
    }
    // Only an `absent` check may lead to a send; an unreadable or unclear one
    // (a failed read, a waitlist row) leaves the booking in doubt.
    if (chk.state !== 'absent') {
      logWarn(LOG_MODULE, 'a done book on the ledger could not be confirmed; not sent', fields({ locationId, op: 'book', origin, ledgerId: prior.id, code: C.ALREADY_BOOKED_UNVERIFIED }))
      return withLedger(result('unknown', { code: C.ALREADY_BOOKED_UNVERIFIED, message: PRIOR_BOOK_UNVERIFIED_TEXT }), prior.id)
    }
  }

  return attemptWrite(db, writer, {
    attempt: {
      op: 'book', key: ledgerKey.book(locationId, un1tUserId, eventId), contactId, un1tUserId, target: eventId,
      origin, originRef, actorUserId: actorIdOf(actor),
    },
    policy: 'verify',
    verify,
    send: (row) => {
      sentAt = now().getTime()
      return writer.send('POST', '/bookings', {
        body, policy: 'verify', verify, op: 'book', origin, ledgerId: row.id,
        expect: { eventId, userId: un1tUserId, studioId: writer.studioId },
      })
    },
    onDone: mirror,
  })
}

// ── cancel ─────────────────────────────────────────────────────────────────

/**
 * Cancel a un1t.online booking (an empty body, no refund flag). A booking that
 * was attended or a no-show is refused UN1T_WRITE_CODES.ALREADY_HAPPENED; one
 * already cancelled (by anyone) is done.
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, bookingId: string,
 *   origin: string, originRef?: string|null, actor?: { id: string }|null }} args
 */
export async function cancel(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date() } = deps
  const { locationId, contactId = null, un1tUserId, bookingId, origin, originRef = null, actor = null } = args
  requireBareId('cancel', 'un1tUserId', un1tUserId)
  requireBareId('cancel', 'bookingId', bookingId)
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'cancel')
  if (refused) return refused
  writer.assertAllowed('cancel', 'PATCH', `/bookings/${bookingId}/cancel`, {})

  // A done cancel of this booking is final (a rebook is a new booking id).
  const key = ledgerKey.cancel(locationId, bookingId)
  const prior = await findDone(db, { key })
  if (prior) return withLedger(result('done', { id: bookingId }), prior.id)

  // The booking must be this client's. The mirror answers without a request;
  // a booking it does not hold yet is guarded by the check read and the answer.
  const { data: mirrored, error: mirrorError } = await db
    .from('un1t_bookings')
    .select('un1t_user_id')
    .eq('location_id', locationId)
    .eq('un1t_id', bookingId)
    .limit(1)
    .maybeSingle()
  if (mirrorError) throw new Un1tSettingsReadError(`un1t_bookings read failed (${mirrorError.code ?? 'no code'})`, { code: 'mirror_read_failed' })
  if (mirrored?.un1t_user_id && !sameIdText(mirrored.un1t_user_id, un1tUserId)) {
    logWarn(LOG_MODULE, 'a cancel for another client was refused; nothing sent', fields({ locationId, op: 'cancel', origin, code: C.BOOKING_NOT_THIS_CLIENT }))
    return withLedger(refusalResult(C.BOOKING_NOT_THIS_CLIENT, NOT_THIS_CLIENT_TEXT))
  }

  // UN1TMOVE.2 — a booking moved inside the late-cancel window is never
  // cancelled by the CRM (moving to a later class the same day, then
  // cancelling, would dodge the fee). A failed read refuses (fail closed): a
  // cancel not sent is recoverable by staff in the un1t.online console, a
  // dodged fee is not.
  let movedLate
  try {
    movedLate = await wasMovedInLateWindow(db, { locationId, bookingId })
  } catch {
    logWarn(LOG_MODULE, 'late-move read failed; cancel refused, nothing sent', fields({ locationId, op: 'cancel', origin, code: L.CANCEL_CHECK_UNREADABLE }))
    return withLedger(result('refused', { code: L.CANCEL_CHECK_UNREADABLE, message: CANCEL_CHECK_UNREADABLE_TEXT, retryable: true }))
  }
  if (movedLate) {
    logInfo(LOG_MODULE, 'a booking moved inside the late window was not cancelled; nothing sent', fields({ locationId, op: 'cancel', origin, code: L.CANCEL_AFTER_LATE_MOVE }))
    return withLedger(refusalResult(L.CANCEL_AFTER_LATE_MOVE, CANCEL_AFTER_LATE_MOVE_TEXT))
  }

  // The check read names the booking, so a resume reports its id too.
  const verify = async () => {
    const state = await findCancelState(writer, { bookingId, un1tUserId })
    return state === 'landed' ? { state, id: bookingId } : state
  }
  let requestedAt = null
  return attemptWrite(db, writer, {
    attempt: { op: 'cancel', key, contactId, un1tUserId, target: bookingId, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'verify',
    verify,
    send: async (row) => {
      requestedAt = now().toISOString()
      const r = await writer.send('PATCH', `/bookings/${bookingId}/cancel`, {
        body: {}, policy: 'verify', verify, op: 'cancel', origin, ledgerId: row.id, expect: { bookingId },
      })
      // An answer naming another client: it went out, so it is in doubt, never done.
      const owner = r.verdict === 'done' && isObj(r.data) ? r.data.user_id : null
      if (owner != null && !sameIdText(owner, un1tUserId)) {
        logWarn(LOG_MODULE, "un1t.online's cancel answer named another client", fields({ locationId, op: 'cancel', origin, ledgerId: row.id, code: C.BOOKING_NOT_THIS_CLIENT }))
        return result('unknown', { sent: r.sent, code: C.BOOKING_NOT_THIS_CLIENT, message: NOT_THIS_CLIENT_UNKNOWN_TEXT })
      }
      return r
    },
    onDone: async (r) => {
      const data = isObj(r.data) && r.data.id ? r.data : { id: bookingId }
      const m = await applyUn1tWriteToMirror(db, {
        op: 'cancel', locationId, contactId, un1tUserId, studioId: writer.studioId, data, requestedAt, ledgerId: r.ledgerId,
      }, mirrorDeps(writer, now))
      return { data: m.row ?? null }
    },
  })
}

// ── moveBooking ────────────────────────────────────────────────────────────

/**
 * UN1TMOVE.1 — move a un1t.online booking to another class in ONE call
 * (`POST /bookings/{id}/move` { eventId }), instead of a cancel then a book,
 * which leaves a window where the credit or the spot is lost. No charge, no
 * refund flag: un1t.online carries the credit over itself.
 *
 * Like cancel, the booking must be this client's (the mirror answers without
 * a request; the answer and the check read guard one it does not hold yet).
 * The original event (the caller's, else the mirror's) is what lets the check
 * read call a move `absent`; without it a 5xx is never re-sent. A done move on
 * the ledger is confirmed by the check read first (a booking can be moved
 * back): landed is done with nothing sent, absent sends, anything else is
 * unknown with nothing sent.
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, bookingId: string,
 *   eventId: string, fromEventId?: string|null, origin: string, originRef?: string|null,
 *   actor?: { id: string }|null }} args
 *   bookingId and eventId (the TARGET class) are bare un1t.online ids.
 * @returns {Promise<object>} Un1tWriteResult. done: id = the booking id,
 *   data = the un1t_bookings row (at the new event).
 */
export async function moveBooking(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date(), lateQuote = lateCancelQuote, zoneOf = getLocationZone } = deps
  const { locationId, contactId = null, un1tUserId, bookingId, eventId, fromEventId = null, origin, originRef = null, actor = null } = args
  requireBareId('moveBooking', 'un1tUserId', un1tUserId)
  requireBareId('moveBooking', 'bookingId', bookingId)
  requireBareId('moveBooking', 'eventId', eventId)
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'move')
  if (refused) return refused
  const path = `/bookings/${bookingId}/move`
  const body = { eventId }
  writer.assertAllowed('move', 'POST', path, body)

  // The booking must be this client's, and the mirror knows its class.
  const { data: mirrored, error: mirrorError } = await db
    .from('un1t_bookings')
    .select('un1t_user_id, event_id, credit_charged')
    .eq('location_id', locationId)
    .eq('un1t_id', bookingId)
    .limit(1)
    .maybeSingle()
  if (mirrorError) throw new Un1tSettingsReadError(`un1t_bookings read failed (${mirrorError.code ?? 'no code'})`, { code: 'mirror_read_failed' })
  if (mirrored?.un1t_user_id && !sameIdText(mirrored.un1t_user_id, un1tUserId)) {
    logWarn(LOG_MODULE, 'a move for another client was refused; nothing sent', fields({ locationId, op: 'move', origin, code: C.BOOKING_NOT_THIS_CLIENT }))
    return withLedger(refusalResult(C.BOOKING_NOT_THIS_CLIENT, NOT_THIS_CLIENT_MOVE_TEXT))
  }
  const from = idText(fromEventId) ?? idText(mirrored?.event_id)
  if (from && sameIdText(from, eventId)) return withLedger(refusalResult(UN1T_MOVE_CODES.SAME_CLASS, SAME_CLASS_TEXT))

  let landedRow = null
  const verify = async () => {
    const chk = await findMoveState(writer, { bookingId, un1tUserId, eventId, fromEventId: from })
    if (chk.state === 'landed') landedRow = chk.row
    return chk
  }
  let requestedAt = null
  const mirror = async (r) => {
    const data = r.data ?? landedRow
    if (!data) return { data: null }
    const m = await applyUn1tWriteToMirror(db, {
      op: 'move', locationId, contactId, un1tUserId, studioId: writer.studioId, data, requestedAt,
      ledgerId: r.ledgerId, fromBookingId: bookingId,
    }, mirrorDeps(writer, now))
    return { data: m.row ?? null }
  }

  const key = ledgerKey.move(locationId, bookingId, eventId)
  const prior = await findDone(db, { key })
  if (prior) {
    const chk = await verify()
    if (chk.state === 'landed') {
      const r = withLedger(result('done', { id: chk.id }), prior.id)
      return { ...r, ...(await safely(() => mirror(r), { locationId, op: 'move', origin, ledgerId: prior.id })) }
    }
    if (chk.state !== 'absent') {
      logWarn(LOG_MODULE, 'a done move on the ledger could not be confirmed; not sent', fields({ locationId, op: 'move', origin, ledgerId: prior.id, code: UN1T_MOVE_CODES.PRIOR_MOVE_UNVERIFIED }))
      return withLedger(result('unknown', { code: UN1T_MOVE_CODES.PRIOR_MOVE_UNVERIFIED, message: PRIOR_MOVE_UNVERIFIED_TEXT }), prior.id)
    }
  }

  // UN1TMOVE.2 — the late-cancel window (the FEES.2 rule, on the class being
  // left): inside it, only a class the same studio day; outside, any class.
  const late = await lateWindowOf(db, writer, {
    locationId, contactId, un1tUserId, bookingId, fromEventId: from, eventId, creditCharged: mirrored?.credit_charged ?? null,
    nowMs: now().getTime(), lateQuote, zoneOf,
  })
  if (late.refuse) {
    logWarn(LOG_MODULE, 'a move was refused by the late-window rule; nothing sent', fields({ locationId, op: 'move', origin, code: late.refuse.code }))
    return withLedger(result('refused', late.refuse))
  }

  return attemptWrite(db, writer, {
    attempt: {
      op: 'move', key, contactId, un1tUserId, target: bookingId, origin, originRef, actorUserId: actorIdOf(actor),
      lateWindow: late.late,
    },
    policy: 'verify',
    verify,
    send: (row) => {
      requestedAt = now().toISOString()
      return writer.send('POST', `/bookings/${bookingId}/move`, {
        body, policy: 'verify', verify, op: 'move', origin, ledgerId: row.id,
        expect: { eventId, userId: un1tUserId, studioId: writer.studioId, bookingId },
      })
    },
    onDone: mirror,
  })
}

/**
 * UN1TMOVE.2 — is leaving the class inside the studio's late-cancel window
 * (lateCancelQuote says a cancel now would cost a fee or the credit), and if
 * so, is the target the same studio day? → { late: boolean } | { refuse }.
 * Never throws: anything that cannot be read refuses the move (retryable,
 * nothing sent), because a move that might dodge a fee is not sent blind and
 * the booking simply stays where it is.
 */
async function lateWindowOf(db, writer, { locationId, contactId, un1tUserId, bookingId, fromEventId, eventId, creditCharged, nowMs, lateQuote, zoneOf }) {
  const unreadable = { refuse: { code: L.WINDOW_UNREADABLE, message: WINDOW_UNREADABLE_TEXT, retryable: true } }
  const startOf = async (id) => {
    if (!id) return { startsAt: null }
    const { data, error } = await db.from('un1t_events').select('starts_at').eq('location_id', locationId).eq('un1t_id', id).maybeSingle()
    return error ? { startsAt: null, error } : { startsAt: data?.starts_at ?? null }
  }
  try {
    const from = await startOf(fromEventId)
    const quote = await lateQuote(db, {
      locationId, un1tUserId, contactId, bookingId, eventId: fromEventId, startsAt: from.startsAt, creditCharged, nowMs,
      readWindowHours: async () => {
        // A failed read throws (refused below); no window set is no window.
        const s = await writer.read(`/studios/${encodeURIComponent(writer.studioId)}`)
        const h = Number(s?.default_cancelation_window_hours)
        return Number.isFinite(h) && h > 0 ? h : null
      },
    })
    // Fees on, but the class being left has no known start: cannot tell.
    if (!quote?.applies) return quote?.reason === 'no_start' ? unreadable : { late: false }
    const target = await startOf(eventId)
    if (!target.startsAt) return unreadable
    const zone = await zoneOf(db, locationId)
    if (sameStudioDay(from.startsAt, target.startsAt, zone)) return { late: true }
    return { refuse: { code: L.OTHER_DAY, message: LATE_OTHER_DAY_TEXT } }
  } catch (err) {
    logWarn(LOG_MODULE, 'late-window check failed; move refused, nothing sent', fields({ locationId: writer.locationId, op: 'move', code: err?.code ?? L.WINDOW_UNREADABLE }))
    return unreadable
  }
}

// ── createClient ───────────────────────────────────────────────────────────

/**
 * Create a un1t.online client for a contact. Only with a recorded acceptance
 * of un1t.online's terms and liability waiver (refused terms_not_accepted,
 * nothing sent, otherwise). The password is random, lives only in this call's
 * body and is never stored, logged or returned; un1t.online's answer (which
 * carries reset_password_token, email and phone) yields only the id.
 * @param {{ locationId: string, contact: { id: string, email: string, first_name?: string|null,
 *   last_name?: string|null, name?: string|null, phone?: string|null },
 *   terms: { acceptedAt: string|Date, source: string, version?: string|null },
 *   origin: string, originRef?: string|null, actor?: { id: string }|null }} args
 * @returns {Promise<object>} Un1tWriteResult plus `conflict`: null, or
 *   'un1t_link_conflict' when another contact already holds the new user
 *   (nothing overwritten; the verdict stays done).
 */
export async function createClient(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date() } = deps
  const { locationId, contact, terms, origin, originRef = null, actor = null } = args
  if (!isObj(contact)) throw new TypeError("createClient: 'contact' is required")
  requireText('createClient', 'contact.id', contact.id)
  const email = plainText(contact.email)
  if (!email) throw new TypeError("createClient: 'contact.email' is required")

  const acceptedMs = msOf(terms?.acceptedAt)
  if (!Number.isFinite(acceptedMs)) return { ...withLedger(refusalResult(TERMS_NOT_ACCEPTED, TERMS_TEXT)), conflict: null }
  const termsAcceptedAt = new Date(acceptedMs).toISOString()

  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'create_client')
  if (refused) return { ...refused, conflict: null }

  const linkMirror = async (un1tUserId, ledgerId, requestedAt = null) => {
    const m = await applyUn1tWriteToMirror(db, {
      op: 'create_client', locationId, contactId: contact.id, un1tUserId, studioId: writer.studioId,
      data: null, requestedAt, ledgerId,
    }, mirrorDeps(writer, now))
    return { conflict: m.conflict ?? null }
  }

  // A done create is final; its mirror is re-run (it is idempotent), so a
  // contact link that failed last time is tried again.
  const key = ledgerKey.create(locationId, contact.id)
  const prior = await findDone(db, { key })
  if (prior) {
    const id = idText(prior.un1t_ref)
    const done = withLedger(result('done', { id }), prior.id)
    const extra = id ? await safely(() => linkMirror(id, prior.id), { locationId, op: 'create_client', origin, ledgerId: prior.id }) : {}
    return { conflict: null, ...done, ...extra }
  }

  // Held in this call only: straight into the body, scrubbed from every text.
  const password = randomBytes(24).toString('base64url')
  const body = { email, password, studioId: writer.studioId, accepted_terms: true, accepted_liability_waiver: true }
  // Optional keys only when there is a value: an undefined is never sent.
  for (const k of ['name', 'first_name', 'last_name', 'phone']) {
    const v = plainText(contact[k])
    if (v) body[k] = v
  }
  writer.assertAllowed('create_client', 'POST', '/users/clients', body)
  const secrets = [password, email, ...(body.phone ? [body.phone, ...phoneForms(body.phone)] : [])]

  // A check read after this call's send looks only at clients created since
  // shortly before it (the account it made is the newest; 10 minutes covers
  // clock skew). A resumed attempt from an earlier call has no send time
  // here, so it walks every client.
  const verify = async () => {
    const createdSince = requestedAt ? new Date(Date.parse(requestedAt) - 10 * 60_000).toISOString() : null
    const { matches } = await findClientByEmail(writer, email, createdSince ? { createdSince } : undefined)
    if (matches.length === 1) return { state: 'landed', id: matches[0] }
    return matches.length === 0 ? 'absent' : 'unknown'
  }
  let requestedAt = null
  const r = await attemptWrite(db, writer, {
    attempt: {
      op: 'create_client', key, contactId: contact.id, un1tUserId: null, target: null, origin, originRef,
      actorUserId: actorIdOf(actor), termsAcceptedAt, termsSource: plainText(terms?.source),
    },
    policy: 'verify',
    verify,
    secrets,
    send: (row) => {
      requestedAt = now().toISOString()
      return writer.send('POST', '/users/clients', { body, policy: 'verify', verify, op: 'create_client', origin, ledgerId: row.id, secrets, expect: {} })
    },
    onDone: (done) => (done.id ? linkMirror(done.id, done.ledgerId, requestedAt) : {}),
  })
  return { conflict: null, ...r, data: null }
}

// ── forgotPassword ─────────────────────────────────────────────────────────

/** UN1TWRITE.25 (Richard's rule): up to this many resets per person ... */
export const UN1T_RESET_LIMIT = 3
/** ... in this rolling window; after that, nothing until the oldest ages out. */
export const UN1T_RESET_WINDOW_MS = 30 * 60_000
export const UN1T_RESET_LIMIT_CODE = 'reset_limit'
// The post-insert check found another call's done reset under this attempt's key.
const DUPLICATE_ATTEMPT = 'duplicate_attempt'
// A reset that may have reached un1t.online (and so may have sent an email):
// done, unknown, or a sent row whose outcome was never recorded. A refused
// one sent no email and never counts.
const RESET_MAY_HAVE_SENT = new Set(['sent', 'unknown', 'done'])
export const UN1T_RESET_ALREADY_REQUESTED_CODE = 'reset_already_requested'
const RESET_ALREADY_REQUESTED_TEXT = 'A password reset was already asked for this person, so this one-time reset was not sent again.'
const RESET_IN_FLIGHT_TEXT = 'A password reset for this person is still running, so nothing more was sent. Try again in a few minutes.'

function resetLimitText(nextMs, nowMs) {
  const mins = Math.max(1, Math.ceil((nextMs - nowMs) / 60_000))
  return `The CRM has asked un1t.online for ${UN1T_RESET_LIMIT} password reset emails in the last 30 minutes for this person, so nothing was sent. The next one can be sent in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`
}

const msOrNow = (v, nowMs) => {
  const at = Date.parse(v)
  // An unparsable created_at counts as now: the safe direction is to count it.
  return Number.isFinite(at) ? at : nowMs
}

/** When the limit lifts, or null when fewer than UN1T_RESET_LIMIT resets in `rows` may have sent in the window. */
function resetLimitLiftsAt(rows, nowMs) {
  const counted = rows
    .filter((r) => RESET_MAY_HAVE_SENT.has(r.stage))
    .map((r) => msOrNow(r.created_at, nowMs))
    .filter((atMs) => nowMs - atMs < UN1T_RESET_WINDOW_MS)
    .sort((a, b) => a - b)
  // Allowed again once all but LIMIT - 1 of them have aged out of the window.
  return counted.length >= UN1T_RESET_LIMIT ? counted[counted.length - UN1T_RESET_LIMIT] + UN1T_RESET_WINDOW_MS : null
}

/**
 * The reset allowance, from this person's forgot-password rows (newest first).
 * → { inFlight: row } a reset is running now (a sent row under UN1T_IN_FLIGHT_MS);
 * | { nextAllowedAt: ms } the limit is reached;
 * | { attempt: n } go, under key pw:<loc>:<user>:<n> (one past every number used).
 */
export function resetAllowance(rows, { locationId, un1tUserId, nowMs }) {
  let maxNo = 0
  for (const r of rows) {
    const n = resetAttemptNo(r.idempotency_key, locationId, un1tUserId)
    if (n != null && n > maxNo) maxNo = n
    if (r.stage === 'sent' && nowMs - msOrNow(r.created_at, nowMs) < UN1T_IN_FLIGHT_MS) return { inFlight: r }
  }
  const liftsAt = resetLimitLiftsAt(rows, nowMs)
  return liftsAt != null ? { nextAllowedAt: liftsAt } : { attempt: maxNo + 1 }
}

const resetLimitResult = (liftsAt, nowMs) => refusalResult(UN1T_RESET_LIMIT_CODE, resetLimitText(liftsAt, nowMs), {
  data: { nextAllowedAt: new Date(liftsAt).toISOString() },
})

/**
 * Ask un1t.online to email this client a set-password code. Up to
 * UN1T_RESET_LIMIT resets per person per UN1T_RESET_WINDOW_MS (UN1TWRITE.25):
 * a reset that was done, is unknown, or was sent with no recorded outcome
 * counts (each may have sent an email); the next one is refused reset_limit
 * with data.nextAllowedAt, nothing sent and no ledger row. Each attempt has
 * its own key pw:<loc>:<user>:<n> (n one past every number this person has
 * used), so:
 *   - two calls that read the ledger together take the SAME n, and the
 *     one-open index lets one of them send;
 *   - a call that reads while another is in flight sees its sent row and is
 *     refused UN1T_ATTEMPT_IN_FLIGHT;
 *   - after its own insert a call checks again: a done row under its n
 *     (another call took this attempt and finished) sends nothing
 *     (duplicate_attempt, the earlier done returned), and the window counted
 *     again without its own row (a caller that stalled while others went)
 *     refuses reset_limit;
 *   - an unknown row holds only its own key and ages out of the window.
 * firstOnly (the funnel's set-password step: one reset per account): any
 * done, sent or unknown reset for this person, whatever its key or age, skips
 * as refused reset_already_requested (data.priorStage), nothing sent. Two
 * firstOnly calls that both read "none" take n = 1 together, so the one-open
 * index still lets only one send.
 * beforeSend (optional): runs once this call owns the attempt and has passed
 * the post-insert checks, just before the request (the funnel's explanation
 * email, so it goes only with the reset that is actually sent). A throw from
 * it is logged and never blocks the reset.
 * One attempt is never re-sent (a second request is a second email): a 5xx
 * or no reply is unknown after one request. A done here does NOT prove an
 * email went out; no copy may promise it.
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, email: string,
 *   origin: string, originRef?: string|null, actor?: { id: string }|null,
 *   firstOnly?: boolean, beforeSend?: () => Promise<void> }} args
 * @param {{ writerFactory?: typeof createUn1tWriter, now?: () => Date }} [deps]
 */
export async function forgotPassword(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date() } = deps
  const {
    locationId, contactId = null, un1tUserId, email: rawEmail, origin, originRef = null, actor = null,
    firstOnly = false, beforeSend = null,
  } = args
  requireBareId('forgotPassword', 'un1tUserId', un1tUserId)
  const email = plainText(rawEmail)
  if (!email) throw new TypeError("forgotPassword: 'email' is required")
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'forgot_password')
  if (refused) return refused
  const body = { email }
  writer.assertAllowed('forgot_password', 'POST', '/auth/forgot-password', body)

  const nowMs = now().getTime()
  const rows = await listResetAttempts(db, { locationId, un1tUserId })
  if (firstOnly) {
    const prior = rows.find((r) => RESET_MAY_HAVE_SENT.has(r.stage))
    if (prior) {
      return withLedger(refusalResult(UN1T_RESET_ALREADY_REQUESTED_CODE, RESET_ALREADY_REQUESTED_TEXT, { data: { priorStage: prior.stage } }), prior.id)
    }
  }
  const allowance = resetAllowance(rows, { locationId, un1tUserId, nowMs })
  if (allowance.inFlight) {
    return withLedger(refusalResult(C.ATTEMPT_IN_FLIGHT, RESET_IN_FLIGHT_TEXT), allowance.inFlight.id)
  }
  if (allowance.nextAllowedAt != null) {
    logInfo(LOG_MODULE, 'password reset limit reached; not sent', fields({ locationId, op: 'forgot_password', origin, code: UN1T_RESET_LIMIT_CODE }))
    return withLedger(resetLimitResult(allowance.nextAllowedAt, nowMs))
  }

  const key = ledgerKey.pw(locationId, un1tUserId, allowance.attempt)
  let doneBefore = null
  const r = await attemptWrite(db, writer, {
    attempt: { op: 'forgot_password', key, contactId, un1tUserId, target: null, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'never',
    secrets: [email],
    send: async (row) => {
      // Our row is open now, so no other call can open this key until it
      // finishes. A done row under it means another call took this attempt
      // and finished before we inserted: never a second email for it.
      const prior = await findDone(db, { key })
      if (prior && prior.id !== row.id) {
        doneBefore = prior
        return refusalResult(DUPLICATE_ATTEMPT, null)
      }
      // Count the window again, without our own row: a caller that stalled
      // between its read and its insert while other resets went out.
      const others = (await listResetAttempts(db, { locationId, un1tUserId })).filter((o) => o.id !== row.id)
      const liftsAt = resetLimitLiftsAt(others, now().getTime())
      if (liftsAt != null) return resetLimitResult(liftsAt, now().getTime())
      if (typeof beforeSend === 'function') {
        try {
          await beforeSend()
        } catch {
          logWarn(LOG_MODULE, 'beforeSend threw; the reset still goes', fields({ locationId, op: 'forgot_password', origin, code: 'before_send_threw' }))
        }
      }
      return writer.send('POST', '/auth/forgot-password', {
        body, policy: 'never', op: 'forgot_password', origin, ledgerId: row.id, secrets: [email], expect: {},
      })
    },
  })
  return doneBefore ? withLedger(result('done'), doneBefore.id) : r
}

// ── createCheckoutLink ─────────────────────────────────────────────────────

// An https page on exactly the studio's customer host, with no credentials.
function isCustomerUrl(value, host) {
  if (typeof value !== 'string' || !host) return false
  let u
  try {
    u = new URL(value)
  } catch {
    return false
  }
  return u.protocol === 'https:' && !u.username && !u.password && u.host.toLowerCase() === host
}

// An unreadable customer host is an unanswered question (retry), never a
// refusal of the caller's URLs.
async function customerHost(db, locationId) {
  try {
    const host = new URL(await resolveCustomerBaseUrl(db, locationId)).host.toLowerCase()
    if (host) return host
  } catch { /* falls through */ }
  throw new Un1tSettingsReadError("this studio's customer site could not be read", { code: 'customer_url_unreadable' })
}

const refuseCheckout = (code) => new Un1tWriteRefused(code, CHECKOUT_TEXT[code], withLedger(refusalResult(code, CHECKOUT_TEXT[code])))

/**
 * A hosted un1t.online checkout for a paid product (spec 6.7, for spec E).
 * Never the admin charge endpoint, never a promo code, never a €0 product (the trial
 * has its own path). The key is the idempotency-key header and the ledger key;
 * a 5xx is re-sent once with the same key. The URL is stored on the ledger and
 * never logged.
 * @param {{ locationId: string, userId: string, productId: string, successUrl: string,
 *   cancelUrl: string, idempotencyKey: string, origin?: string, originRef?: string|null,
 *   actor?: { id: string }|null }} args
 * @returns {Promise<{ checkoutUrl: string, free: boolean }>}
 * @throws {Un1tWriteRefused} every refusal (UN1T_* codes, not_a_customer_url,
 *   no_client_at_studio, product_not_sellable, free_product_not_via_checkout,
 *   un1t.online's own codes)
 * @throws {Un1tWriteUnknown} an unclear answer
 * @throws {Un1tSettingsReadError} the switch or the mirror could not be read (nothing sent)
 */
export async function createCheckoutLink(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter } = deps
  const {
    locationId, userId, productId, successUrl, cancelUrl, idempotencyKey,
    origin = 'mia', originRef = null, actor = null,
  } = args
  requireBareId('createCheckoutLink', 'userId', userId)
  requireBareId('createCheckoutLink', 'productId', productId)
  requireText('createCheckoutLink', 'idempotencyKey', idempotencyKey)

  const writer = await writerFactory(db, locationId)
  await writer.ensureOp('checkout') // rejects Un1tWriteRefused (switch, studio, permissions)

  const host = await customerHost(db, locationId)
  if (!isCustomerUrl(successUrl, host) || !isCustomerUrl(cancelUrl, host)) throw refuseCheckout('not_a_customer_url')

  const { data: client, error: clientError } = await db
    .from('un1t_clients')
    .select('id')
    .eq('location_id', locationId)
    .eq('un1t_user_id', userId)
    .limit(1)
    .maybeSingle()
  if (clientError) throw new Un1tSettingsReadError(`un1t_clients read failed (${clientError.code ?? 'no code'})`, { code: 'mirror_read_failed' })
  if (!client) throw refuseCheckout('no_client_at_studio')

  const { data: product, error: productError } = await db
    .from('un1t_products')
    .select('un1t_id, status, price_cents')
    .eq('location_id', locationId)
    .eq('un1t_id', productId)
    .limit(1)
    .maybeSingle()
  if (productError) throw new Un1tSettingsReadError(`un1t_products read failed (${productError.code ?? 'no code'})`, { code: 'mirror_read_failed' })
  if (!product || statusOf(product) !== 'active' || !Number.isInteger(product.price_cents)) throw refuseCheckout('product_not_sellable')
  if (product.price_cents <= 0) throw refuseCheckout('free_product_not_via_checkout')

  const body = { productId, successUrl, cancelUrl, userId }
  writer.assertAllowed('checkout', 'POST', '/purchases/checkout', body)

  const r = await attemptWrite(db, writer, {
    attempt: { op: 'checkout', key: idempotencyKey, contactId: null, un1tUserId: userId, target: productId, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'idempotent',
    send: (row) => writer.send('POST', '/purchases/checkout', {
      body, policy: 'idempotent', idempotencyKey, op: 'checkout', origin, ledgerId: row.id, expect: {},
    }),
  })
  if (r.verdict === 'done') {
    const free = r.data?.free === true
    if (free) logInfo(LOG_MODULE, 'un1t.online answered the checkout as free', fields({ locationId, op: 'checkout', origin, ledgerId: r.ledgerId, code: 'checkout_free' }))
    // MIAFIX.1 — the un1t_write_events row's id, so the caller can link it.
    return { checkoutUrl: r.id, free, ledgerId: r.ledgerId ?? null }
  }
  if (r.verdict === 'refused') throw new Un1tWriteRefused(r.code, r.message ?? 'un1t.online refused the checkout.', r)
  const err = new Un1tWriteUnknown(r.code ?? 'outcome_unknown', r.message ?? UNKNOWN_CHECKOUT_TEXT)
  err.ledgerId = r.ledgerId
  throw err
}

// ── grantTrial ─────────────────────────────────────────────────────────────

const TRIAL_REASONS = new Set(['trial_used', 'membership_history', 'paid_pack'])
/** An in-doubt trial row younger than this, with no credits, goes to staff; older counts as used. */
export const UN1T_TRIAL_DOUBT_WINDOW_MS = 24 * 60 * 60_000
const TRIAL_ORIGINS = new Set(['funnel', 'approval', 'mia', 'test_account'])
const trialFailed = (code) => `un1t_trial_failed:${code ?? 'unknown'}`

/**
 * Does the person hold credits now? One budget-counted read of their credits
 * ledger: a balance of at least one, or unlimited. A failed or unreadable
 * read is null ("could not look"), never "no credits".
 * @returns {Promise<{ shows: boolean, ledger: object }|null>}
 */
async function readTrialCredits(writer, un1tUserId) {
  let ledger
  try {
    ledger = await writer.read(`/credits/ledgers/${encodeURIComponent(un1tUserId)}/${encodeURIComponent(writer.studioId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'trial credits read failed', fields({ locationId: writer.locationId, op: 'trial', code: err?.code ?? 'credits_read_failed' }))
    return null
  }
  if (!isObj(ledger)) return null
  const balance = typeof ledger.balance === 'number' && Number.isFinite(ledger.balance) ? ledger.balance : null
  const unlimited = ledger.is_unlimited === true
  if (balance == null && typeof ledger.is_unlimited !== 'boolean') return null
  return { shows: unlimited || (balance != null && balance >= 1), ledger }
}

/** Open (sent / unknown) trial rows for this person and product, either method. */
async function findOpenTrial(db, { locationId, un1tUserId, productId }) {
  const { data, error } = await db
    .from('un1t_write_events')
    .select('id, method, stage, created_at')
    .eq('location_id', locationId)
    .eq('op', 'trial')
    .eq('un1t_user_id', un1tUserId)
    .eq('target', productId)
    .in('stage', ['sent', 'unknown'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`un1t_write_events open trial read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
  return data ?? null
}

// ── The trial credit re-grant (TRIALREGRANT.1) ────────────────────────────
//
// Richard, 20 Oct 2026: a person who CLAIMED the free trial, never used it
// (no booking other than a cancelled one) and whose trial credits have run out may
// have a free class again. un1t.online sells the trial product only once, so
// grantTrial adds the credits instead, once ever per person per studio (the
// ledger's op 'trial_regrant', mig 760). Amount and expiry are fixed here: no
// setting holds the trial's credits or expiry.

/** Credits a re-grant adds (the trial's own three). */
export const UN1T_TRIAL_REGRANT_CREDITS = 3
/** Days until the re-granted credits expire (the trial's own seven). */
export const UN1T_TRIAL_REGRANT_EXPIRES_IN_DAYS = 7
/** grantTrial's `method` for a re-grant. */
export const UN1T_TRIAL_REGRANT_METHOD = 'credit_regrant'
const REGRANT_STAGES = Object.freeze(['done', 'sent', 'unknown'])

/**
 * The newest trial_regrant row (done, sent or unknown) for this person at the
 * studio, by their un1t user OR their contact; null when none. A refused row
 * granted nothing and does not count. Throws on a database error: an
 * unreadable history is never "no re-grant".
 */
async function findRegrant(db, { locationId, un1tUserId, contactId }) {
  const read = async (column, value) => {
    const { data, error } = await db
      .from('un1t_write_events')
      .select('id, un1t_user_id, contact_id, stage, created_at')
      .eq('location_id', locationId)
      .eq('op', 'trial_regrant')
      .eq(column, value)
      .in('stage', REGRANT_STAGES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw Object.assign(new Error(`un1t_write_events re-grant read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
    return data ?? null
  }
  const rows = [await read('un1t_user_id', un1tUserId), contactId ? await read('contact_id', contactId) : null].filter(Boolean)
  rows.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
  return rows[0] ?? null
}

/**
 * TRIALREGRANT.1 — POST /credits/grant { userId, amount: 3, expiresInDays: 7 }
 * for this person, ledgered first (op trial_regrant, key
 * trial_regrant:<loc>:<un1tUser>, also the idempotency-key header), judged on
 * the body and never re-sent (policy never). Called ONLY from grantTrial,
 * after every check (tests/un1t-online-write-guard.test.js): the person's
 * only ineligibility is trial_used, no booking other than a cancelled one, no
 * earlier re-grant, the live balance 0 and not unlimited, and the op's
 * switch and permissions. Returns the Un1tWriteResult with ledgerId; grantTrial
 * judges it.
 */
async function regrantTrialCredits(db, writer, { locationId, un1tUserId, contactId, origin, originRef, actor }) {
  const body = { userId: un1tUserId, amount: UN1T_TRIAL_REGRANT_CREDITS, expiresInDays: UN1T_TRIAL_REGRANT_EXPIRES_IN_DAYS }
  writer.assertAllowed('trial_regrant', 'POST', '/credits/grant', body)
  const key = ledgerKey.regrant(locationId, un1tUserId)
  return attemptWrite(db, writer, {
    attempt: { op: 'trial_regrant', key, contactId, un1tUserId, target: null, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'never',
    send: (row) => writer.send('POST', '/credits/grant', {
      body, policy: 'never', idempotencyKey: key, op: 'trial_regrant', origin, ledgerId: row.id, expect: {},
    }),
  })
}

/**
 * UN1TWRITE.10 — give a person the studio's free trial in un1t.online.
 *
 * Order (spec 6.6, with our own ledger read BEFORE A's eligibility, which
 * counts our done/sent/unknown rows as used and so would call our own grant
 * "trial_used"): the switch and the token (ensureOp) → the trial product
 * configured → the customer site root (read before anything is sent) → a
 * done trial by EITHER method (nothing sent: granted while its credits show,
 * else ineligible trial_used) → an open row (a sent one under
 * UN1T_IN_FLIGHT_MS is another process: retry; otherwise nothing sent, and
 * credits decide: granted and the row settled done, else
 * un1t_trial_unverified within UN1T_TRIAL_DOUBT_WINDOW_MS, trial_used after) →
 * A's eligibility (skipped only for test_account) → the live product, active
 * and priced exactly 0 (else trial_product_not_free, nothing sent) → the €0
 * charge (POST /purchases/charge, policy never, key trial:…:charge) → on a
 * refusal that is not the trial limit, ONE free checkout (policy never, key
 * trial:…:free_checkout, return pages = the studio's customer site root).
 *
 * How an answer is judged:
 * - charge done → granted (charge).
 * - charge or checkout refused as trial_used (the refusal table, PR 6) →
 *   ineligible trial_used. An unmapped refusal is never guessed as used.
 * - charge unknown → the credits read decides (granted / un1t_trial_unverified);
 *   the free checkout is never tried after an unclear charge.
 * - free checkout: the judge reads the documented { checkoutUrl, free }
 *   under expect.freeCheckout. free true is done, granted only if credits
 *   show (else un1t_trial_unverified); free false is refused
 *   checkout_not_free (un1t_trial_failed); no `free` at all is unknown and
 *   the credits read decides. The URL is never stored, returned or logged
 *   (op trial keeps no checkout_url, and the id is the transaction id or
 *   null).
 * - a credits read that fails → retry (credits_unreadable); the retry finds
 *   the open row and never sends again.
 * - a switch, studio or permission refusal → needs_staff
 *   un1t_trial_failed:<code>; budget, in-flight, throttle and an unreadable
 *   permission check → retry.
 * Every ledger row carries contactId. grantTrial files no card: the caller
 * files one with needs_staff.reason.
 *
 * TRIALREGRANT.1 (Richard, 20 Oct 2026) — the credit re-grant. First of all
 * (before the trial rows), a trial_regrant row already on the ledger for this
 * person (by user or contact) settles it with nothing sent: a sent one under
 * UN1T_IN_FLIGHT_MS is retry; otherwise credits showing → granted
 * (credit_regrant, an open row settled done); none → a done one is
 * trial_used, an open one un1t_trial_unverified inside
 * UN1T_TRIAL_DOUBT_WINDOW_MS and trial_used after. Then, wherever grantTrial
 * would answer trial_used from our own ledger (a done trial, or an old open
 * one, with no credits) or from A (trial_used its only reason, A's `regrant`
 * true), it re-grants instead when A says `regrant` (only trial_used, no
 * attended or no-show booking, no earlier re-grant), the live credits read
 * shows 0 and not unlimited, and the op's switch and permissions pass:
 * regrantTrialCredits, then done → granted (credit_regrant; the new balance
 * mirrored; credits read as none → un1t_trial_unverified); unknown, or a
 * transport refusal after the send → the credits read decides (granted /
 * un1t_trial_unverified / retry credits_unreadable, and the retry finds the
 * row and never sends again); un1t.online's refusal → needs_staff
 * un1t_trial_failed:<code>. A refusal as trial_used by un1t.online itself
 * after A said eligible is never re-granted.
 *
 * Rejects only as the other primitives do (Un1tSettingsReadError, a ledger
 * database error before anything was sent, a TypeError).
 *
 * @param {{ locationId: string, un1tUserId: string, contactId: string|null,
 *   origin: 'funnel'|'approval'|'mia'|'test_account', originRef?: string|null,
 *   actor?: { id: string }|null, skipEligibility?: boolean }} args
 * @returns {Promise<{ outcome: 'granted', method: 'charge'|'free_checkout'|'credit_regrant', ledgerId: string|null }
 *   | { outcome: 'ineligible', reason: 'trial_used'|'membership_history'|'paid_pack' }
 *   | { outcome: 'needs_staff', reason: string, message?: string|null, ledgerId?: string|null, method?: 'credit_regrant' }
 *   | { outcome: 'retry', code: string }>}
 */
export async function grantTrial(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date(), trialEligibility = un1tOnlineReads.trialEligibility } = deps
  const { locationId, un1tUserId, contactId = null, origin, originRef = null, actor = null, skipEligibility = false } = args
  if (!TRIAL_ORIGINS.has(origin)) throw new TypeError(`grantTrial: unknown origin '${origin}'`)
  if (skipEligibility && origin !== 'test_account') throw new TypeError('grantTrial: skipEligibility is for the test-account route only')
  requireBareId('grantTrial', 'un1tUserId', un1tUserId)

  const writer = await writerFactory(db, locationId)
  const meta = { locationId, op: 'trial', origin }
  const fromRefusal = (r) => (r.retryable
    ? { outcome: 'retry', code: r.code }
    : { outcome: 'needs_staff', reason: trialFailed(r.code), message: r.message ?? null, ledgerId: r.ledgerId ?? null })

  const refused = await opRefusal(writer, 'trial')
  if (refused) return fromRefusal(refused)

  const { settings } = await readUn1tWriteSettings(db, locationId)
  const productId = settings.trialProductId
  if (!productId) return { outcome: 'needs_staff', reason: 'trial_not_configured' }

  const mirror = (data, ledgerId) => safely(() => applyUn1tWriteToMirror(db, {
    op: 'trial', locationId, contactId, un1tUserId, studioId: writer.studioId, productId, data, ledgerId,
  }, mirrorDeps(writer, now)), { ...meta, ledgerId })

  // Credits decide whenever un1t.online's answer, or an earlier attempt, is
  // in doubt. Credits showing also settles an in-doubt ledger row as done.
  const settleDone = (ledgerId) => (ledgerId
    ? finishAttempt(db, ledgerId, { stage: 'done', recovered: 'credits_show' })
    : null)
  const byCredits = async (method, ledgerId, { noCredits = 'unverified', settle = true } = {}) => {
    const credits = await readTrialCredits(writer, un1tUserId)
    if (!credits) return { outcome: 'retry', code: 'credits_unreadable' }
    if (!credits.shows) {
      // Our own trial, spent: the re-grant decides (TRIALREGRANT.1).
      if (noCredits === 'used') return regrantOrUsed({ credits })
      return { outcome: 'needs_staff', reason: 'un1t_trial_unverified', ledgerId: ledgerId ?? null }
    }
    if (settle) await settleDone(ledgerId)
    await mirror({ credits: credits.ledger }, ledgerId)
    logInfo(LOG_MODULE, 'trial granted on the credits read', fields({ ...meta, ledgerId: ledgerId ?? undefined, recovered: 'credits_show' }))
    return { outcome: 'granted', method, ledgerId: ledgerId ?? null }
  }
  const methodOf = (row) => (row.method === 'free_checkout' ? 'free_checkout' : 'charge')
  const ageMs = (row) => now().getTime() - Date.parse(row.created_at)
  // A refusal from the transport itself (budget, throttle, token) is not
  // un1t.online's answer about the trial.
  const transportRefusal = (r) => r.verdict === 'refused' && (r.retryable || Object.values(C).includes(r.code))

  // ── TRIALREGRANT.1 ──
  const USED = Object.freeze({ outcome: 'ineligible', reason: 'trial_used' })
  const REGRANT = UN1T_TRIAL_REGRANT_METHOD
  const regrantMeta = { locationId, op: 'trial_regrant', origin }
  // A re-grant already on the ledger: nothing is sent again.
  const resumeRegrant = async (row) => {
    const age = ageMs(row)
    if (row.stage === 'sent' && (!Number.isFinite(age) || age < UN1T_IN_FLIGHT_MS)) return { outcome: 'retry', code: C.ATTEMPT_IN_FLIGHT }
    const credits = await readTrialCredits(writer, un1tUserId)
    if (!credits) return { outcome: 'retry', code: 'credits_unreadable' }
    if (credits.shows) {
      if (row.stage !== 'done') await settleDone(row.id)
      await mirror({ credits: credits.ledger }, row.id)
      return { outcome: 'granted', method: REGRANT, ledgerId: row.id }
    }
    // A done re-grant whose credits are gone was the one free class again.
    if (row.stage === 'done') return USED
    logWarn(LOG_MODULE, 'an earlier trial credit re-grant is in doubt; nothing sent', fields({ ...regrantMeta, ledgerId: row.id, verdict: 'unknown' }))
    const recent = Number.isFinite(age) && age < UN1T_TRIAL_DOUBT_WINDOW_MS
    return recent ? { outcome: 'needs_staff', reason: 'un1t_trial_unverified', method: REGRANT, ledgerId: row.id } : USED
  }
  // Where the answer would be trial_used: re-grant if the person qualifies.
  // `elig` (A's answer) and `credits` (a live read) are passed when held.
  const regrantOrUsed = async ({ elig = null, credits = null } = {}) => {
    let e = elig
    if (!e) {
      try {
        e = await trialEligibility(db, locationId, { un1tUserId, contactId })
      } catch {
        e = null
      }
      if (!e?.success) return { outcome: 'retry', code: 'eligibility_unreadable' }
    }
    if (e.data?.regrant !== true) return USED
    const live = credits ?? await readTrialCredits(writer, un1tUserId)
    if (!live) return { outcome: 'retry', code: 'credits_unreadable' }
    if (live.shows) return USED
    const off = await opRefusal(writer, 'trial_regrant')
    if (off) return { ...fromRefusal(off), ...(off.retryable ? {} : { method: REGRANT }) }
    const r = await regrantTrialCredits(db, writer, { locationId, un1tUserId, contactId, origin, originRef, actor })
    if (r.verdict === 'done') {
      const after = await readTrialCredits(writer, un1tUserId)
      if (after && !after.shows) {
        logWarn(LOG_MODULE, 'the re-granted trial credits do not show', fields({ ...regrantMeta, ledgerId: r.ledgerId, code: 'un1t_trial_unverified' }))
        return { outcome: 'needs_staff', reason: 'un1t_trial_unverified', method: REGRANT, ledgerId: r.ledgerId }
      }
      if (after) await mirror({ credits: after.ledger }, r.ledgerId)
      else logWarn(LOG_MODULE, 'credits unreadable after a done re-grant; the booking judges them', fields({ ...regrantMeta, ledgerId: r.ledgerId, code: 'credits_unreadable' }))
      logInfo(LOG_MODULE, 'trial credits re-granted', fields({ ...regrantMeta, ledgerId: r.ledgerId, verdict: 'done' }))
      return { outcome: 'granted', method: REGRANT, ledgerId: r.ledgerId }
    }
    if (r.verdict === 'unknown') {
      if (r.sent === false && !r.ledgerId) return { outcome: 'retry', code: r.code ?? 'outcome_unknown' }
      return byCredits(REGRANT, r.ledgerId)
    }
    if (transportRefusal(r)) return r.sent ? byCredits(REGRANT, r.ledgerId) : fromRefusal(r)
    return { outcome: 'needs_staff', reason: trialFailed(r.code), message: r.message ?? null, method: REGRANT, ledgerId: r.ledgerId ?? null }
  }

  // The customer site root (the free checkout's return pages), read before
  // anything is sent: an unreadable one rejects with nothing sent.
  const base = await resolveCustomerBaseUrl(db, locationId).catch(() => null)
  let root = null
  try {
    const u = new URL(base)
    if (u.protocol === 'https:') root = `${u.origin}/`
  } catch { /* falls through */ }
  if (!root) throw new Un1tSettingsReadError("this studio's customer site could not be read", { code: 'customer_url_unreadable' })

  // 0. A credit re-grant we already made (TRIALREGRANT.1, once ever).
  const priorRegrant = await findRegrant(db, { locationId, un1tUserId, contactId })
  if (priorRegrant) return resumeRegrant(priorRegrant)

  // 1. What we already did. A trial we granted before stands only while its
  //    credits do: with none left the person has had it (trial_used), so the
  //    funnel sends them the trial-used email instead of a doomed booking.
  // A grant inside the doubt window stands as is (its credits may not show
  // yet, and the booking judges them); an older one stands while they do.
  const done = await findDoneTrial(db, { locationId, un1tUserId, productId })
  if (done) {
    const doneAge = ageMs(done)
    if (Number.isFinite(doneAge) && doneAge < UN1T_TRIAL_DOUBT_WINDOW_MS) return { outcome: 'granted', method: methodOf(done), ledgerId: done.id }
    return byCredits(methodOf(done), done.id, { noCredits: 'used', settle: false })
  }
  const open = await findOpenTrial(db, { locationId, un1tUserId, productId })
  if (open) {
    const age = ageMs(open)
    // Another process is sending it right now: wait for it, never judge it.
    if (open.stage === 'sent' && (!Number.isFinite(age) || age < UN1T_IN_FLIGHT_MS)) {
      return { outcome: 'retry', code: C.ATTEMPT_IN_FLIGHT }
    }
    logWarn(LOG_MODULE, 'an earlier trial attempt is in doubt; nothing sent', fields({ ...meta, ledgerId: open.id, verdict: 'unknown' }))
    // Recent: staff check it (un1t_trial_unverified). Older with no credits:
    // whatever it did is spent, and A counts the row as used anyway.
    const recent = Number.isFinite(age) && age < UN1T_TRIAL_DOUBT_WINDOW_MS
    return byCredits(methodOf(open), open.id, { noCredits: recent ? 'unverified' : 'used' })
  }

  // 2. A's eligibility.
  if (!skipEligibility) {
    let elig
    try {
      elig = await trialEligibility(db, locationId, { un1tUserId, contactId })
    } catch {
      elig = null
    }
    if (!elig?.success) return { outcome: 'retry', code: 'eligibility_unreadable' }
    if (elig.data?.eligible !== true) {
      const reason = (elig.data?.reasons ?? []).find((r) => TRIAL_REASONS.has(r)) ?? 'trial_used'
      // TRIALREGRANT.1: claimed, never used, run out → the credit re-grant.
      if (reason === 'trial_used' && elig.data?.regrant === true) return regrantOrUsed({ elig })
      return { outcome: 'ineligible', reason }
    }
  }

  // 3. The live product: active and priced exactly 0, or nothing is sent.
  let product
  try {
    product = await writer.read(`/products/${encodeURIComponent(productId)}`)
  } catch (err) {
    if (err instanceof Un1tWriteRefused && err.result) return fromRefusal(err.result)
    logWarn(LOG_MODULE, 'trial product read failed; nothing sent', fields({ ...meta, code: err?.code ?? 'product_read_failed' }))
    return { outcome: 'retry', code: 'product_unreadable' }
  }
  if (!isObj(product) || !sameIdText(product.id ?? productId, productId) || statusOf(product) !== 'active' || product.price_amount !== 0) {
    logWarn(LOG_MODULE, 'the trial product is not a live free product; nothing sent', fields({ ...meta, code: 'trial_product_not_free' }))
    return { outcome: 'needs_staff', reason: 'trial_product_not_free' }
  }

  const attemptFor = (method) => ({
    op: 'trial', key: ledgerKey.trial(locationId, un1tUserId, productId, method), contactId, un1tUserId, target: productId,
    method, origin, originRef, actorUserId: actorIdOf(actor),
  })
  const isTrialUsed = (r) => classifyRefusal({ code: r.code, message: r.message }) === 'trial_used'

  // 4. The €0 charge.
  const chargeBody = { userId: un1tUserId, productId }
  writer.assertAllowed('trial', 'POST', '/purchases/charge', chargeBody)
  const chargeAttempt = attemptFor('charge')
  const charged = await attemptWrite(db, writer, {
    attempt: chargeAttempt,
    policy: 'never',
    send: (row) => writer.send('POST', '/purchases/charge', {
      body: chargeBody, policy: 'never', idempotencyKey: chargeAttempt.key, op: 'trial', origin, ledgerId: row.id, expect: {},
    }),
  })
  if (charged.verdict === 'done') {
    await mirror({ transactionId: charged.id, product }, charged.ledgerId)
    return { outcome: 'granted', method: 'charge', ledgerId: charged.ledgerId }
  }
  if (charged.verdict === 'unknown') {
    if (charged.sent === false && !charged.ledgerId) return { outcome: 'retry', code: charged.code ?? 'outcome_unknown' }
    return byCredits('charge', charged.ledgerId)
  }
  if (transportRefusal(charged)) {
    if (charged.sent) return byCredits('charge', charged.ledgerId)
    return fromRefusal(charged)
  }
  if (isTrialUsed(charged)) return { outcome: 'ineligible', reason: 'trial_used' }

  // 5. One free checkout, completed by the server.
  const checkoutBody = { productId, successUrl: root, cancelUrl: root, userId: un1tUserId }
  writer.assertAllowed('trial', 'POST', '/purchases/checkout', checkoutBody)
  const checkoutAttempt = attemptFor('free_checkout')
  const checked = await attemptWrite(db, writer, {
    attempt: checkoutAttempt,
    policy: 'never',
    send: (row) => writer.send('POST', '/purchases/checkout', {
      body: checkoutBody, policy: 'never', idempotencyKey: checkoutAttempt.key, op: 'trial', origin, ledgerId: row.id, expect: { freeCheckout: true },
    }),
  })
  if (checked.verdict === 'done') {
    const credits = await readTrialCredits(writer, un1tUserId)
    if (!credits) return { outcome: 'retry', code: 'credits_unreadable' }
    if (!credits.shows) {
      logWarn(LOG_MODULE, 'the free checkout did not show the trial credits', fields({ ...meta, ledgerId: checked.ledgerId, code: 'un1t_trial_unverified' }))
      return { outcome: 'needs_staff', reason: 'un1t_trial_unverified', ledgerId: checked.ledgerId }
    }
    await mirror({ transactionId: checked.id, product, credits: credits.ledger }, checked.ledgerId)
    return { outcome: 'granted', method: 'free_checkout', ledgerId: checked.ledgerId }
  }
  if (checked.verdict === 'unknown') {
    if (checked.sent === false && !checked.ledgerId) return { outcome: 'retry', code: checked.code ?? 'outcome_unknown' }
    return byCredits('free_checkout', checked.ledgerId)
  }
  if (transportRefusal(checked)) {
    if (checked.sent) return byCredits('free_checkout', checked.ledgerId)
    return fromRefusal(checked)
  }
  if (isTrialUsed(checked)) return { outcome: 'ineligible', reason: 'trial_used' }
  return { outcome: 'needs_staff', reason: trialFailed(checked.code), message: checked.message ?? null, ledgerId: checked.ledgerId ?? null }
}

// ── chargeClassFee (FEES.1) ─────────────────────────────────────────────────

export const FEE_NO_CARD = 'NO_CARD_ON_FILE'
const FEE_NO_CARD_TEXT = 'This client has no usable card on file in un1t.online, so nothing was charged.'
const MAX_FEE_CHARGE_CENTS = 100_000

/**
 * Does the person hold a usable default card? One budget-counted read.
 * true / false, or null when the read failed or could not be understood
 * ("could not look", never "no card").
 */
async function readHasUsableCard(writer, un1tUserId) {
  let cards
  try {
    cards = await writer.read(`/payment-methods/client/${encodeURIComponent(un1tUserId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'card read failed', fields({ locationId: writer.locationId, op: 'fee_charge', code: err?.code ?? 'card_read_failed' }))
    return null
  }
  if (!Array.isArray(cards)) return null
  return cards.some((c) => isObj(c) && c.is_expired !== true && (c.is_default === true || cards.length === 1))
}

/**
 * Charge one late-cancel or no-show fee to the member's default card in
 * un1t.online (POST /purchases/charge-custom). Called ONLY by the class-fees
 * run (origin 'fee_run') and the staff retry route (origin 'staff'); never by
 * Mia (tests/mia-no-charge-no-refund-guard.test.js).
 *
 * - A fresh attempt first reads the member's cards: none usable is refused
 *   NO_CARD_ON_FILE with nothing sent; a failed read refuses retryable.
 *   A resumed attempt (`resume`) skips the read: its key may already have
 *   taken the money, and only the same key can say so.
 * - The key is fee:<loc>:<feeId>:<attempt>, also the idempotency-key header,
 *   under policy 'idempotent': an unclear answer is re-sent once with the
 *   same key, and an open attempt is resumed with it.
 *
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, feeId: string,
 *   attempt: number, amountCents: number, description: string, origin: 'fee_run'|'staff',
 *   actor?: { id: string }|null, resume?: boolean }} args
 * @returns {Promise<object>} Un1tWriteResult; done: id = the un1t.online transaction id.
 */
export async function chargeClassFee(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter } = deps
  const {
    locationId, contactId = null, un1tUserId, feeId, attempt, amountCents, description,
    origin, actor = null, resume = false,
  } = args
  requireBareId('chargeClassFee', 'un1tUserId', un1tUserId)
  requireBareId('chargeClassFee', 'feeId', feeId)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_FEE_CHARGE_CENTS) {
    throw new TypeError('chargeClassFee: amountCents must be a whole number of cents from 1 to 100000')
  }
  requireText('chargeClassFee', 'description', description)
  if (origin !== 'fee_run' && origin !== 'staff') throw new TypeError("chargeClassFee: origin must be 'fee_run' or 'staff'")

  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'fee_charge')
  if (refused) return refused
  const body = { userId: un1tUserId, amount: amountCents, currency: 'eur', description: String(description).slice(0, 200) }
  writer.assertAllowed('fee_charge', 'POST', '/purchases/charge-custom', body)

  if (!resume) {
    const hasCard = await readHasUsableCard(writer, un1tUserId)
    if (hasCard === null) {
      return withLedger(refusalResult('card_read_failed', 'un1t.online did not answer the card check, so nothing was charged. It will be tried again.', { retryable: true }))
    }
    if (hasCard === false) return withLedger(result('refused', { code: FEE_NO_CARD, message: FEE_NO_CARD_TEXT }))
  }

  const key = ledgerKey.fee(locationId, feeId, attempt)
  return attemptWrite(db, writer, {
    attempt: {
      op: 'fee_charge', key, contactId, un1tUserId, target: feeId,
      origin, originRef: feeId, actorUserId: actorIdOf(actor),
    },
    policy: 'idempotent',
    send: (row) => writer.send('POST', '/purchases/charge-custom', {
      body, policy: 'idempotent', idempotencyKey: key, op: 'fee_charge', origin, ledgerId: row.id,
    }),
  })
}

// ── grantCompCredits (UN1TCOMP.1) ──────────────────────────────────────────
//
// Richard, 28 Oct 2026: staff with the un1t_comp_credits permission may add
// complimentary class credits, with a use-by date, to a member's un1t.online
// account from the contact page. The same POST /credits/grant as the trial
// re-grant, as its own op (comp_credits, mig 787) so the re-grant's once-ever
// rule is untouched. Staff only (origin 'staff', an actor): Mia never reaches
// it (tests/mia-no-charge-no-refund-guard.test.js).

/**
 * Did a complimentary grant land? One budget-counted GET
 * /credits/ledgers/{userId}/{studioId}: an admin batch of exactly `amount`,
 * created since the send, whose expires_at is within a day of
 * sentAt + expiresInDays → landed (its id and the batch). A readable batch
 * list with none → absent. No batch list in the answer, a candidate batch
 * whose dates cannot be read, or a failed read → unknown. Never throws.
 *
 * The batch list's key is not in the OpenAPI snapshot (the spec documents
 * the grant's answer, GrantCreditsResponseDto, not the ledger's batches), so
 * `batches` and `credit_batches` are read and anything else is unknown: an
 * unfamiliar answer is never "absent".
 * @returns {Promise<{ state: 'landed'|'absent'|'unknown', id: string|null, batch: object|null }>}
 */
export async function findLandedCompGrant(writer, { un1tUserId, amount, expiresInDays, sentAt } = {}) {
  const unknown = { state: 'unknown', id: null, batch: null }
  let ledger
  try {
    ledger = await writer.read(`/credits/ledgers/${encodeURIComponent(un1tUserId)}/${encodeURIComponent(writer.studioId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'complimentary credits check read failed', fields({ locationId: writer.locationId, op: 'comp_credits', code: err?.code ?? 'credits_read_failed' }))
    return unknown
  }
  const list = isObj(ledger) ? (Array.isArray(ledger.batches) ? ledger.batches : Array.isArray(ledger.credit_batches) ? ledger.credit_batches : null) : null
  if (!list) return unknown
  const sentMs = msOf(sentAt)
  if (!Number.isFinite(sentMs)) return unknown
  const wantExpiry = sentMs + expiresInDays * 86_400_000
  let doubt = false
  for (const raw of list) {
    if (!isObj(raw)) continue
    const b = pickCompBatch(raw)
    if (String(b.source ?? '').trim().toLowerCase() !== 'admin' || b.original_amount !== amount) continue
    const created = msOf(b.created_at)
    const expires = msOf(b.expires_at)
    if (!Number.isFinite(created) || !Number.isFinite(expires)) { doubt = true; continue }
    if (created < sentMs - UN1T_LANDED_SKEW_MS) continue
    if (Math.abs(expires - wantExpiry) > 86_400_000) continue
    return { state: 'landed', id: idText(b.id), batch: b }
  }
  return doubt ? unknown : { state: 'absent', id: null, batch: null }
}

// The second fence: the route validates the same limits first. A value off
// them is a programming error, so it throws before anything is read or sent.
function requireCompArgs(a) {
  const fn = 'comp credits'
  requireBareId(fn, 'un1tUserId', a.un1tUserId)
  requireText(fn, 'requestId', a.requestId)
  const L = COMP_CREDIT_LIMITS
  if (!Number.isInteger(a.amount) || a.amount < L.minCredits || a.amount > L.maxCredits) throw new TypeError(`${fn}: amount must be a whole number from ${L.minCredits} to ${L.maxCredits}`)
  if (!Number.isInteger(a.expiresInDays) || a.expiresInDays < L.minDays || a.expiresInDays > L.maxDays) throw new TypeError(`${fn}: expiresInDays must be a whole number from ${L.minDays} to ${L.maxDays}`)
  if (!isDateKey(a.useBy)) throw new TypeError(`${fn}: useBy must be a YYYY-MM-DD day`)
  if (!COMP_CREDIT_REASON_KEYS.includes(a.reason)) throw new TypeError(`${fn}: unknown reason`)
  if (a.note != null && typeof a.note !== 'string') throw new TypeError(`${fn}: note must be text`)
  if (compNoteProblem(a.note)) throw new TypeError(`${fn}: ${compNoteProblem(a.note)}`)
  if (a.origin !== 'staff') throw new TypeError(`${fn}: only staff add complimentary credits`)
  if (!actorIdOf(a.actor)) throw new TypeError(`${fn}: the member of staff (actor) is required`)
}

/**
 * UN1TCOMP.1 — add `amount` complimentary credits, usable for
 * `expiresInDays` days, to a member's un1t.online account: ONE POST
 * /credits/grant { userId, amount, expiresInDays }, op comp_credits, ledgered
 * first (key comp:<loc>:<un1tUser>:<requestId>, also the idempotency-key
 * header) with the actor, the amount, the use-by day, the reason and the team
 * note. Judged on the body and never re-sent (policy never): after a 5xx or
 * no reply findLandedCompGrant reports a landing (done, landed_after_5xx),
 * and anything else is unknown, which staff check in un1t.online. On done the
 * client's credit balance is refreshed in the mirror, and the result's data
 * is the batch (its expires_at is what staff see).
 *
 * Throw contract as the other primitives: the switch, the token and the
 * budget RESOLVE as refusals (nothing sent, no ledger row); it rejects only
 * with a TypeError (an argument off the limits, the wrong origin, no actor),
 * Un1tSettingsReadError or a ledger database error before anything was sent.
 *
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, amount: number,
 *   expiresInDays: number, useBy: string, reason: string, note?: string|null, requestId: string,
 *   origin: 'staff', actor: { id: string } }} args
 * @param {{ writerFactory?: typeof createUn1tWriter, now?: () => Date }} [deps]
 * @returns {Promise<object>} Un1tWriteResult with ledgerId.
 */
export async function grantCompCredits(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter, now = () => new Date() } = deps
  requireCompArgs(args)
  const { locationId, contactId = null, un1tUserId, amount, expiresInDays, useBy, reason, requestId, origin, actor } = args
  const note = plainText(args.note)
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'comp_credits')
  if (refused) return refused
  const body = { userId: un1tUserId, amount, expiresInDays }
  writer.assertAllowed('comp_credits', 'POST', '/credits/grant', body)
  const key = ledgerKey.comp(locationId, un1tUserId, requestId)

  // Set just before the send; NaN on a resume (the old send time is not
  // ours to know), so a resumed check read is unknown, never a guess.
  let sentAt = NaN
  let landed = null
  const verify = async () => {
    const chk = await findLandedCompGrant(writer, { un1tUserId, amount, expiresInDays, sentAt })
    if (chk.state === 'landed') landed = chk.batch
    return chk
  }
  const batchOf = (r) => (r.data ?? landed ?? null)
  return attemptWrite(db, writer, {
    attempt: {
      op: 'comp_credits', key, contactId, un1tUserId, target: null, origin, originRef: null, actorUserId: actorIdOf(actor),
      comp: { amount, expiresInDays, useBy, reason, note },
    },
    policy: 'never',
    verify,
    send: (row) => {
      sentAt = now().getTime()
      return writer.send('POST', '/credits/grant', {
        body, policy: 'never', idempotencyKey: key, verify, op: 'comp_credits', origin, ledgerId: row.id, expect: { amount },
      })
    },
    finishExtra: (r) => (r.verdict === 'done' ? { compExpiresAt: batchOf(r)?.expires_at ?? null } : {}),
    onDone: async (r) => {
      const data = batchOf(r)
      await applyUn1tWriteToMirror(db, {
        op: 'comp_credits', locationId, contactId, un1tUserId, studioId: writer.studioId, ledgerId: r.ledgerId,
      }, mirrorDeps(writer, now))
      return { data }
    },
  })
}
