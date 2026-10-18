// GET-only client for the un1t.online REST API (Hatch Street's gym platform).
// UN1TSYNC.2.
//
//   • GET only. There is deliberately no write helper in this module; a test
//     pins that no mutating verb appears in the source.
//   • Auth is a static per-studio bearer token. No sign-in, no refresh, so a
//     401/403 is final for the run (Un1tAuthError, never retried).
//   • Rate limit is 60 requests / 60 s, reported on every response in
//     x-ratelimit-limit / -remaining / -reset (seconds until the window
//     resets). The client waits out the window when remaining hits 0, and a
//     429 or 5xx backs off to the reset (or Retry-After, or 1s * 2^attempt)
//     for up to MAX_RETRIES retries.
//   • Lists are `{ success, pagination: { total, page, pages, pageSize }, data }`.
//     pageSize tops out at 100; `limit` and `updated_since` are ignored by the
//     API, so every listAll is a full pull.
//   • The token is never logged and never put in an error.

import { logWarn } from './log'

export const DEFAULT_BASE_URL = 'https://api.un1t.online'
const PAGE_SIZE = 100
const MAX_RETRIES = 3
// The longest single rate-limit / Retry-After wait the client will sit through.
// A server demanding more is a failed request, not a hung cron invocation.
export const MAX_WAIT_MS = 90_000

export class Un1tAuthError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'Un1tAuthError'
    this.status = status
  }
}

export class Un1tApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message)
    this.name = 'Un1tApiError'
    this.status = status
    this.code = code
  }
}

export function headerNumber(headers, name) {
  const raw = headers?.get?.(name)
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** ms to wait for a rate-limit window to reset, or null if the response did not say. */
export function resetWaitMs(headers) {
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  return reset == null ? null : (Math.max(0, reset) + 1) * 1000
}

export function createUn1tClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPages = 50,
  // Runs immediately before every HTTP request (retries included). A throw
  // stops that request and surfaces to the caller; no fetch is made.
  beforeRequest = async () => {},
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '')
  const counters = { requests: 0, waitedMs: 0, retries: 0 }
  // Set when a successful response says the window is spent; the next request
  // sleeps it off first.
  let pendingWaitMs = 0

  async function wait(ms, status = 429) {
    if (!(ms > 0)) return
    if (ms > MAX_WAIT_MS) {
      throw new Un1tApiError(
        `un1t.online asked the client to wait ${Math.ceil(ms / 1000)}s, longer than the ${MAX_WAIT_MS / 1000}s limit`,
        { status, code: 'wait_too_long' },
      )
    }
    counters.waitedMs += ms
    await sleep(ms)
  }

  // One logical GET: waits out a spent window, retries 429/5xx/network faults,
  // returns the parsed body of a 2xx with success !== false.
  async function get(path) {
    const url = `${root}${path}`
    for (let attempt = 0; ; attempt++) {
      if (pendingWaitMs > 0) {
        const ms = pendingWaitMs
        pendingWaitMs = 0
        await wait(ms, 429)
      }

      await beforeRequest()
      counters.requests += 1
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        })
      } catch (err) {
        // A network fault is retried like a 5xx. Only the error's name and
        // message are surfaced, never the request, so the token cannot leak.
        if (attempt < MAX_RETRIES) {
          counters.retries += 1
          logWarn('un1t-online', 'request failed; retrying', { path, attempt: attempt + 1, errName: err?.name })
          await wait(1000 * 2 ** attempt)
          continue
        }
        throw new Un1tApiError(`un1t.online request failed: ${err?.message || 'network error'}`, { status: 0 })
      }

      const status = response.status
      if (status === 401 || status === 403) {
        throw new Un1tAuthError(`un1t.online refused the token (HTTP ${status})`, status)
      }

      if (status === 429 || status >= 500) {
        if (attempt < MAX_RETRIES) {
          counters.retries += 1
          const retryAfter = headerNumber(response.headers, 'retry-after')
          const ms = retryAfter != null
            ? Math.max(0, retryAfter) * 1000
            : (resetWaitMs(response.headers) ?? 1000 * 2 ** attempt)
          logWarn('un1t-online', 'retrying after rate limit or server error', { path, status, attempt: attempt + 1, waitMs: ms })
          await wait(ms, status)
          continue
        }
        throw new Un1tApiError(`un1t.online answered HTTP ${status} after ${MAX_RETRIES} retries`, { status })
      }

      let body
      try {
        body = await response.json()
      } catch {
        throw new Un1tApiError(`un1t.online sent an unreadable body (HTTP ${status})`, { status })
      }

      if (status < 200 || status >= 300) {
        const detail = body?.error
        throw new Un1tApiError(
          `un1t.online answered HTTP ${status}${detail?.message ? `: ${detail.message}` : ''}`,
          { status, code: detail?.code ?? detail?.status ?? body?.code ?? null },
        )
      }
      if (body?.success === false) {
        const detail = body.error
        throw new Un1tApiError(
          `un1t.online reported failure${detail?.message ? `: ${detail.message}` : ''}`,
          { status: detail?.status ?? status, code: detail?.code ?? detail?.status ?? body.code ?? null },
        )
      }

      if (headerNumber(response.headers, 'x-ratelimit-remaining') === 0) {
        pendingWaitMs = resetWaitMs(response.headers) ?? 0
      }
      return body
    }
  }

  async function getSelf() {
    const body = await get('/api-token')
    return body.data
  }

  // One GET of a single resource; returns body.data. Never pages.
  async function getOne(path) {
    const body = await get(path)
    return body.data
  }

  async function listAll(path) {
    const sep = path.includes('?') ? '&' : '?'
    const rows = []
    const seen = new Set()
    let total = 0
    let pages = 1
    let truncated = false

    for (let p = 1; p <= pages; p++) {
      if (p > maxPages) {
        truncated = true
        break
      }
      const body = await get(`${path}${sep}page=${p}&pageSize=${PAGE_SIZE}`)
      const pagination = body.pagination || {}
      pages = Number(pagination.pages) || 1
      total = Number(pagination.total) || 0
      for (const row of body.data || []) {
        // An insert between page fetches shifts the window and repeats a row.
        if (row && row.id != null) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
        }
        rows.push(row)
      }
    }
    return { rows, total, truncated }
  }

  function stats() {
    return { ...counters }
  }

  return { getSelf, listAll, getOne, stats }
}
