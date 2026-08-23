// SHELLY.3 — Shelly Cloud Control API client. Never throws; every result is
// tagged. The auth key rides in the QUERY STRING (that is Shelly's API), so
// nothing in this file ever logs a URL, and no result carries one.
//
// Rate limit is 1 request/second PER ACCOUNT. Pacing and the single 429
// retry live in one place here so the cron and the staff routes cannot
// disagree. Same-account studios share one budget — the reconcile
// serialises them (see reconcile.js); this client only paces itself.
//
// Results pass `body` through verbatim, so callers must never log a result
// body — put errors through redactSecret first. Shelly does not echo the key
// today, but the key is in the query string and the rule costs nothing.

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

// Operator-supplied and server-fetched: an SSRF surface. Hostname only,
// lowercased, and it must be an account server. Accepts a pasted URL.
export function normaliseShellyHost(input) {
  let s = String(input ?? '').trim().toLowerCase()
  const wanted = 'Enter your account server from the Shelly app, e.g. shelly-<region>.shelly.cloud'
  if (!s) return { ok: false, error: wanted }
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s
  let host
  try { host = new URL(s).hostname } catch { return { ok: false, error: wanted } }
  if (!HOST_RE.test(host)) return { ok: false, error: wanted }
  return { ok: true, host }
}

export function fingerprintAuthKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex')
}

export function keyHint(key) {
  const s = String(key || '')
  return s.length >= 4 ? s.slice(-4) : ''
}

export function redactSecret(err, secret) {
  const name = err?.name || 'Error'
  let message = String(err?.message ?? err ?? '')
  if (secret) message = message.split(secret).join('[redacted]')
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

export function parseGroupsResult(body) {
  const fc = body && typeof body === 'object' && body.failedCommands && typeof body.failedCommands === 'object'
    ? body.failedCommands : {}
  return { failed: { ...fc } }
}

export function createShellyClient(conn, { fetchImpl = fetch, sleep = realSleep, now = Date.now, minGapMs = MIN_GAP_MS } = {}) {
  const host = String(conn?.host || '')
  const key = String(conn?.auth_key || '')
  let lastCallAt = -Infinity

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
    const text = await res.text().catch(() => '')
    let parsed = null
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }   // bare-200 bodies are fine
    const kind = v1 ? classifyV1(res.status, parsed) : classifyV2(res.status, parsed)
    if (kind === 'ok') return { ok: true, statusCode: res.status, body: parsed }
    return { ok: false, kind, statusCode: res.status, body: parsed }
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
    return enqueue(async () => {
      const wait = minGapMs - (now() - lastCallAt)
      if (wait > 0) await sleep(wait)
      let res = await once(path, body, opts)
      if (!res.ok && res.kind === 'rate_limited') {
        await sleep(RETRY_429_AFTER_MS)
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
    get: async (ids, { select = ['status', 'settings'] } = {}) => {
      const list = Array.isArray(ids) ? ids : []
      if (list.length > MAX_GET_IDS) {
        return { ok: false, kind: 'too_many_ids', statusCode: 0, count: list.length }
      }
      // Nothing to ask about — don't spend a slot in the 1 req/sec budget.
      if (list.length === 0) return { ok: true, statusCode: 0, body: [] }
      return call('/v2/devices/api/get', { ids: list, select })
    },
    setSwitch: async (deviceId, channel, on) => {
      const res = await call('/v2/devices/api/set/switch', { id: deviceId, channel: Number(channel) || 0, on: !!on })
      if (res.ok && res.body && typeof res.body.error === 'string') {
        return { ok: false, kind: 'device', code: res.body.error, statusCode: res.statusCode }
      }
      return res
    },
    setGroups: async (groupIds, on) => {
      const res = await call('/v2/devices/api/set/groups', { switch: { ids: groupIds, command: { on: !!on } } })
      if (!res.ok) return res
      // Mirror setSwitch: a 2xx carrying a top-level error is a device
      // failure. Reporting it as { ok: true, failed: {} } would read as
      // "every command landed" for a call where none of them did.
      if (res.body && typeof res.body.error === 'string') {
        return { ok: false, kind: 'device', code: res.body.error, statusCode: res.statusCode }
      }
      return { ok: true, statusCode: res.statusCode, ...parseGroupsResult(res.body) }
    },
    allStatus: () => call('/device/all_status', { show_info: 'true', no_shared: 'true' }, { v1: true }),
  }
}
