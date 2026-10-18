// UN1TWRITE.5 — the un1t.online write transport (createUn1tWriter), and
// UN1TWRITE.6 — the primitives book, cancel, createClient, forgotPassword and
// createCheckoutLink (grantTrial arrives in Task 10), which call ONLY the
// transport, the ledger and the mirror (un1t-online-mirror-write.js).
//
// What the transport guarantees (spec 6.1, global constraints):
// - It sends the six allowlisted calls and nothing else, with the snapshot
//   body keys and never bypassCredit / forceRefund / promoCode. Anything else
//   is a TypeError before any request: a programming error, nothing sent.
// - Every write first passes ensureOp: writes switched on, the token's
//   studio is this location's external_account_id, the op's permissions are
//   on the token (GET /api-token, cached 5 minutes per token fingerprint,
//   dropped on any 401/403). It fails closed.
// - One HTTP request per attempt. 429 = throttled BEFORE processing, so it is
//   waited out and retried (reset, else Retry-After, else 1s * 2^n, three
//   times) for every policy. 401/403 is final (UN1T_AUTH). The judge never
//   sees 401, 403 or 429.
// - A 5xx, no reply, or an answer the judge calls unknown is handled by the
//   call's policy: 'verify' runs its dedupe read once and re-sends once only
//   on 'absent'; 'never' never re-sends (an optional check read can only
//   report a landing); 'idempotent' re-sends once with the SAME
//   idempotency-key. A words-only "already booked" hint is settled by the
//   dedupe read and NEVER re-sent on.
// - Every HTTP request (writes, permission and dedupe reads) takes one slot of
//   checkRateLimit('un1t-write:<loc>', 30 / 60 s), shared across instances.
//   Spent before the write: nothing sent, UN1T_RATE_BUDGET, retryable. Spent
//   after a write went out (its check read, its re-send): wait for the window.
// - One error_events row per failed write (5xx, 429 after retries, no reply,
//   unclear, auth, an unmapped refusal), never when the check read found it
//   landed and never for a known business refusal; at most 5 a minute per
//   instance, plus one summary warn.
// - Logs carry only { locationId, op, origin, ledgerId, status, verdict,
//   code, recovered, attempt, waitMs }. Never the token, an email, a name, a
//   phone, a password or a checkout URL. A checkout's result `id` IS its URL,
//   so no log line ever carries `id`. Every message un1t.online words is
//   scrubbed of the token and the person's email, password and phone (and
//   the phone's normalised forms).
// - The policy belongs to the op (UN1T_OP_POLICY), never to the caller: a
//   purchase or a reset email can never be opened or sent as re-sendable.
//
// A primitive calls, in this order:
//   writer.ensureOp(op) → writer.assertAllowed(op, method, path, body)
//   → writer.openAttempt(attempt, { verify }) → writer.send(...)
//   → finishAttempt(db, ledgerId, ...)
// so nothing reaches the ledger that the transport would refuse to send.

import { createUn1tClient, Un1tAuthError, Un1tApiError, resetWaitMs, headerNumber, MAX_WAIT_MS, DEFAULT_BASE_URL } from './un1t-online.js'
import { readConnection } from './connection-registry.js'
import { tokenFingerprint } from './un1t-online-token.js'
import { checkRateLimit } from './rate-limit.js'
import { recordErrorEvent } from './error-events.js'
import { logError, logInfo, logWarn } from './log'
import {
  judgeUn1tWrite,
  missingPermissions,
  permissionMissingMessage,
  classifyRefusal,
  isKnownBusinessRefusal,
  scrubMessage,
  un1tWriteFailureEvent,
} from './un1t-online-write-judge.js'
import { readUn1tWriteSettings, Un1tSettingsReadError } from './un1t-online-settings.js'
import { beginAttempt, finishAttempt, findDone, ledgerKey } from './un1t-online-write-ledger.js'
import { applyUn1tWriteToMirror } from './un1t-online-mirror-write.js'
import { resolveCustomerBaseUrl } from './tenant-host.js'
import { randomBytes } from 'node:crypto'

const LOG_MODULE = 'un1t-online-write'
const PLATFORM = 'un1t_online'

/** The write side's share of un1t.online's 60 / min (the sync keeps the rest). */
export const UN1T_WRITE_BUDGET = Object.freeze({ max: 30, windowMs: 60_000 })
export const UN1T_PERMISSION_TTL_MS = 5 * 60_000
export const UN1T_WRITE_FAILURE_ROWS_PER_MIN = 5
const MAX_429_RETRIES = 3
// A check read waits out at most this many spent windows, then reads anyway
// (never skipped). A re-send that still finds the budget spent is refused.
const MAX_BUDGET_WAITS = 2

export const UN1T_WRITE_CODES = Object.freeze({
  WRITES_OFF: 'UN1T_WRITES_OFF',
  NOT_CONNECTED: 'UN1T_NOT_CONNECTED',
  STUDIO_MISMATCH: 'UN1T_STUDIO_MISMATCH',
  PERMISSION_MISSING: 'UN1T_PERMISSION_MISSING',
  // The permission read itself failed (5xx, no reply): fail closed, retry later.
  PERMISSIONS_UNREADABLE: 'UN1T_PERMISSIONS_UNREADABLE',
  RATE_BUDGET: 'UN1T_RATE_BUDGET',
  RATE_LIMITED: 'UN1T_RATE_LIMITED',
  ATTEMPT_IN_FLIGHT: 'UN1T_ATTEMPT_IN_FLIGHT',
  AUTH: 'UN1T_AUTH',
  // A cancel whose check read found the class attended or a no-show.
  ALREADY_HAPPENED: 'UN1T_ALREADY_HAPPENED',
  // An unknown book whose refusal said "already booked" in words only, and
  // the check read could not confirm it. Never a done, never a green light.
  ALREADY_BOOKED_UNVERIFIED: 'already_booked_unverified',
})

/** The policy each op runs under (spec 6.1). The caller never chooses it. */
export const UN1T_OP_POLICY = Object.freeze({
  book: 'verify',
  cancel: 'verify',
  create_client: 'verify',
  forgot_password: 'never',
  trial: 'never',
  checkout: 'idempotent',
})

// The policy for `op`; a caller-given one must match. TypeError otherwise.
function policyFor(op, given) {
  const policy = Object.hasOwn(UN1T_OP_POLICY, op) ? UN1T_OP_POLICY[op] : null
  if (!policy) throw new TypeError(`un1t.online write: unknown op '${op}'`)
  if (given !== undefined && given !== policy) {
    throw new TypeError(`un1t.online write: op '${op}' runs under policy '${policy}', not '${given}'`)
  }
  return policy
}
const C = UN1T_WRITE_CODES
const RETRYABLE = new Set([C.RATE_BUDGET, C.RATE_LIMITED, C.ATTEMPT_IN_FLIGHT, C.PERMISSIONS_UNREADABLE])

/** A refusal before or instead of a send. `result` is the Un1tWriteResult to return. */
export class Un1tWriteRefused extends Error {
  constructor(code, message, result = null) {
    super(message)
    this.name = 'Un1tWriteRefused'
    this.code = code
    this.result = result
  }
}

/** createCheckoutLink's rejection when un1t.online's answer is unclear. */
export class Un1tWriteUnknown extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'Un1tWriteUnknown'
    this.code = code
  }
}

// ── The allowlist ──────────────────────────────────────────────────────────
// Method, exact path, the ops that may use it, the body keys it may carry,
// the policies it may run under and whether it needs an idempotency-key.
const ENDPOINTS = Object.freeze([
  { method: 'POST', path: /^\/bookings$/, ops: ['book'], keys: ['eventId', 'userId'] },
  { method: 'PATCH', path: /^\/bookings\/[A-Za-z0-9][A-Za-z0-9_-]*\/cancel$/, ops: ['cancel'], keys: [] },
  {
    method: 'POST', path: /^\/users\/clients$/, ops: ['create_client'],
    keys: ['email', 'password', 'studioId', 'name', 'first_name', 'last_name', 'phone', 'accepted_terms', 'accepted_liability_waiver'],
  },
  { method: 'POST', path: /^\/auth\/forgot-password$/, ops: ['forgot_password'], keys: ['email'] },
  // Inside grantTrial only: a purchase is never re-sent.
  { method: 'POST', path: /^\/purchases\/charge$/, ops: ['trial'], keys: ['userId', 'productId'], needsKey: true },
  {
    method: 'POST', path: /^\/purchases\/checkout$/, ops: ['checkout', 'trial'],
    keys: ['productId', 'successUrl', 'cancelUrl', 'userId'], needsKey: true,
  },
])
const BANNED_BODY_KEYS = Object.freeze(['bypassCredit', 'forceRefund', 'promoCode'])
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/**
 * The endpoint, op and body check, without the policy. Pure; throws
 * TypeError. Exported on the writer so a primitive checks BEFORE it opens a
 * ledger row.
 */
function assertEndpoint(op, method, path, body) {
  const m = String(method || '').toUpperCase()
  const where = `${m} ${String(path)}`
  const ep = ENDPOINTS.find((e) => e.method === m && typeof path === 'string' && e.path.test(path))
  if (!ep) throw new TypeError(`un1t.online write: ${where} is not an allowed endpoint`)
  if (body !== undefined && !isObj(body)) throw new TypeError(`un1t.online write: ${where} body must be an object`)
  const entries = Object.entries(body ?? {})
  const banned = entries.find(([k]) => BANNED_BODY_KEYS.includes(k))
  if (banned) throw new TypeError(`un1t.online write: '${banned[0]}' is never sent`)
  const extra = entries.find(([k]) => !ep.keys.includes(k))
  if (extra) throw new TypeError(`un1t.online write: '${extra[0]}' is not in the ${where} body`)
  // Scalars only: an object or array value is never what the snapshot sends.
  const nested = entries.find(([, v]) => !isScalar(v))
  if (nested) throw new TypeError(`un1t.online write: '${nested[0]}' must be a plain value`)
  if (!ep.ops.includes(op)) throw new TypeError(`un1t.online write: op '${op}' may not call ${where}`)
  return ep
}

function assertAllowed(method, path, { body, policy, idempotencyKey, verify, op }) {
  const where = `${method} ${String(path)}`
  const ep = assertEndpoint(op, method, path, body)
  policyFor(op, policy)
  policy = UN1T_OP_POLICY[op]
  if (policy === 'verify' && typeof verify !== 'function') throw new TypeError(`un1t.online write: policy verify needs a verify()`)
  if (verify !== undefined && typeof verify !== 'function') throw new TypeError('un1t.online write: verify must be a function')
  if ((ep.needsKey || policy === 'idempotent') && !(typeof idempotencyKey === 'string' && idempotencyKey)) {
    throw new TypeError(`un1t.online write: ${where} needs an idempotency-key`)
  }
}

// ── Results ────────────────────────────────────────────────────────────────
function result(verdict, { sent = false, id = null, code = null, message = null, alreadyBooked = false, recovered = null, retryable = false, data = null } = {}) {
  // alreadyBooked is a done-only fact; nothing else may carry it.
  return { verdict, sent, id, code, message, alreadyBooked: verdict === 'done' && alreadyBooked === true, recovered, retryable, data }
}
function refusalResult(code, message, extra = {}) {
  return result('refused', { code, message, retryable: RETRYABLE.has(code), ...extra })
}
const withLedger = (r, ledgerId = null) => ({ ...r, ledgerId })
function withoutLedger(r) {
  const { ledgerId: _ledgerId, ...rest } = r
  return rest
}

// What a done answer may hand back. create_client: only the id (the body
// carries reset_password_token, email and phone). forgot_password: nothing; a
// done reset request does NOT prove an email went out (un1t.online answers the
// same whether or not the address has an account), so no field may promise it.
// checkout: whether it was free, never the URL a second time.
function dataFor(op, body) {
  const data = isObj(body) && isObj(body.data) ? body.data : null
  if (op === 'book' || op === 'cancel') return data ? pickBooking(data) : null
  if (op === 'checkout') return data ? { free: data.free === true } : null
  return null
}

// What the judge, mapBooking and C's class_bookings mapper read from a
// booking, flat or nested, and nothing else: the answer can embed the user
// (email, phone, name) and guest details.
const scalarOr = (v) => (isScalar(v) && v !== '' ? v : null)
function pickBooking(d) {
  const nestedId = (o) => (isObj(o) ? o.id : undefined)
  const out = {
    id: scalarOr(d.id),
    event_id: scalarOr(d.event_id ?? nestedId(d.event)),
    user_id: scalarOr(d.user_id ?? nestedId(d.user)),
    studio_id: scalarOr(d.studio_id ?? nestedId(d.studio)),
    status: scalarOr(d.status),
    created_at: scalarOr(d.created_at),
    updated_at: scalarOr(d.updated_at),
  }
  // The guest FLAG (never the guest's details): the DTO's own flag, flat or
  // camelCase, else whether any guest field is filled (as mapBooking derives
  // it). Dropping it would let a CRM mirror write reset has_guest to false.
  const flag = d.has_guest ?? d.hasGuest
  out.has_guest = typeof flag === 'boolean'
    ? flag
    : ['guest_name', 'guest_email', 'guest_phone'].some((k) => typeof d[k] === 'string' && d[k].trim() !== '')
  // Non-personal scalars mapBooking also stores; only when present.
  for (const k of ['source', 'credit_charged', 'external_member_ref', 'external_booking_ref']) {
    if (d[k] !== undefined && isScalar(d[k])) out[k] = d[k]
  }
  return out
}

// The person's details a refusal can echo. Names are left out on purpose: a
// short first name would redact ordinary words ("Al" in "already").
function piiOf(body) {
  const out = ['email', 'password', 'phone'].map((k) => body?.[k]).filter((v) => typeof v === 'string' && v.length > 0)
  return [...out, ...phoneForms(body?.phone)]
}

// A phone as un1t.online may echo it: digits only, with a +, the last nine
// digits, and the Irish +353 / 0 swap.
export function phoneForms(phone) {
  if (typeof phone !== 'string') return []
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7) return []
  const forms = new Set([digits, `+${digits}`])
  if (digits.length >= 9) forms.add(digits.slice(-9))
  if (digits.startsWith('353')) {
    forms.add(`0${digits.slice(3)}`)
    forms.add(digits.slice(3))
  } else if (digits.startsWith('0')) {
    forms.add(`353${digits.slice(1)}`)
    forms.add(`+353${digits.slice(1)}`)
  }
  return [...forms].filter((f) => f.replace(/\D/g, '').length >= 7)
}

// ── Module state: the permission cache and the error_events cap ────────────
const permissionCache = new Map() // token fingerprint → { atMs, studioId, permissions }
let failWindowStart = 0
let failWindowCount = 0
let failWindowWarned = false

/** Test seam only: the permission cache and the error_events cap are module state. */
export function _resetUn1tWriteStateForTests() {
  permissionCache.clear()
  failWindowStart = 0
  failWindowCount = 0
  failWindowWarned = false
}

function mayRecordFailure(locationId) {
  const t = Date.now()
  if (t - failWindowStart > 60_000) {
    failWindowStart = t
    failWindowCount = 0
    failWindowWarned = false
  }
  if (failWindowCount < UN1T_WRITE_FAILURE_ROWS_PER_MIN) {
    failWindowCount++
    return true
  }
  if (!failWindowWarned) {
    failWindowWarned = true
    logWarn(LOG_MODULE, 'un1t.online write-failure rows capped this minute; further failures are only logged', {
      locationId, code: 'error_events_capped',
    })
  }
  return false
}

async function recordFailure(locationId, args) {
  try {
    if (!mayRecordFailure(locationId)) return
    await recordErrorEvent(un1tWriteFailureEvent(args))
  } catch { /* observability never changes the write's answer */ }
}

// The contract fields only, so a new field cannot leak into a log by accident.
const LOG_FIELDS = ['locationId', 'op', 'origin', 'ledgerId', 'status', 'verdict', 'code', 'recovered', 'attempt', 'waitMs']
function fields(meta) {
  const out = {}
  for (const k of LOG_FIELDS) if (meta[k] !== undefined) out[k] = meta[k]
  return out
}

// 429 wait: the window reset, else Retry-After, else 1s * 2^n.
function throttleWaitMs(headers, n) {
  const reset = resetWaitMs(headers)
  if (reset != null) return reset
  const retryAfter = headerNumber(headers, 'retry-after')
  if (retryAfter != null) return Math.max(0, retryAfter) * 1000
  return 1000 * 2 ** n
}

// A body with nothing in it is null (never ''): the judge reads "no body" as
// a cancel's documented 200. Text that is not JSON is passed as text, which
// the judge never takes as done.
async function readBody(res) {
  const text = await res.text()
  if (text == null || text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// A check read's answer: 'landed' | 'absent' | 'unknown' | 'already_happened',
// or { state, id }. Anything else is unknown.
const CHECK_STATES = new Set(['landed', 'absent', 'unknown', 'already_happened'])
function checkOf(v) {
  if (typeof v === 'string') return { state: CHECK_STATES.has(v) ? v : 'unknown', id: null }
  if (isObj(v) && CHECK_STATES.has(v.state)) {
    const id = typeof v.id === 'string' && v.id.trim() ? v.id.trim() : null
    return { state: v.state, id }
  }
  return { state: 'unknown', id: null }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The write transport for one location.
 *
 * Rejects only with Un1tSettingsReadError (the switch or, with writes on, the
 * connection could not be read); nothing has been sent, so a retry is safe.
 */
export async function createUn1tWriter(
  db,
  locationId,
  { fetchImpl = fetch, sleep = defaultSleep, now = () => new Date(), clientFactory = createUn1tClient } = {},
) {
  if (!locationId) throw new TypeError('createUn1tWriter: locationId is required')
  const { studioName: rawName, settings } = await readUn1tWriteSettings(db, locationId)
  const studioName = rawName || 'this studio'

  let conn = null
  const { conn: c, error: connError } = await readConnection(db, locationId, PLATFORM)
  if (connError) {
    // With writes off the switch answers first; with them on an unreadable
    // connection must not read as "not connected".
    if (settings.writesEnabled) {
      throw new Un1tSettingsReadError(`un1t.online connection read failed (${connError?.code ?? 'no code'})`, { code: 'connection_read_failed' })
    }
  } else if (c && c.source === 'registry' && c.isActive && c.accessToken) {
    conn = c
  }
  const token = conn ? conn.accessToken : null
  const fingerprint = tokenFingerprint(token)
  const studioId = conn?.externalAccountId == null ? null : String(conn.externalAccountId)
  const budgetKey = `un1t-write:${locationId}`
  // > 0 while a write that went out waits on its check read.
  let checkDepth = 0

  const text = {
    [C.WRITES_OFF]: `un1t.online writes are switched off for ${studioName}, so nothing was sent. A master can switch them on in Settings, Integrations, un1t.online.`,
    [C.NOT_CONNECTED]: `${studioName} is not connected to un1t.online, so nothing was sent.`,
    [C.STUDIO_MISMATCH]: `The un1t.online token for ${studioName} belongs to a different studio, so nothing was sent. Paste this studio's token in Settings, Integrations, un1t.online.`,
    [C.PERMISSIONS_UNREADABLE]: `un1t.online did not answer the permission check for ${studioName}, so nothing was sent. Try again in a minute.`,
    [C.RATE_BUDGET]: `un1t.online is busy for ${studioName} right now, so nothing was sent. Try again in a minute.`,
    [C.RATE_LIMITED]: `un1t.online kept asking the CRM to slow down, so it was not done. Try again in a minute.`,
    [C.ATTEMPT_IN_FLIGHT]: 'Another attempt at this is still running, so nothing was sent. Try again in a few minutes.',
    [C.AUTH]: `un1t.online refused the token for ${studioName}, so nothing more was sent. Issue a new token and paste it in Settings, Integrations, un1t.online.`,
    [C.ALREADY_HAPPENED]: 'This class has already happened in un1t.online (attended or a no-show), so the booking was not cancelled.',
  }
  const refuse = (code, message = text[code], extra) => {
    const r = withLedger(refusalResult(code, message, extra))
    return new Un1tWriteRefused(code, message, r)
  }

  // One slot of the shared budget. wait=false: a spent slot is refused.
  // wait=true: wait for the window; after MAX_BUDGET_WAITS a read goes ahead
  // anyway (proceed) and a write is refused.
  async function takeSlot({ wait, proceed }) {
    for (let waits = 0; ; waits++) {
      const slot = await checkRateLimit(db, budgetKey, UN1T_WRITE_BUDGET)
      if (slot.allowed) return true
      if (!wait) return false
      if (waits >= MAX_BUDGET_WAITS) {
        logWarn(LOG_MODULE, 'write budget still spent after waiting', { locationId, code: C.RATE_BUDGET, verdict: proceed ? 'read_anyway' : 'refused' })
        return proceed
      }
      const waitMs = Math.min(UN1T_WRITE_BUDGET.windowMs, Math.max(1, slot.retryAfterSec) * 1000)
      logInfo(LOG_MODULE, 'write budget spent; waiting for the window', { locationId, code: C.RATE_BUDGET, waitMs })
      await sleep(waitMs)
    }
  }

  const readClient = conn
    ? clientFactory({
      token,
      fetchImpl,
      sleep,
      beforeRequest: async () => {
        if (!(await takeSlot({ wait: checkDepth > 0, proceed: true }))) throw refuse(C.RATE_BUDGET)
      },
    })
    : null

  function requireConnected() {
    if (!conn) throw refuse(C.NOT_CONNECTED)
  }

  function dropPermissions() {
    if (fingerprint) permissionCache.delete(fingerprint)
  }

  // GET /api-token through the cache.
  async function tokenSelf() {
    const t = now().getTime()
    const hit = permissionCache.get(fingerprint)
    if (hit && t >= hit.atMs && t - hit.atMs < UN1T_PERMISSION_TTL_MS) return hit
    let self
    try {
      self = await readClient.getSelf()
    } catch (err) {
      if (err instanceof Un1tWriteRefused) throw err
      if (err instanceof Un1tAuthError) {
        dropPermissions()
        logWarn(LOG_MODULE, 'un1t.online refused the token at the permission check', { locationId, status: err.status ?? null, code: C.AUTH })
        throw refuse(C.AUTH)
      }
      logWarn(LOG_MODULE, 'un1t.online permission check failed', { locationId, status: err?.status ?? null, code: C.PERMISSIONS_UNREADABLE })
      throw refuse(C.PERMISSIONS_UNREADABLE)
    }
    const entry = {
      atMs: t,
      studioId: self?.studio?.id == null ? null : String(self.studio.id),
      permissions: Array.isArray(self?.permissions) ? self.permissions.filter((p) => typeof p === 'string') : [],
    }
    permissionCache.set(fingerprint, entry)
    return entry
  }

  /** Writes on, then the token's studio, then the op's permissions. Throws Un1tWriteRefused. */
  async function ensureOp(op) {
    missingPermissions(op, []) // TypeError on an op the judge does not know
    if (!settings.writesEnabled) throw refuse(C.WRITES_OFF)
    requireConnected()
    const self = await tokenSelf()
    if (!studioId || self.studioId !== studioId) {
      logWarn(LOG_MODULE, 'un1t.online token is for another studio', { locationId, op, code: C.STUDIO_MISMATCH })
      throw refuse(C.STUDIO_MISMATCH)
    }
    const missing = missingPermissions(op, self.permissions)
    if (missing.length > 0) {
      logWarn(LOG_MODULE, 'un1t.online token lacks a write permission', { locationId, op, code: C.PERMISSION_MISSING })
      throw refuse(C.PERMISSION_MISSING, permissionMissingMessage(studioName, missing[0]))
    }
  }

  // A check read: one call, with the budget waited for, never throwing.
  async function runCheck(fn, meta) {
    checkDepth++
    try {
      return checkOf(await fn())
    } catch (err) {
      logWarn(LOG_MODULE, 'write check read failed; treated as unknown', fields({ ...meta, code: err?.code ?? 'check_failed' }))
      return { state: 'unknown', id: null }
    } finally {
      checkDepth--
    }
  }

  /**
   * One write, judged under its policy. Resolves a Un1tWriteResult without
   * ledgerId; rejects only with a TypeError for a call off the allowlist.
   */
  async function send(method, path, opts = {}) {
    const { body, idempotencyKey, verify, op, expect, secrets = [], origin, ledgerId } = opts
    const m = String(method || '').toUpperCase()
    assertAllowed(m, path, { body, policy: opts.policy, idempotencyKey, verify, op })
    const policy = UN1T_OP_POLICY[op]
    try {
      await ensureOp(op)
    } catch (err) {
      if (err instanceof Un1tWriteRefused && err.result) return withoutLedger(err.result)
      throw err
    }

    const meta = { locationId, op, origin: origin ?? undefined, ledgerId: ledgerId ?? undefined }
    const scrubList = [token, ...piiOf(body), ...(Array.isArray(secrets) ? secrets : [])]
    const scrub = (s) => (s == null ? null : scrubMessage(s, scrubList) || null)
    const url = `${DEFAULT_BASE_URL}${path}`
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    const payload = JSON.stringify(body ?? {})

    // sent = a write in this call reached un1t.online past the throttle and
    // the token check, so it may have been acted on.
    let sent = false
    let attempt = 0
    let throttles = 0

    const fail = (reason, status) => recordFailure(locationId, { method: m, path, status: status ?? null, reason, attempts: attempt })

    // One request, 429s waited out. → { final } | { status, body } | { noReply } | { unreadable, status }
    async function request() {
      for (;;) {
        if (!(await takeSlot({ wait: sent, proceed: false }))) {
          logWarn(LOG_MODULE, 'write budget spent; not sent', fields({ ...meta, code: C.RATE_BUDGET, attempt }))
          return { final: refusalResult(C.RATE_BUDGET, text[C.RATE_BUDGET], { sent }) }
        }
        attempt++
        let res
        try {
          res = await fetchImpl(url, { method: m, headers, body: payload })
        } catch {
          sent = true
          logWarn(LOG_MODULE, 'no reply from un1t.online', fields({ ...meta, attempt, code: 'no_reply' }))
          return { noReply: true }
        }
        const status = res.status
        if (status === 429) {
          const waitMs = throttleWaitMs(res.headers, throttles)
          if (throttles < MAX_429_RETRIES && waitMs <= MAX_WAIT_MS) {
            throttles++
            logWarn(LOG_MODULE, 'un1t.online throttled the write; waiting', fields({ ...meta, status, attempt, waitMs }))
            await sleep(waitMs)
            continue
          }
          logWarn(LOG_MODULE, 'un1t.online still throttling after every retry', fields({ ...meta, status, attempt, code: C.RATE_LIMITED }))
          await fail('429', status)
          return { final: refusalResult(C.RATE_LIMITED, text[C.RATE_LIMITED], { sent }) }
        }
        if (status === 401 || status === 403) {
          dropPermissions()
          logWarn(LOG_MODULE, 'un1t.online refused the token', fields({ ...meta, status, attempt, code: C.AUTH }))
          await fail('auth', status)
          return { final: refusalResult(C.AUTH, text[C.AUTH], { sent }) }
        }
        sent = true
        try {
          return { status, body: await readBody(res) }
        } catch {
          return { unreadable: true, status }
        }
      }
    }

    // What one answer means. reason is set only on an unclear one.
    function judge(a) {
      if (a.noReply) return { verdict: 'unknown', reason: 'no_reply', status: null, code: null, message: null, alreadyBooked: false }
      if (a.unreadable) return { verdict: 'unknown', reason: 'unclear', status: a.status, code: null, message: null, alreadyBooked: false }
      const j = judgeUn1tWrite(op, { status: a.status, body: a.body, expect })
      return { ...j, status: a.status, body: a.body, reason: j.verdict === 'unknown' ? (a.status >= 500 ? '5xx' : 'unclear') : null }
    }

    function finish(r, extra = {}) {
      const line = fields({ ...meta, verdict: r.verdict, code: r.code, recovered: r.recovered, attempt, ...extra })
      if (r.verdict === 'done') {
        if (attempt > 1 || r.recovered) logInfo(LOG_MODULE, 'un1t.online write done', line)
      } else {
        logWarn(LOG_MODULE, `un1t.online write ${r.verdict}`, line)
      }
      return r
    }

    async function settled(j) {
      if (j.verdict === 'done') {
        return finish(result('done', {
          sent, id: j.id, code: j.code, message: scrub(j.message), alreadyBooked: j.alreadyBooked,
          data: j.alreadyBooked ? null : dataFor(op, j.body),
        }), { status: j.status })
      }
      // refused
      if (!isKnownBusinessRefusal(classifyRefusal({ code: j.code, message: j.message }))) await fail('refused', j.status)
      return finish(result('refused', { sent, code: j.code, message: scrub(j.message) }), { status: j.status })
    }

    // An unknown never says alreadyBooked: an unconfirmed hint is a code.
    async function unknown(j, { hint = false } = {}) {
      await fail(j.reason, j.status)
      const code = hint ? C.ALREADY_BOOKED_UNVERIFIED : j.code
      return finish(result('unknown', { sent, code, message: scrub(j.message) }), { status: j.status ?? undefined })
    }

    const first = await request()
    if (first.final) return finish(first.final)
    const j1 = judge(first)
    if (j1.verdict !== 'unknown') return settled(j1)

    // "already booked" from words alone: the check read settles it; the
    // hint is never a reason to send again.
    if (j1.alreadyBooked) {
      if (!verify) return unknown(j1, { hint: true })
      const chk = await runCheck(verify, meta)
      if (chk.state === 'landed') {
        return finish(result('done', { sent, id: chk.id, code: j1.code, message: scrub(j1.message), alreadyBooked: true }))
      }
      // absent disproves the hint (un1t.online's own code stands); unknown
      // leaves it unconfirmed.
      return unknown(j1, { hint: chk.state !== 'absent' })
    }

    let j = j1
    if (policy === 'idempotent') {
      // The same idempotency-key makes the second request the same session.
      const second = await request()
      if (second.final) return finish(second.final)
      j = judge(second)
      return j.verdict === 'unknown' ? unknown(j) : settled(j)
    }

    if (!verify) return unknown(j)
    const chk = await runCheck(verify, meta)
    if (chk.state === 'landed') {
      const id = chk.id ?? (op === 'cancel' ? (expect?.bookingId ?? null) : null)
      return finish(result('done', { sent, id, recovered: 'landed_after_5xx' }))
    }
    if (chk.state === 'already_happened') {
      return finish(result('refused', { sent, code: C.ALREADY_HAPPENED, message: text[C.ALREADY_HAPPENED] }))
    }
    if (chk.state !== 'absent' || policy === 'never') return unknown(j)

    // Absent: send once more, judged once more, never checked again.
    const second = await request()
    if (second.final) return finish(second.final)
    j = judge(second)
    return j.verdict === 'unknown' ? unknown(j) : settled(j)
  }

  /** One GET through the read client (budget slot per request). */
  async function read(path) {
    requireConnected()
    try {
      return await readClient.getOne(path)
    } catch (err) {
      if (err instanceof Un1tAuthError) dropPermissions()
      throw err
    }
  }

  /** Every page of a list; a walk cut short by the page cap throws. */
  async function readAll(path) {
    requireConnected()
    let out
    try {
      out = await readClient.listAll(path)
    } catch (err) {
      if (err instanceof Un1tAuthError) dropPermissions()
      throw err
    }
    if (out.truncated) throw new Un1tApiError('un1t.online list walk was cut short by the page cap', { code: 'truncated' })
    return out.rows
  }

  /**
   * The ledger seam every primitive opens an attempt through (Task 6).
   * → { row } (send now; `resumed` when an idempotent op adopts its open row)
   * | { result } (a Un1tWriteResult with ledgerId; nothing sent).
   * Rejects only with a ledger database error raised before anything was sent.
   *
   * - open_row_gone (the open row finished while we looked) is a retry:
   *   UN1T_ATTEMPT_IN_FLIGHT, retryable. The retry's own done-check sees it.
   * - an open row under UN1T_IN_FLIGHT_MS: UN1T_ATTEMPT_IN_FLIGHT.
   * - an older open row still holds the one-open index, so it is finished
   *   first, from the op's check read: landed → done (no send); absent → the
   *   old row is closed and a fresh one inserted; already happened →
   *   refused; unknown, or a never op → unknown.
   */
  async function openAttempt(attempt, { policy: given, verify } = {}) {
    // The op's policy, never the caller's: a trial opened as 'idempotent'
    // would adopt a stale purchase row and be told to send it again.
    const policy = policyFor(attempt?.op, given)
    const args = { ...attempt, locationId }
    const meta = { locationId, op: attempt?.op, origin: attempt?.origin }

    const begin = async () => {
      try {
        return await beginAttempt(db, args)
      } catch (err) {
        if (err?.code === 'open_row_gone') {
          logInfo(LOG_MODULE, 'the open attempt finished while it was read; retry', fields({ ...meta, code: 'open_row_gone' }))
          return { gone: true }
        }
        throw err
      }
    }
    const inFlight = (ledgerId) => ({ result: withLedger(refusalResult(C.ATTEMPT_IN_FLIGHT, text[C.ATTEMPT_IN_FLIGHT]), ledgerId) })

    const first = await begin()
    if (first.gone) return inFlight(null)
    if (first.row) return { row: first.row }
    const { open } = first
    if (first.inFlight) return inFlight(open.id)

    const stale = { ...meta, ledgerId: open.id }
    if (policy === 'idempotent') {
      logInfo(LOG_MODULE, 'resuming an open attempt with its own key', fields({ ...stale, code: 'resumed' }))
      return { row: open, resumed: true }
    }
    const inDoubt = async () => {
      if (open.stage === 'sent') await finishAttempt(db, open.id, { stage: 'unknown', code: 'stale_attempt' })
      logWarn(LOG_MODULE, 'an earlier attempt is still in doubt; not sent', fields({ ...stale, verdict: 'unknown' }))
      return { result: withLedger(result('unknown'), open.id) }
    }
    if (typeof verify !== 'function') return inDoubt()

    // A check read that cannot run (no connection, budget) is unknown, never a throw.
    const chk = await runCheck(verify, stale)
    if (chk.state === 'landed') {
      await finishAttempt(db, open.id, { stage: 'done', un1tRef: chk.id, recovered: 'landed_on_resume' })
      logInfo(LOG_MODULE, 'an earlier attempt had landed', fields({ ...stale, verdict: 'done', recovered: 'landed_on_resume' }))
      return { result: withLedger(result('done', { id: chk.id, recovered: 'landed_on_resume' }), open.id) }
    }
    if (chk.state === 'already_happened') {
      await finishAttempt(db, open.id, { stage: 'refused', code: C.ALREADY_HAPPENED, message: text[C.ALREADY_HAPPENED] })
      return { result: withLedger(result('refused', { code: C.ALREADY_HAPPENED, message: text[C.ALREADY_HAPPENED] }), open.id) }
    }
    if (chk.state !== 'absent' || policy === 'never') return inDoubt()

    await finishAttempt(db, open.id, { stage: 'refused', code: 'not_landed', message: 'The check read found the earlier attempt did not go through.' })
    logInfo(LOG_MODULE, 'an earlier attempt never landed; starting afresh', fields({ ...stale, code: 'not_landed' }))
    const again = await begin()
    if (again.gone) return inFlight(null)
    if (again.row) return { row: again.row }
    return inFlight(again.open.id)
  }

  return {
    locationId,
    studioId,
    studioName,
    ensureOp,
    assertAllowed: (op, method, path, body) => {
      assertEndpoint(op, method, path, body)
    },
    send,
    read,
    readAll,
    openAttempt,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// UN1TWRITE.6 — the primitives
// ════════════════════════════════════════════════════════════════════════════
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
const UNKNOWN_CHECKOUT_TEXT = 'un1t.online did not answer clearly, so no checkout link can be given. Try again in a minute.'

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
 * anything else, another booking or a failed read → unknown. Never throws.
 * @returns {Promise<'landed'|'absent'|'already_happened'|'unknown'>}
 */
export async function findCancelState(writer, { bookingId } = {}) {
  let row
  try {
    row = await writer.read(`/bookings/${encodeURIComponent(bookingId)}`)
  } catch (err) {
    logWarn(LOG_MODULE, 'cancel check read failed; treated as unknown', fields({ locationId: writer.locationId, op: 'cancel', code: err?.code ?? 'check_failed' }))
    return 'unknown'
  }
  if (!isObj(row) || (row.id != null && !sameIdText(row.id, bookingId))) return 'unknown'
  const s = statusOf(row)
  if (isCancelledStatus(s)) return 'landed'
  if (s === 'booked') return 'absent'
  if (s === 'attended' || s === 'no_show' || s === 'no-show') return 'already_happened'
  return 'unknown'
}

/**
 * Every un1t.online client whose email is this one: a full walk of
 * `GET /users/clients` (no search parameter exists, so the address never goes
 * in a URL), compared trimmed, lower-cased and exact. Throws when the walk
 * fails or is cut short: "could not look" is never "no match".
 * @returns {Promise<{ matches: string[] }>}
 */
export async function findClientByEmail(writer, email) {
  const want = normEmail(email)
  if (!want) throw new TypeError('findClientByEmail: email is required')
  const rows = await writer.readAll('/users/clients')
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
 * other (mig 742 one_trial is per person and product). null when none.
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
 * returns fields to merge into a done result (data, conflict).
 */
async function attemptWrite(db, writer, { attempt, policy, verify, send, secrets = [], onDone }) {
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

  // The check read names the booking, so a resume reports its id too.
  const verify = async () => {
    const state = await findCancelState(writer, { bookingId })
    return state === 'landed' ? { state, id: bookingId } : state
  }
  let requestedAt = null
  return attemptWrite(db, writer, {
    attempt: { op: 'cancel', key, contactId, un1tUserId, target: bookingId, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'verify',
    verify,
    send: (row) => {
      requestedAt = now().toISOString()
      return writer.send('PATCH', `/bookings/${bookingId}/cancel`, {
        body: {}, policy: 'verify', verify, op: 'cancel', origin, ledgerId: row.id, expect: { bookingId },
      })
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

  const key = ledgerKey.create(locationId, contact.id)
  const prior = await findDone(db, { key })
  if (prior) return { ...withLedger(result('done', { id: idText(prior.un1t_ref) }), prior.id), conflict: null }

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

  const verify = async () => {
    const { matches } = await findClientByEmail(writer, email)
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
    onDone: async (done) => {
      if (!done.id) return {}
      const m = await applyUn1tWriteToMirror(db, {
        op: 'create_client', locationId, contactId: contact.id, un1tUserId: done.id, studioId: writer.studioId,
        data: null, requestedAt, ledgerId: done.ledgerId,
      }, mirrorDeps(writer, now))
      return { conflict: m.conflict ?? null }
    },
  })
  return { conflict: null, ...r, data: null }
}

// ── forgotPassword ─────────────────────────────────────────────────────────

/**
 * Ask un1t.online to email this client a set-password code. Never re-sent (a
 * second request is a second email): a 5xx or no reply is unknown after one
 * request, and a done reset for this user on the ledger sends nothing. A done
 * here does NOT prove an email went out; no copy may promise it.
 * @param {{ locationId: string, contactId?: string|null, un1tUserId: string, email: string,
 *   origin: string, originRef?: string|null, actor?: { id: string }|null }} args
 */
export async function forgotPassword(db, args = {}, deps = {}) {
  const { writerFactory = createUn1tWriter } = deps
  const { locationId, contactId = null, un1tUserId, email: rawEmail, origin, originRef = null, actor = null } = args
  requireBareId('forgotPassword', 'un1tUserId', un1tUserId)
  const email = plainText(rawEmail)
  if (!email) throw new TypeError("forgotPassword: 'email' is required")
  const writer = await writerFactory(db, locationId)
  const refused = await opRefusal(writer, 'forgot_password')
  if (refused) return refused
  const body = { email }
  writer.assertAllowed('forgot_password', 'POST', '/auth/forgot-password', body)

  const key = ledgerKey.pw(locationId, un1tUserId)
  const prior = await findDone(db, { key })
  if (prior) return withLedger(result('done'), prior.id)

  return attemptWrite(db, writer, {
    attempt: { op: 'forgot_password', key, contactId, un1tUserId, target: null, origin, originRef, actorUserId: actorIdOf(actor) },
    policy: 'never',
    secrets: [email],
    send: (row) => writer.send('POST', '/auth/forgot-password', {
      body, policy: 'never', op: 'forgot_password', origin, ledgerId: row.id, secrets: [email], expect: {},
    }),
  })
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

async function customerHost(db, locationId) {
  try {
    return new URL(await resolveCustomerBaseUrl(db, locationId)).host.toLowerCase()
  } catch {
    return null
  }
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
    return { checkoutUrl: r.id, free }
  }
  if (r.verdict === 'refused') throw new Un1tWriteRefused(r.code, r.message ?? 'un1t.online refused the checkout.', r)
  const err = new Un1tWriteUnknown(r.code ?? 'outcome_unknown', r.message ?? UNKNOWN_CHECKOUT_TEXT)
  err.ledgerId = r.ledgerId
  throw err
}
