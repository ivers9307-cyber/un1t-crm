// UN1TWRITE.5 — the un1t.online write transport (createUn1tWriter).
// The primitives (book, cancel, createClient, forgotPassword,
// createCheckoutLink, grantTrial) arrive in Tasks 6 and 10 and call ONLY this.
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
//   scrubbed of the token and the person's email, password and phone.

import { createUn1tClient, Un1tAuthError, Un1tApiError, resetWaitMs, headerNumber, MAX_WAIT_MS, DEFAULT_BASE_URL } from './un1t-online.js'
import { readConnection } from './connection-registry.js'
import { tokenFingerprint } from './un1t-online-token.js'
import { checkRateLimit } from './rate-limit.js'
import { recordErrorEvent } from './error-events.js'
import { logInfo, logWarn } from './log'
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
import { beginAttempt, finishAttempt } from './un1t-online-write-ledger.js'

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
})
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
  { method: 'POST', path: /^\/bookings$/, ops: { book: ['verify'] }, keys: ['eventId', 'userId'] },
  { method: 'PATCH', path: /^\/bookings\/[A-Za-z0-9][A-Za-z0-9_-]*\/cancel$/, ops: { cancel: ['verify'] }, keys: [] },
  {
    method: 'POST', path: /^\/users\/clients$/, ops: { create_client: ['verify'] },
    keys: ['email', 'password', 'studioId', 'name', 'first_name', 'last_name', 'phone', 'accepted_terms', 'accepted_liability_waiver'],
  },
  { method: 'POST', path: /^\/auth\/forgot-password$/, ops: { forgot_password: ['never'] }, keys: ['email'] },
  // Inside grantTrial only: a purchase is never re-sent.
  { method: 'POST', path: /^\/purchases\/charge$/, ops: { trial: ['never'] }, keys: ['userId', 'productId'], needsKey: true },
  {
    method: 'POST', path: /^\/purchases\/checkout$/, ops: { checkout: ['idempotent'], trial: ['never'] },
    keys: ['productId', 'successUrl', 'cancelUrl', 'userId'], needsKey: true,
  },
])
const BANNED_BODY_KEYS = Object.freeze(['bypassCredit', 'forceRefund', 'promoCode'])
const POLICIES = new Set(['verify', 'never', 'idempotent'])
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function assertAllowed(method, path, { body, policy, idempotencyKey, verify, op }) {
  const where = `${method} ${String(path)}`
  const ep = ENDPOINTS.find((e) => e.method === method && typeof path === 'string' && e.path.test(path))
  if (!ep) throw new TypeError(`un1t.online write: ${where} is not an allowed endpoint`)
  if (body !== undefined && !isObj(body)) throw new TypeError(`un1t.online write: ${where} body must be an object`)
  const keys = Object.keys(body ?? {})
  const banned = keys.find((k) => BANNED_BODY_KEYS.includes(k))
  if (banned) throw new TypeError(`un1t.online write: '${banned}' is never sent`)
  const extra = keys.find((k) => !ep.keys.includes(k))
  if (extra) throw new TypeError(`un1t.online write: '${extra}' is not in the ${where} body`)
  const policies = ep.ops[op]
  if (!policies) throw new TypeError(`un1t.online write: op '${op}' may not call ${where}`)
  if (!POLICIES.has(policy) || !policies.includes(policy)) {
    throw new TypeError(`un1t.online write: ${where} for '${op}' must use policy ${policies.join('|')}`)
  }
  if (policy === 'verify' && typeof verify !== 'function') throw new TypeError(`un1t.online write: policy verify needs a verify()`)
  if (verify !== undefined && typeof verify !== 'function') throw new TypeError('un1t.online write: verify must be a function')
  if ((ep.needsKey || policy === 'idempotent') && !(typeof idempotencyKey === 'string' && idempotencyKey)) {
    throw new TypeError(`un1t.online write: ${where} needs an idempotency-key`)
  }
}

// ── Results ────────────────────────────────────────────────────────────────
function result(verdict, { sent = false, id = null, code = null, message = null, alreadyBooked = false, recovered = null, retryable = false, data = null } = {}) {
  return { verdict, sent, id, code, message, alreadyBooked, recovered, retryable, data }
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
  if (op === 'book' || op === 'cancel') return data
  if (op === 'checkout') return data ? { free: data.free === true } : null
  return null
}

// The person's details a refusal can echo. Names are left out on purpose: a
// short first name would redact ordinary words ("Al" in "already").
function piiOf(body) {
  return ['email', 'password', 'phone'].map((k) => body?.[k]).filter((v) => typeof v === 'string' && v.length > 0)
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
    const { body, policy, idempotencyKey, verify, op, expect, secrets = [], origin, ledgerId } = opts
    const m = String(method || '').toUpperCase()
    assertAllowed(m, path, { body, policy, idempotencyKey, verify, op })
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

    async function unknown(j, { alreadyBooked = false } = {}) {
      await fail(j.reason, j.status)
      return finish(result('unknown', { sent, code: j.code, message: scrub(j.message), alreadyBooked }), { status: j.status ?? undefined })
    }

    const first = await request()
    if (first.final) return finish(first.final)
    const j1 = judge(first)
    if (j1.verdict !== 'unknown') return settled(j1)

    // "already booked" from words alone: the check read settles it; the
    // hint is never a reason to send again.
    if (j1.alreadyBooked) {
      if (!verify) return unknown(j1, { alreadyBooked: true })
      const chk = await runCheck(verify, meta)
      if (chk.state === 'landed') {
        return finish(result('done', { sent, id: chk.id, code: j1.code, message: scrub(j1.message), alreadyBooked: true }))
      }
      return unknown(j1, { alreadyBooked: chk.state === 'unknown' })
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
      return finish(result('refused', { sent, code: 'already_happened' }))
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
  async function openAttempt(attempt, { policy, verify } = {}) {
    if (!POLICIES.has(policy)) throw new TypeError(`openAttempt: unknown policy '${policy}'`)
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
      await finishAttempt(db, open.id, { stage: 'refused', code: 'already_happened' })
      return { result: withLedger(result('refused', { code: 'already_happened' }), open.id) }
    }
    if (chk.state !== 'absent' || policy === 'never') return inDoubt()

    await finishAttempt(db, open.id, { stage: 'refused', code: 'not_landed', message: 'The check read found the earlier attempt did not go through.' })
    logInfo(LOG_MODULE, 'an earlier attempt never landed; starting afresh', fields({ ...stale, code: 'not_landed' }))
    const again = await begin()
    if (again.gone) return inFlight(null)
    if (again.row) return { row: again.row }
    return inFlight(again.open.id)
  }

  return { locationId, studioId, studioName, ensureOp, send, read, readAll, openAttempt }
}
