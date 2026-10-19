// UN1TWRITE.4 — the un1t.online write ledger helpers (table: un1t_write_events,
// mig 744, service role only).
//
// One row per write attempt. beginAttempt is the WRITE-AHEAD marker: the row
// exists, stage 'sent', BEFORE the request goes out, so a crash, a retry or an
// approval resumes from it instead of re-sending. The database enforces "one
// attempt in flight or in doubt per key" (un1t_write_events_one_open, partial
// unique on idempotency_key where stage in sent/unknown); beginAttempt turns
// that 23505 into "here is the open row, and is it still running".
//
// Throw contract: beginAttempt / findDone / listAttempts THROW on a database
// error, because the caller has sent nothing yet and a retry is safe, and
// because a failed read must never read as "no attempt, send it". finishAttempt
// NEVER throws: by then the request has been sent and the caller owns a
// verdict; a failed bookkeeping write is logged and the verdict still stands.
//
// Logs carry ids and the database error CODE only. Never `details` (a unique
// violation's details quotes the key) and never the row.

import { logError } from './log'

const LOG_MODULE = 'un1t-online-write'

/** A `sent` row younger than this is treated as still running (spec 6.2). */
export const UN1T_IN_FLIGHT_MS = 180_000

// Named columns (never '*'): the whole row a resume needs.
const LEDGER_COLUMNS =
  'id, location_id, contact_id, un1t_user_id, op, origin, origin_ref, actor_user_id, idempotency_key, target, stage, method, un1t_ref, terms_accepted_at, terms_source, checkout_url, http_status, code, message, recovered, created_at, finished_at'

// 'sent' is the write-ahead marker beginAttempt inserts; it is never a finish value.
const FINISH_STAGES = new Set(['done', 'refused', 'unknown'])
// listAttempts is a resume read for ONE contact and op; two hundred attempts is
// far past anything real, and the explicit limit stops PostgREST's silent 1000-row cut.
const LIST_LIMIT = 200
// un1t_write_events_message_length_check: char_length(message) <= 500.
const MESSAGE_MAX = 500

function part(name, v) {
  if (typeof v !== 'string' || v === '') throw new TypeError(`ledgerKey: '${name}' is required`)
  return v
}

function attemptNo(v) {
  if (!Number.isSafeInteger(v) || v < 1) throw new TypeError("ledgerKey: 'attempt' must be a whole number from 1")
  return v
}

/**
 * The idempotency keys, also the `idempotency-key` header on purchase calls.
 * A missing part throws rather than minting a key with "undefined" in it.
 */
export const ledgerKey = Object.freeze({
  create: (loc, contactId) => `create:${part('loc', loc)}:${part('contactId', contactId)}`,
  trial: (loc, un1tUserId, productId, method) =>
    `trial:${part('loc', loc)}:${part('un1tUserId', un1tUserId)}:${part('productId', productId)}:${part('method', method)}`,
  book: (loc, un1tUserId, eventId) => `book:${part('loc', loc)}:${part('un1tUserId', un1tUserId)}:${part('eventId', eventId)}`,
  cancel: (loc, bookingId) => `cancel:${part('loc', loc)}:${part('bookingId', bookingId)}`,
  // UN1TWRITE.25: one key per reset ATTEMPT (n = 1, 2, 3, ... per person),
  // so the one-open and one-done indexes guard a double-send of the same
  // attempt and never block the next one. Rows written before it carry the
  // bare pw:<loc>:<un1tUser> (attempt 0); see resetAttemptNo.
  pw: (loc, un1tUserId, attempt) => `pw:${part('loc', loc)}:${part('un1tUserId', un1tUserId)}:${attemptNo(attempt)}`,
})

/**
 * The attempt number a reset key names for this person: 0 for the bare
 * pre-UN1TWRITE.25 key, n for pw:<loc>:<user>:<n>, null for anything else.
 */
export function resetAttemptNo(key, loc, un1tUserId) {
  const base = `pw:${loc}:${un1tUserId}`
  if (key === base) return 0
  if (typeof key !== 'string' || !key.startsWith(`${base}:`)) return null
  const tail = key.slice(base.length + 1)
  return /^[1-9][0-9]{0,8}$/.test(tail) ? Number(tail) : null
}

// Cut on code points (the CHECK counts characters, and a UTF-16 slice can split
// an emoji), then drop any lone surrogate so the text is valid to store.
function capMessage(message) {
  const cut = Array.from(String(message)).slice(0, MESSAGE_MAX).join('')
  return cut.toWellFormed()
}

function dbError(what, error) {
  const code = error?.code ?? null
  return Object.assign(new Error(`un1t_write_events ${what} failed (${code ?? 'no code'})`), { code })
}

/**
 * Insert the write-ahead `sent` row.
 *
 * @returns {Promise<{ row: object } | { open: object, inFlight: boolean }>}
 *   `{ row }` = this caller owns the attempt, go and send.
 *   `{ open, inFlight }` = another attempt for this key is open (sent or
 *   unknown). inFlight = a `sent` row younger than UN1T_IN_FLIGHT_MS; an
 *   `unknown` row is never in flight (the caller's dedupe read decides).
 * @throws on any other database error, or when the open row cannot be read
 *   back. Nothing has been sent, so a retry is safe.
 */
export async function beginAttempt(
  db,
  { locationId, contactId, un1tUserId, op, origin, originRef, actorUserId, key, target, method, termsAcceptedAt, termsSource },
) {
  if (!locationId || !op || !origin || !key) {
    throw new TypeError('beginAttempt: locationId, op, origin and key are required')
  }
  // A trial row names its person and product (mig 744 trial_target_check
  // and the one-trial index key on them). Refuse here, before the insert, a
  // row the database would take as a hole in the one-trial rule or reject.
  if (op === 'trial') {
    if (!un1tUserId || !target) throw new TypeError('beginAttempt: a trial needs un1tUserId and target')
    // key = trial:<loc>:<un1tUser>:<product>:<method>
    const parts = key.split(':')
    if (parts.length !== 5 || parts[0] !== 'trial' || parts[3] !== target) {
      throw new TypeError("beginAttempt: a trial's target must be the product id in its trial key")
    }
  }
  const { data, error } = await db
    .from('un1t_write_events')
    .insert({
      location_id: locationId,
      contact_id: contactId ?? null,
      un1t_user_id: un1tUserId ?? null,
      op,
      origin,
      origin_ref: originRef ?? null,
      actor_user_id: actorUserId ?? null,
      idempotency_key: key,
      target: target ?? null,
      stage: 'sent',
      method: method ?? null,
      terms_accepted_at: termsAcceptedAt ?? null,
      terms_source: termsSource ?? null,
    })
    .select(LEDGER_COLUMNS)
    .single()
  if (!error) {
    if (!data?.id) throw dbError('insert', { code: 'no_row' })
    return { row: data }
  }
  if (error.code !== '23505') throw dbError('insert', error)

  // The open-row index refused us: read the row that holds the key.
  const { data: open, error: readError } = await db
    .from('un1t_write_events')
    .select(LEDGER_COLUMNS)
    .eq('idempotency_key', key)
    .in('stage', ['sent', 'unknown'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (readError) throw dbError('open-row read', readError)
  // It finished between our insert and this read. Nothing was sent; the
  // caller's retry sees the finished row (findDone) or inserts afresh.
  if (!open) throw dbError('open-row read (no open row left)', { code: 'open_row_gone' })

  // An unparsable created_at counts as in flight: the safe direction is to
  // not send a second request over a row we cannot age.
  const age = open.created_at ? Date.now() - new Date(open.created_at).getTime() : NaN
  const inFlight = open.stage === 'sent' && (!Number.isFinite(age) || age < UN1T_IN_FLIGHT_MS)
  return { open, inFlight }
}

/**
 * Record how an attempt ended. A judged write (zero rows touched is logged),
 * and it never throws: the caller already holds the verdict.
 * Only the fields given are written, plus finished_at.
 */
export async function finishAttempt(db, id, { stage, un1tRef, httpStatus, code, message, recovered, checkoutUrl } = {}) {
  try {
    if (!FINISH_STAGES.has(stage)) {
      // The caller's value is not echoed: only contract fields are logged.
      logError(LOG_MODULE, 'ledger finish refused: not a finish stage', { ledgerId: id })
      return
    }
    const patch = { stage, finished_at: new Date().toISOString() }
    if (un1tRef !== undefined) patch.un1t_ref = un1tRef
    if (httpStatus !== undefined) patch.http_status = httpStatus
    if (code !== undefined) patch.code = code
    if (message !== undefined) patch.message = message == null ? null : capMessage(message)
    if (recovered !== undefined) patch.recovered = recovered
    if (checkoutUrl !== undefined) patch.checkout_url = checkoutUrl

    // done (and refused) is final: only a row still sent or unknown is finished.
    const { data, error } = await db
      .from('un1t_write_events')
      .update(patch)
      .eq('id', id)
      .in('stage', ['sent', 'unknown'])
      .select('id')
    if (error) {
      logError(LOG_MODULE, 'ledger finish write failed', { ledgerId: id, status: stage, code: error.code ?? null })
      return
    }
    if (!data || data.length === 0) {
      logError(LOG_MODULE, 'ledger finish touched no row', { ledgerId: id, status: stage })
    }
  } catch {
    logError(LOG_MODULE, 'ledger finish threw', { ledgerId: id })
  }
}

/** The latest `done` row for a key, or null. Throws on a database error. */
export async function findDone(db, { key }) {
  if (!key) throw new TypeError('findDone: key is required')
  const { data, error } = await db
    .from('un1t_write_events')
    .select(LEDGER_COLUMNS)
    .eq('idempotency_key', key)
    .eq('stage', 'done')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw dbError('done read', error)
  return data ?? null
}

/**
 * Every forgot-password attempt for one un1t.online user at a location, newest
 * first (UN1TWRITE.25: the reset allowance and the next attempt number).
 * Throws on a database error: a failed read must never read as "no resets".
 */
export async function listResetAttempts(db, { locationId, un1tUserId }) {
  if (!locationId || !un1tUserId) throw new TypeError('listResetAttempts: locationId and un1tUserId are required')
  const { data, error } = await db
    .from('un1t_write_events')
    .select(LEDGER_COLUMNS)
    .eq('location_id', locationId)
    .eq('un1t_user_id', un1tUserId)
    .eq('op', 'forgot_password')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT)
  if (error) throw dbError('reset list', error)
  return data ?? []
}

/** Every attempt for a contact and op at a location, newest first (the processor's resume). */
export async function listAttempts(db, { locationId, contactId, op }) {
  if (!locationId || !contactId || !op) throw new TypeError('listAttempts: locationId, contactId and op are required')
  const { data, error } = await db
    .from('un1t_write_events')
    .select(LEDGER_COLUMNS)
    .eq('location_id', locationId)
    .eq('contact_id', contactId)
    .eq('op', op)
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT)
  if (error) throw dbError('list', error)
  return data ?? []
}
