// SHELLY.3 — Shelly Cloud Control API client. Never throws; every result is
// tagged.
//
// SECRET RULE: the auth key rides in the v2 QUERY STRING and in the v1 form
// BODY (that is Shelly's API, not a choice). So nothing here ever logs a URL
// or a request body, and no result carries either. Results do pass the
// RESPONSE `body` through verbatim, so callers must not log a result body
// either — put errors through redactSecret first, which strips the raw AND
// the percent-encoded form of the key.
//
// Rate limit is 1 request/second PER ACCOUNT. Pacing and the single 429
// retry live in one place here so the cron and the staff routes cannot
// disagree. Same-account studios share one budget — the reconcile
// serialises them (see reconcile.js); this client only paces itself.
//
// The pacing contract is END-to-start: lastCallAt is stamped when the
// response arrives, so the gap is measured from the end of one request to
// the start of the next. That is deliberately conservative (it can never
// under-shoot the limit) but the caller pays for it: roughly
// minGapMs + latency per call, so a 10-batch read at 800 ms latency is
// about 18 s. Size cron batches with that number in mind.
//
// The queue has NO deadline — a job waits as long as the jobs ahead of it
// take. Bounding the total is the caller's job (a route should cap how many
// commands it enqueues; the cron owns its own runtime budget).

import { createHash } from 'node:crypto'

export const REQUEST_TIMEOUT_MS = 8000
export const MIN_GAP_MS = 1000
export const RETRY_429_AFTER_MS = 1100
// Shelly's documented ceiling for one `get`. Exported so batching callers
// size their chunks from the client rather than hardcoding a 10.
export const MAX_GET_IDS = 10
const USER_AGENT = 'un1t-crm/1.0 (+https://crm.repset.ie)'
const HOST_RE = /^shelly-[a-z0-9-]+\.shelly\.cloud$/

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The ONE sentence that tells an operator what an account server looks like.
// EXPORTED because normaliseShellyHost is not the only place a bad host is
// answered: createShellyClient re-validates and reports `kind:'config'`
// without a message, so the connection route has to answer that branch too.
// A second, re-typed copy there is the kind that drifts the day someone
// improves one of the two, and the operator would then get different words
// depending on which branch caught the same mistake.
export const SHELLY_HOST_HELP =
  'Enter your account server from the Shelly app, e.g. shelly-<region>.shelly.cloud'

// Operator-supplied and server-fetched: an SSRF surface. Hostname only,
// lowercased, and it must be an account server. Accepts a pasted URL.
export function normaliseShellyHost(input) {
  let s = String(input ?? '').trim().toLowerCase()
  if (!s) return { ok: false, error: SHELLY_HOST_HELP }
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s
  let host
  try { host = new URL(s).hostname } catch { return { ok: false, error: SHELLY_HOST_HELP } }
  if (!HOST_RE.test(host)) return { ok: false, error: SHELLY_HOST_HELP }
  return { ok: true, host }
}

// '' for a blank key, never a digest. Callers reject blank keys before they
// get here; a sha256 of '' is a real-looking 64-hex string that would sail
// through a "do these two connections share a key" comparison and make two
// unconfigured rows look identical.
export function fingerprintAuthKey(key) {
  const s = key === undefined || key === null ? '' : String(key)
  if (!s) return ''
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function redactSecret(err, secret) {
  const name = err?.name || 'Error'
  let message = String(err?.message ?? err ?? '')
  const raw = secret === undefined || secret === null ? '' : String(secret)
  if (raw) {
    // EVERY form the key leaves this module in, because raw-only redaction
    // leaks a base64-ish key whole: one containing + / = never appears raw
    // in a URL-bearing message. The v2 query string uses encodeURIComponent
    // and the v1 body uses form-encoding, which are NOT the same function —
    // they differ on space and on ~!'() — so both are listed. The Set folds
    // them together for the common key, where they are identical.
    const formEncoded = new URLSearchParams([['k', raw]]).toString().slice(2)
    for (const form of new Set([raw, encodeURIComponent(raw), formEncoded])) {
      if (form) message = message.split(form).join('[redacted]')
    }
  }
  return { name, message }
}

export function classifyV2(statusCode, body) {
  if (statusCode === 401 || statusCode === 403) return 'auth'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode === 0) return 'network'
  if (statusCode >= 200 && statusCode < 300) {
    if (body && typeof body.error === 'string' && /UNAUTHORI[SZ]ED|INVALID_TOKEN/i.test(body.error)) return 'auth'
    return 'ok'
  }
  return 'http'
}

export function classifyV1(statusCode, body) {
  if (statusCode === 401 || statusCode === 403) return 'auth'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode === 0) return 'network'
  if (statusCode >= 200 && statusCode < 300) {
    if (body && body.isok === false) {
      return body.errors && Object.prototype.hasOwnProperty.call(body.errors, 'invalid_token') ? 'auth' : 'http'
    }
    return 'ok'
  }
  return 'http'
}

// `{ failed: {} }` means "the account answered and named no failures";
// `{ failed: null }` means "it answered in a shape we cannot read". They must
// stay distinct: folding an unreadable shape into an empty map reports every
// command in the batch as landed, and the reconcile then stamps last_applied
// for relays that may never have moved — an optimistic stamp costs the whole
// window (reconcile.js header rule 3). An ARRAY is unparseable too, not just a
// scalar: spreading ['a_0'] yields { 0: 'a_0' }, which matches no group id and
// so reads as all-ok. An absent or null failedCommands stays all-ok — that is
// the documented success body.
export function parseGroupsResult(body) {
  const fc = body && typeof body === 'object' ? body.failedCommands : undefined
  if (fc === undefined || fc === null) return { failed: {} }
  if (typeof fc !== 'object' || Array.isArray(fc)) return { failed: null }
  return { failed: { ...fc } }
}

// Keep the retry flag attached when a method rewrites a result into a
// different tag, so "did this cost two requests" survives the rewrite.
const withRetried = (out, res) => (res && res.retried ? { ...out, retried: true } : out)

// SHELLYERR.1 — Shelly's error vocabulary, from Communication v2.0-beta.
//
// THE DOCUMENTED SHAPE IS NON-2xx. A single-device command failure answers
// 400 DEVICE_OFFLINE / DEVICE_INVALID_CHANNEL / BAD_REQUEST …, 404
// DEVICE_NOT_FOUND / INSTANCE_NOT_FOUND or 500 UNEXPECTED_SUBSERVICE_ERROR,
// each with an `{ error }` body. Until SHELLYERR.1 this file read `error` only
// on a 2xx, so the documented shape arrived as an anonymous `kind:'http'`: an
// offline plug told the operator "Shelly cloud is not answering", and its code
// never reached a log line. Prod has never recorded which shape it really
// sends (no failure has been logged with a status), so BOTH are read the same.
//
// PERMANENT means waiting cannot fix it: the request itself is wrong for this
// device. The cron still re-plans it every tick (an unstamped command is
// retried by design), so the flag is for what the operator is TOLD — never
// "it will follow when it is back online" for a plug that never will.
export const SHELLY_PERMANENT_CODES = new Set([
  'BAD_REQUEST', 'DEVICE_INVALID_CHANNEL', 'DEVICE_INVALID_MODE', 'DEVICE_NOT_FOUND', 'DEVICE_UNSUPPORTED_COMMAND',
])
// The two codes the docs pin on Shelly's own servers ("problem with the server
// handling the device", "internal subservice failure"). They are the cloud, not
// the plug, so they keep the cloud's tag — 'http' — and its copy.
const SHELLY_SIDE_CODES = new Set(['INSTANCE_NOT_FOUND', 'UNEXPECTED_SUBSERVICE_ERROR'])
// A code comes out of a response body, and callers log it; a body is never
// logged whole, so neither is an unbounded string out of one.
const CODE_MAX = 64

function errorCodeOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return typeof body.error === 'string' ? body.error.slice(0, CODE_MAX) : null
}

// The set/ endpoints' failure rewrite, for a 2xx AND a non-2xx error body.
// null = "not an error body; pass the result through". auth, rate_limited,
// network and config keep their own tags whatever the body says: those are
// facts about the key, the budget or the host, and the reconcile's brakes key
// off them.
function commandFailure(res) {
  if (!res || (!res.ok && res.kind !== 'http')) return null
  const code = errorCodeOf(res.body)
  if (code === null) return null
  return withRetried({
    ok: false,
    kind: SHELLY_SIDE_CODES.has(code) ? 'http' : 'device',
    code,
    statusCode: res.statusCode,
    permanent: SHELLY_PERMANENT_CODES.has(code),
  }, res)
}

// SHELLYTIMERS.1 — the safety-net timer. Every set/ command accepts
// `toggle_after` (seconds): after the delay the DEVICE flips itself to the
// opposite of `on`, with no cloud and no cron involved. That is the whole
// point: if this CRM dies with a room switched on, the plug still switches
// itself off.
//
// Two refusals, both answered before any request is spent (`kind:
// 'invalid_timer'`, statusCode 0 like every other caller-bug tag):
//  • anything but a positive finite number of seconds (>= 1). A silently
//    dropped timer is a safety net that is quietly absent, so it is refused
//    rather than omitted. A fraction is rounded UP — never shorter than asked.
//  • a timer on an OFF command. It would flip the relay back ON after the
//    delay: an "off" that turns a room on later, which is never what a
//    caller means.
// Absent (undefined or null) means "no timer" and the body is byte-for-byte
// what it was before this existed.
const invalidTimer = () => ({ ok: false, kind: 'invalid_timer', statusCode: 0 })
function timerOf(opts, on) {
  const t = opts && typeof opts === 'object' ? opts.toggleAfterSec : undefined
  if (t === undefined || t === null) return { ok: true, field: {} }
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 1 || !on) return { ok: false }
  return { ok: true, field: { toggle_after: Math.ceil(t) } }
}

// What an interactive press (the device toggle, the group switch) passes as
// `max429Retries` (see below). One constant so the two switches cannot drift.
export const INTERACTIVE_429_RETRIES = 3

// `max429Retries` (SHELLYBUSY.1): how many times one call re-sends after a
// 429, each wait one RETRY_429_AFTER_MS longer than the last. The default of 1
// is the cron's: it owns a whole tick's budget and must not stall it. A staff
// press passes more, because its one request most often collides with the
// cron's read of the same account and a single 1.1 s retry can land on the
// cron's next call — the press then reads "Shelly is busy" for a request that
// would have gone through a second later.
export function createShellyClient(conn, { fetchImpl = fetch, sleep = realSleep, now = Date.now, minGapMs = MIN_GAP_MS, max429Retries = 1 } = {}) {
  // Re-validated HERE, not just at the column CHECK. The CHECK only protects
  // rows that were persisted; probeConnection tests an operator-PASTED
  // connection that has not been saved yet, so a pasted
  // `evil.example/collect?x=` would otherwise be handed the v1 form body —
  // key included. A bad host makes every method a config failure that never
  // reaches fetch.
  const normalised = normaliseShellyHost(conn?.host)
  const host = normalised.ok ? normalised.host : null
  const key = String(conn?.auth_key || '')
  let lastCallAt = -Infinity

  // NOTE ON `statusCode: 0` — it is OVERLOADED. It means "no HTTP exchange
  // happened", and that covers network, config, too_many_ids, invalid_ids,
  // invalid_timer and the empty-list short-circuit. Callers MUST branch on `kind`; a
  // branch on statusCode alone reads a caller bug as a dropped line.
  const configFailure = () => ({ ok: false, kind: 'config', statusCode: 0 })

  async function once(path, body, { v1 = false } = {}) {
    const url = v1
      ? `https://${host}${path}`
      : `https://${host}${path}?auth_key=${encodeURIComponent(key)}`
    const init = v1
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
          body: new URLSearchParams({ auth_key: key, ...body }).toString() }
      : { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify(body ?? {}) }
    let res
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' })
    } catch {
      return { ok: false, kind: 'network', statusCode: 0, body: null }
    } finally {
      lastCallAt = now()
    }
    // Response handling gets its OWN try. A fetch that resolves undefined, or
    // a response without .text() (a stub, a polyfill, a proxy), would
    // otherwise throw past the never-throw boundary — and because callers may
    // not await every call, that surfaces as an unhandled rejection, which is
    // process-fatal on Node >= 15.
    // statusCode is hoisted and always a number, so the catch below reads a
    // plain local and cannot itself throw. Reading `res.status` inside the
    // catch would re-throw for a response whose status getter throws — a
    // recovery path that fails louder than the thing it was recovering from.
    let statusCode = 0
    try {
      const s = res.status
      statusCode = typeof s === 'number' ? s : 0
      // No .catch() on text(): a body read that genuinely FAILS is not the
      // same as an empty body, and swallowing it to '' would report a dead
      // stream as a successful bare-200. Empty bodies still arrive as ''.
      const text = await res.text()
      let parsed = null
      if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }   // bare-200 bodies are fine
      const kind = v1 ? classifyV1(statusCode, parsed) : classifyV2(statusCode, parsed)
      if (kind === 'ok') return { ok: true, statusCode, body: parsed }
      return { ok: false, kind, statusCode, body: parsed }
    } catch {
      return { ok: false, kind: 'http', statusCode, body: null }
    }
  }

  // Every request goes through this queue, so the gap holds even when a
  // caller fires several without awaiting (a Promise.all over devices).
  // Without it the gap check is a read-then-write across an await:
  // concurrent callers all read the same stale lastCallAt, all skip the
  // sleep, and all breach the 1 req/sec budget this client exists to
  // enforce — silently, since each one still returns ok. `then(fn, fn)`
  // runs the next job whether the previous settled or threw, so one
  // failure can never wedge the queue.
  let tail = Promise.resolve()
  const enqueue = (fn) => {
    const p = tail.then(fn, fn)
    tail = p.catch(() => {})
    return p
  }

  function call(path, body, opts) {
    if (!host) return Promise.resolve(configFailure())
    return enqueue(async () => {
      const wait = minGapMs - (now() - lastCallAt)
      if (wait > 0) await sleep(wait)
      let res = await once(path, body, opts)
      for (let attempt = 1; attempt <= max429Retries && !res.ok && res.kind === 'rate_limited'; attempt++) {
        // Never shorter than the configured gap: an injected minGapMs above
        // the default is a deliberately slower budget, and a fixed 1100 ms
        // retry would quietly undercut it.
        await sleep(Math.max(RETRY_429_AFTER_MS, minGapMs) * attempt)
        res = { ...(await once(path, body, opts)), retried: true }
      }
      return res
    })
  }

  return {
    // Shelly caps `get` at MAX_GET_IDS ids. Batching is the CALLER's job and
    // an over-long list is refused, not sliced: a silent slice answers "ok"
    // for a subset and drops the rest without a word, which is the exact
    // shape of the truncation bugs the guardrails lint exists to catch.
    // `select` defaults to status only — the cron reconciles switch state and
    // never reads settings. Discovery and adopt pass ['status','settings']
    // explicitly, because they need the device name.
    get: async (ids, { select = ['status'] } = {}) => {
      if (!host) return configFailure()
      // A missing list means "nothing to ask about". Any OTHER non-array is a
      // caller bug — a bare id string or an options object arriving here would
      // otherwise be silently read as an empty request that answers ok.
      if (ids !== undefined && ids !== null && !Array.isArray(ids)) {
        return { ok: false, kind: 'invalid_ids', statusCode: 0 }
      }
      const list = Array.isArray(ids) ? ids : []
      if (list.length > MAX_GET_IDS) {
        return { ok: false, kind: 'too_many_ids', statusCode: 0, count: list.length }
      }
      // Nothing to ask about — don't spend a slot in the 1 req/sec budget.
      if (list.length === 0) return { ok: true, statusCode: 0, body: [] }
      const res = await call('/v2/devices/api/get', { ids: list, select })
      // Mirror setSwitch/setGroups: a 2xx carrying a top-level `error` is a
      // FAILED read. Left as ok it arrives at the reconcile as an empty item
      // list, which is the shape of "the account answered and mentioned
      // nobody" — every device at the location written offline and the
      // connection stamped connected on the strength of the same reply.
      // Tagged 'http' rather than 'device' on purpose: the read path's
      // black-hole stop and the "Shelly unreachable (kind)" copy both key off
      // the kinds `get` can yield, and 'device' belongs to the set/ endpoints.
      // SHELLYERR.1: a non-2xx error body stays 'http' for the same reason,
      // and carries its code like the 2xx one does.
      const code = res.ok || res.kind === 'http' ? errorCodeOf(res.body) : null
      if (code !== null) {
        return withRetried({ ok: false, kind: 'http', code, statusCode: res.statusCode }, res)
      }
      return res
    },
    // `opts.toggleAfterSec` (optional): the safety-net timer — see timerOf.
    setSwitch: async (deviceId, channel, on, opts) => {
      const timer = timerOf(opts, !!on)
      if (!timer.ok) return invalidTimer()
      const res = await call('/v2/devices/api/set/switch', { id: deviceId, channel: Number(channel) || 0, on: !!on, ...timer.field })
      return commandFailure(res) ?? res
    },
    // `on` ONLY — never brightness/mode/colour: a light keeps its own level.
    setLight: async (deviceId, channel, on, opts) => {
      const timer = timerOf(opts, !!on)
      if (!timer.ok) return invalidTimer()
      const res = await call('/v2/devices/api/set/light', { id: deviceId, channel: Number(channel) || 0, on: !!on, ...timer.field })
      return commandFailure(res) ?? res
    },
    // `groups` is a bare string[] (switch ids, the original shape) or
    // { switch?: string[], light?: string[] }. Empty kinds are dropped; if
    // none remain no request is spent. One timer per call: it rides inside
    // every kind's command, so callers batch by timer (reconcile.js).
    setGroups: async (groups, on, opts) => {
      const timer = timerOf(opts, !!on)
      if (!timer.ok) return invalidTimer()
      const kinds = Array.isArray(groups) ? { switch: groups } : groups || {}
      const body = {}
      for (const kind of ['switch', 'light']) {
        const ids = kinds[kind]
        if (Array.isArray(ids) && ids.length > 0) body[kind] = { ids, command: { on: !!on, ...timer.field } }
      }
      if (Object.keys(body).length === 0) return { ok: true, statusCode: 0, failed: {} }
      const res = await call('/v2/devices/api/set/groups', body)
      // Mirror setSwitch: a body carrying a top-level error fails the WHOLE
      // batch — the docs return group-level validation and server errors as an
      // HTTP error, not in failedCommands. Reporting it as { ok: true, failed:
      // {} } would read as "every command landed" for a call where none did.
      const failure = commandFailure(res)
      if (failure) return failure
      if (!res.ok) return res
      const parsed = parseGroupsResult(res.body)
      // An unreadable failedCommands is a failed batch, not an empty one — the
      // caller must retry rather than stamp. 'http' keeps it inside the kinds
      // the reconcile already treats as "the call did not land".
      if (parsed.failed === null) {
        return withRetried({ ok: false, kind: 'http', code: 'FAILED_COMMANDS_UNPARSEABLE', statusCode: res.statusCode }, res)
      }
      return withRetried({ ok: true, statusCode: res.statusCode, ...parsed }, res)
    },
    allStatus: () => call('/device/all_status', { show_info: 'true', no_shared: 'true' }, { v1: true }),
    // SHELLY-NAMES.3 — the ACCOUNT layer's device list. Undocumented but LIVE:
    // it is the endpoint Shelly's own web UI reads its device list from, and it
    // is the ONLY place the Smart Control app's labels exist.
    //
    // WHY IT IS HERE AT ALL. The v2 `get` payload proved LABEL-FREE at the
    // Stillorgan live gate: on six app-named Gen3 Minis
    // `settings.sys.device.name` was present-but-null and the cloud-grafted
    // `settings.DeviceInfo.name` was null too (SHELLY-NAMES.2/3). The app names
    // the account RECORD rather than the device, and the official v2 Cloud
    // Control API never returns that record — so no widening of the v2 resolver
    // could ever have found the label.
    //
    // Form-encoded auth like allStatus (that is the v1 API, not a choice), ONE
    // call per request from every caller, and paced by the same queue as
    // everything else — an undocumented endpoint gets no special treatment on
    // the shared 1 req/sec budget. Its RESPONSE SHAPE is unverified, so the
    // consumer probes it (normaliseDeviceListNames) and logs a keys-only shape
    // diagnostic when no name resolves, exactly as the v2 side does.
    deviceList: () => call('/interface/device/list', {}, { v1: true }),
  }
}
