// UN1TWRITE.4 — the un1t.online write ledger helpers (table: un1t_write_events,
// mig 742, service role only).
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

const FINISH_STAGES = new Set(['sent', 'done', 'refused', 'unknown'])
// un1t_write_events_message_length_check: char_length(message) <= 500.
const MESSAGE_MAX = 500

function part(name, v) {
  if (typeof v !== 'string' || v === '') throw new TypeError(`ledgerKey: '${name}' is required`)
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
  pw: (loc, un1tUserId) => `pw:${part('loc', loc)}:${part('un1tUserId', un1tUserId)}`,
})

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

  const age = Date.now() - new Date(open.created_at).getTime()
  const inFlight = open.stage === 'sent' && Number.isFinite(age) && age < UN1T_IN_FLIGHT_MS
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
      logError(LOG_MODULE, 'ledger finish refused: unknown stage', { ledgerId: id, stage: String(stage) })
      return
    }
    const patch = { stage, finished_at: new Date().toISOString() }
    if (un1tRef !== undefined) patch.un1t_ref = un1tRef
    if (httpStatus !== undefined) patch.http_status = httpStatus
    if (code !== undefined) patch.code = code
    if (message !== undefined) patch.message = message == null ? null : String(message).slice(0, MESSAGE_MAX)
    if (recovered !== undefined) patch.recovered = recovered
    if (checkoutUrl !== undefined) patch.checkout_url = checkoutUrl

    const { data, error } = await db.from('un1t_write_events').update(patch).eq('id', id).select('id')
    if (error) {
      logError(LOG_MODULE, 'ledger finish write failed', { ledgerId: id, stage, dbCode: error.code ?? null })
      return
    }
    if (!data || data.length === 0) {
      logError(LOG_MODULE, 'ledger finish touched no row', { ledgerId: id, stage })
    }
  } catch (err) {
    logError(LOG_MODULE, 'ledger finish threw', { ledgerId: id, errName: err?.name ?? null })
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
  if (error) throw dbError('list', error)
  return data ?? []
}
